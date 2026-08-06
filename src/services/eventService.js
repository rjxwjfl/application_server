const { EventDAO } = require('../daos/eventDao');
const { CalendarDAO } = require('../daos/calendarDAO');
const { SectionDAO } = require('../daos/sectionDAO');
const { ReminderDAO } = require('../daos/reminderDAO');
const { REMINDER_TARGET_TYPE } = require('../daos/deleteCascadeHelpers');
const { BinderDAO } = require('../daos');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const withTransaction = require('../core/withTransaction');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../core/errors');
const { requireBinderMemberByCalendarId, requireBinderMember } = require('../core/authz');
const { TargetType, ActionType } = require('../utils/typeDefinitions');
const pool = require('../../config/db');

// 캘린더 항목(Event) 편집·삭제 권한 (domain.md §(12) [확정]): 작성자는 항상 가능,
// 그 외는 Binder 편집자(editor, role<=2) 이상. binder_settings.item_edit_role(기본값=2)로
// 바인더별 조정 가능하다고 확정돼 있으나 그 컬럼이 아직 스키마에 없어(config/schema.sql) 여기서는
// 확정된 기본값 2를 그대로 쓴다 — 마이그레이션은 별도 배정 필요.
const ITEM_EDIT_ROLE_DEFAULT = 2;

function assertCanEditItem(authorId, userId, member) {
  if (authorId === userId) return;
  if (member.role > ITEM_EDIT_ROLE_DEFAULT) {
    throw new ForbiddenError('작성자 또는 편집자 이상만 수정·삭제할 수 있습니다');
  }
}

class EventService {
  async getEvent(eventId, userId) {
    const event = await EventDAO.findById(pool, eventId);
    if (!event) throw new NotFoundError('이벤트를 찾을 수 없습니다');
    await requireBinderMemberByCalendarId(pool, event.calendar_id, userId);
    return event;
  }

  async createEvent(data, context) {
    // 바인더 멤버십 검증 — data.calendar_id는 events.calendar_id로 그대로 쓰이는 클라이언트 payload다.
    // 반환된 calendar.binder_id를 emit에 재사용한다(A-NEW-13) — data.binder_id는 클라 payload라 신뢰할 수 없다.
    const { calendar: authzCalendar } = await requireBinderMemberByCalendarId(pool, data.calendar_id, context.sender_id);

    const event = await withTransaction(async (client) => {
      if (data.calendar) {
        const existing = await CalendarDAO.findById(client, data.calendar.id);
        if (!existing) {
          await CalendarDAO.create(client, data.calendar);
        }
      }

      if (data.section) {
        const existing = await SectionDAO.findById(client, data.section.id);
        if (!existing) {
          await SectionDAO.create(client, data.section);
        }
      }

      const created = await EventDAO.createEvent(client, data);

      if (data.section_id) {
        await EventDAO.addSection(client, data.id, data.section_id);
      }

      // RLY-20260806-026 — 구 nested `data.reminders[]` 루프 제거(ReminderDAO.create가 실제
      // 스키마에 없는 user_id·base_time 컬럼으로 INSERT해 항상 SQL 에러 — 리마인더를 하나라도
      // 붙이면 이벤트 생성 자체가 롤백됐다). [확정](2026-08-03, SC-reminder §7-1) 계약대로
      // `reminder_offsets`(초 배열)를 owner row(events.reminder_offsets)에 저장하고, **그 저장된
      // 값(created.reminder_offsets)** 에서 회차마다 발송 원장을 파생한다 — 오프셋의 출처는
      // 이 컬럼 하나다(요청 payload를 직접 재사용하지 않는다).
      if (data.instances && data.instances.length > 0) {
        for (const instance of data.instances) {
          await ReminderDAO.syncTarget(client, {
            targetType: REMINDER_TARGET_TYPE.EVENT_INSTANCE,
            targetId: instance.id,
            baseTime: instance.start_date,
            offsets: created.reminder_offsets,
            // Event·Task는 timezone NULL(ck_rem_tz 허용) — 수신자가 여럿이라 항목 기준 시간대가
            // 성립하지 않는다(§2-B). SpecialDay만 소유자 단일 수신자라 예외적으로 값을 채운다.
            timezone: null,
          });
        }
      }

      return created;
    });

    eventBus.emit('sync', {
      binder_id: authzCalendar.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.CREATE,
      target_type: TargetType.EVENT,
      target_id: event.id,
    });

    const participants = new Set();
    if (data.instances && Array.isArray(data.instances)) {
      data.instances.forEach(inst => {
        if (inst.participants && Array.isArray(inst.participants)) {
          inst.participants.forEach(p => {
            if (p.user_id && p.user_id !== context.sender_id) {
              participants.add(p.user_id);
            }
          });
        }
      });
    }

    if (participants.size > 0) {
      eventBus.emit('alert', {
        binder_id: authzCalendar.binder_id,
        sender_id: context.sender_id,
        type: 'assignment',
        title: data.binder_name || '새로운 일정',
        body: `'${data.summary}' 일정에 배정되었습니다.`,
        target_user_ids: Array.from(participants),
        requiredLevel: 1,
        routeData: { route_type: 2, route_id: event.id },
        device_uuid: context.device_uuid,
      });
    }

    return event;
  }

  async updateEvent(event_id, updateData, context) {
    const { result, binder_id } = await withTransaction(async (client) => {
      const event = await EventDAO.findById(client, event_id);
      if (!event) throw new NotFoundError('이벤트를 찾을 수 없습니다');
      const { calendar, member } = await requireBinderMemberByCalendarId(client, event.calendar_id, context.sender_id);
      assertCanEditItem(event.author_id, context.sender_id, member);
      const result = await EventDAO.updateEvent(client, event_id, updateData);

      // RLY-20260806-026 — reminder_offsets가 이번 요청에 명시됐으면(부재/null이 아니면, §7-1)
      // 이 항목의 회차 전부를 저장된(=방금 갱신된) 값 기준으로 재파생한다. 다른 필드만 바뀐
      // 흔한 PATCH(summary 등)에서는 이 블록이 아예 안 돈다 — 매 updateEvent 호출마다 회차
      // 전부를 도는 비용을 피한다.
      if (Object.prototype.hasOwnProperty.call(updateData, 'reminder_offsets') && updateData.reminder_offsets != null) {
        const instances = await EventDAO.findInstancesByEventId(client, event_id);
        for (const instance of instances) {
          await ReminderDAO.syncTarget(client, {
            targetType: REMINDER_TARGET_TYPE.EVENT_INSTANCE,
            targetId: instance.id,
            baseTime: instance.start_date,
            offsets: result.reminder_offsets,
            timezone: null,
          });
        }
      }

      return { result, binder_id: calendar.binder_id };
    });

    eventBus.emit('sync', {
      binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.UPDATE,
      target_type: TargetType.EVENT,
      target_id: event_id,
    });

    return result;
  }

  async updateEventInstance(event_id, instance_id, updateData, context) {
    const { result, binder_id } = await withTransaction(async (client) => {
      const instance = await EventDAO.findInstanceContext(client, event_id, instance_id);
      if (!instance) throw new NotFoundError('이벤트 인스턴스를 찾을 수 없습니다');
      const member = await requireBinderMember(client, instance.binder_id, context.sender_id);
      assertCanEditItem(instance.author_id, context.sender_id, member);
      const result = await EventDAO.updateEventInstance(client, instance_id, updateData);

      // RLY-20260806-026 — 회차 시각이 바뀌었으면 이 회차에 이미 붙어 있는 리마인더의 trigger_at을
      // 다시 파생한다. 오프셋은 findInstanceContext가 함께 실어 온 부모 이벤트의
      // events.reminder_offsets(instance.reminder_offsets)에서만 가져온다 — 역산 없음, 컬럼이
      // 유일한 출처다. start_date가 이번 요청에서 안 바뀌었어도 result.start_date는 COALESCE로
      // 보존된 현재값이라 같은 값으로 재대입돼 부작용이 없다.
      await ReminderDAO.syncTarget(client, {
        targetType: REMINDER_TARGET_TYPE.EVENT_INSTANCE,
        targetId: instance_id,
        baseTime: result.start_date,
        offsets: instance.reminder_offsets,
        timezone: null,
      });

      return { result, binder_id: instance.binder_id };
    });

    eventBus.emit('sync', {
      binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.UPDATE,
      target_type: TargetType.EVENT_INSTANCE,
      target_id: instance_id,
    });

    return result;
  }

  async splitEvent(splitData, context) {
    const { event_id, instance_id } = splitData;
    if (!event_id || !instance_id) {
      throw new BadRequestError('eventId와 instanceId가 필요합니다');
    }

    const new_event_id = generateUUID();

    const { result, binder_id } = await withTransaction(async (client) => {
      const event = await EventDAO.findById(client, event_id);
      if (!event) throw new NotFoundError('이벤트를 찾을 수 없습니다');
      const { calendar, member } = await requireBinderMemberByCalendarId(client, event.calendar_id, context.sender_id);
      assertCanEditItem(event.author_id, context.sender_id, member);

      const instance = await EventDAO.findInstanceContext(client, event_id, instance_id);
      if (!instance) throw new NotFoundError('이벤트 인스턴스를 찾을 수 없습니다');

      const result = await EventDAO.splitEvent(client, event_id, instance_id, new_event_id);
      return { result, binder_id: calendar.binder_id };
    });

    eventBus.emit('sync', {
      binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.CREATE,
      target_type: TargetType.EVENT,
      target_id: new_event_id,
    });

    return result;
  }

  async deleteEvent(event_id, context) {
    const { binder_id } = await withTransaction(async (client) => {
      const event = await EventDAO.findById(client, event_id);
      if (!event) throw new NotFoundError('이벤트를 찾을 수 없습니다');
      const { calendar, member } = await requireBinderMemberByCalendarId(client, event.calendar_id, context.sender_id);
      assertCanEditItem(event.author_id, context.sender_id, member);
      await EventDAO.softDeleteEvent(client, event_id);
      return { binder_id: calendar.binder_id };
    });

    eventBus.emit('sync', {
      binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE,
      target_type: TargetType.EVENT,
      target_id: event_id,
    });
  }

  async deleteEventInstance(event_id, instance_id, context) {
    const { binder_id } = await withTransaction(async (client) => {
      const instance = await EventDAO.findInstanceContext(client, event_id, instance_id);
      if (!instance) throw new NotFoundError('이벤트 인스턴스를 찾을 수 없습니다');
      const member = await requireBinderMember(client, instance.binder_id, context.sender_id);
      assertCanEditItem(instance.author_id, context.sender_id, member);
      await EventDAO.softDeleteEventInstance(client, instance_id);
      return { binder_id: instance.binder_id };
    });

    eventBus.emit('sync', {
      binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE,
      target_type: TargetType.EVENT_INSTANCE,
      target_id: instance_id,
    });
  }

  async addParticipant(event_id, instance_id, participantData, context) {
    const { user_id } = participantData;
    if (!user_id) throw new BadRequestError('userId가 필요합니다');

    const { result, binder_id } = await withTransaction(async (client) => {
      const instance = await EventDAO.findInstanceContext(client, event_id, instance_id);
      if (!instance) throw new NotFoundError('이벤트 인스턴스를 찾을 수 없습니다');
      const actor = await BinderDAO.getMember(client, instance.binder_id, context.sender_id);
      if (!actor || actor.deleted_at) throw new ForbiddenError('바인더 멤버만 참여할 수 있습니다');
      if (user_id !== context.sender_id && actor.role > 2)
        throw new ForbiddenError('편집자 이상만 타인을 추가할 수 있습니다');
      const target = await BinderDAO.getMember(client, instance.binder_id, user_id);
      if (!target || target.deleted_at) throw new BadRequestError('바인더 멤버만 추가할 수 있습니다');
      const result = await EventDAO.addParticipant(client, instance_id, user_id, context.sender_id);
      return { result, binder_id: instance.binder_id };
    });

    eventBus.emit('sync', {
      binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.CREATE,
      target_type: TargetType.EVENT_PARTICIPANT,
      target_id: instance_id,
    });

    eventBus.emit('alert', {
      binder_id,
      sender_id: context.sender_id,
      type: 'assignment',
      title: participantData.binder_name || '',
      body: participantData.alert_body || '이벤트에 참가자로 배정되었습니다.',
      target_user_ids: [user_id],
      requiredLevel: 1,
      routeData: { route_type: 2, route_id: instance_id },
      device_uuid: context.device_uuid,
    });

    return result;
  }

  // 참가자 상태 전이 — 본인 RSVP + 승인 권한자(author 또는 role<=1)의 apply 승인/거부·
  // rejected 복원을 단일 엔드포인트로 처리 (api.md PATCH .../participants/:userId, SC-event §8-1,
  // domain.md §3-8 — 2026-07-26 Gate). 구 rejectApply/restoreRejected는 여기로 흡수 후 삭제.
  async updateParticipantState(instance_id, user_id, updateData, context) {
    const { state } = updateData;
    if (state === undefined) throw new BadRequestError('state가 필요합니다');
    if (state === 0) throw new ForbiddenError('confirm 상태는 어떤 주체도 변경할 수 없습니다');

    const isSelf = user_id === context.sender_id;

    // §3-8 전이표: 본인 경로와 승인 권한자 경로의 허용 전이가 다르다.
    const SELF_TRANSITIONS = {
      1: [3, 4, 5], // invite -> accept/tentative/decline
      3: [4, 5],    // accept -> tentative/decline
      4: [3, 5],    // tentative -> accept/decline
      5: [2],       // decline -> apply (재신청)
    };
    const APPROVER_TRANSITIONS = {
      2: [3, 6], // apply -> accept(승인)/rejected(거부)
      6: [3, 4], // rejected -> accept/tentative (복원)
    };

    const { binder_id } = await withTransaction(async (client) => {
      const instance = await EventDAO.findInstanceById(client, instance_id);
      if (!instance) throw new NotFoundError('이벤트 인스턴스를 찾을 수 없습니다');
      const event = await EventDAO.findById(client, instance.event_id);
      if (!event) throw new NotFoundError('이벤트를 찾을 수 없습니다');
      const calendar = await CalendarDAO.findById(client, event.calendar_id);
      if (!calendar) throw new NotFoundError('캘린더를 찾을 수 없습니다');

      const participant = await EventDAO.findParticipant(client, instance_id, user_id);
      if (!participant) throw new NotFoundError('참가자 정보를 찾을 수 없습니다');
      if (participant.state === 0) throw new ForbiddenError('confirm 상태는 어떤 주체도 변경할 수 없습니다');

      if (isSelf) {
        if (!SELF_TRANSITIONS[participant.state]?.includes(state)) {
          throw new ForbiddenError('허용되지 않은 상태 전이입니다');
        }
      } else {
        if (!APPROVER_TRANSITIONS[participant.state]?.includes(state)) {
          throw new ForbiddenError('허용되지 않은 상태 전이입니다');
        }
        const isAuthor = event.author_id === context.sender_id;
        let isApprover = isAuthor;
        if (!isApprover) {
          const member = await BinderDAO.getMember(client, calendar.binder_id, context.sender_id);
          isApprover = !!member && !member.deleted_at && member.role <= 1;
        }
        if (!isApprover) {
          throw new ForbiddenError('신청 승인·거부·복원은 이벤트 작성자 또는 관리자(master·manager)만 가능합니다');
        }
      }

      await EventDAO.updateParticipantState(client, instance_id, user_id, state);
      return { binder_id: calendar.binder_id };
    });

    eventBus.emit('sync', {
      binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: state === 6 ? ActionType.REJECT : ActionType.RSVP_UPDATE,
      target_type: TargetType.EVENT_PARTICIPANT,
      target_id: instance_id,
      metadata: state === 6
        ? { target_user_id: user_id, new_state: 6 }
        : { new_state: state },
    });
  }

  async removeParticipant(event_id, instance_id, target_user_id, context) {
    const { binder_id } = await withTransaction(async (client) => {
      const instance = await EventDAO.findInstanceContext(client, event_id, instance_id);
      if (!instance) throw new NotFoundError('이벤트 인스턴스를 찾을 수 없습니다');
      const actor = await BinderDAO.getMember(client, instance.binder_id, context.sender_id);
      if (!actor || actor.deleted_at) throw new ForbiddenError('바인더 멤버만 제거할 수 있습니다');
      if (target_user_id !== context.sender_id && actor.role > 2)
        throw new ForbiddenError('편집자 이상만 타인을 제거할 수 있습니다');
      await EventDAO.removeParticipant(client, instance_id, target_user_id);
      return { binder_id: instance.binder_id };
    });

    eventBus.emit('sync', {
      binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE,
      target_type: TargetType.EVENT_PARTICIPANT,
      target_id: instance_id,
    });
  }
}

module.exports = {
  EventService: new EventService(),
};
