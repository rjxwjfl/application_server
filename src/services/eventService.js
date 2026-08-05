const { EventDAO } = require('../daos/eventDAO');
const { CalendarDAO } = require('../daos/calendarDAO');
const { SectionDAO } = require('../daos/sectionDAO');
const { ReminderDAO } = require('../daos/reminderDAO');
const { BinderDAO } = require('../daos');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const withTransaction = require('../core/withTransaction');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../core/errors');
const { TargetType, ActionType } = require('../utils/typeDefinitions');
const pool = require('../../config/db');

class EventService {
  async getEvent(eventId) {
    const event = await EventDAO.findById(pool, eventId);
    if (!event) throw new NotFoundError('이벤트를 찾을 수 없습니다');
    return event;
  }

  async createEvent(data, context) {
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

      if (data.reminders && data.reminders.length > 0) {
        for (const reminder of data.reminders) {
          await ReminderDAO.create(client, {
            ...reminder,
            user_id: context.sender_id,
          });
        }
      }

      return created;
    });

    eventBus.emit('sync', {
      binder_id: data.binder_id,
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
        binder_id: data.binder_id,
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
    const { event, result } = await withTransaction(async (client) => {
      const event = await EventDAO.findById(client, event_id);
      if (!event) throw new NotFoundError('이벤트를 찾을 수 없습니다');
      const result = await EventDAO.updateEvent(client, event_id, updateData);
      return { event, result };
    });

    eventBus.emit('sync', {
      binder_id: event.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.UPDATE,
      target_type: TargetType.EVENT,
      target_id: event_id,
    });

    return result;
  }

  async updateEventInstance(instance_id, updateData, context) {
    const { instance, result } = await withTransaction(async (client) => {
      const instance = await EventDAO.findInstanceById(client, instance_id);
      if (!instance) throw new NotFoundError('이벤트 인스턴스를 찾을 수 없습니다');
      const result = await EventDAO.updateEventInstance(client, instance_id, updateData);
      return { instance, result };
    });

    eventBus.emit('sync', {
      binder_id: instance.binder_id,
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

    const result = await withTransaction(async (client) => {
      return await EventDAO.splitEvent(client, event_id, instance_id, new_event_id);
    });

    eventBus.emit('sync', {
      binder_id: splitData.binder_id,
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
      await EventDAO.softDeleteEvent(client, event_id);
      return { binder_id: event.binder_id };
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

  async deleteEventInstance(instance_id, context) {
    const { binder_id } = await withTransaction(async (client) => {
      const instance = await EventDAO.findInstanceById(client, instance_id);
      if (!instance) throw new NotFoundError('이벤트 인스턴스를 찾을 수 없습니다');
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

  async addParticipant(instance_id, participantData, context) {
    const { user_id } = participantData;
    if (!user_id) throw new BadRequestError('userId가 필요합니다');

    const result = await withTransaction(async (client) => {
      return await EventDAO.addParticipant(client, instance_id, user_id, context.sender_id);
    });

    if (participantData.binder_id) {
      eventBus.emit('sync', {
        binder_id: participantData.binder_id,
        sender_id: context.sender_id,
        device_uuid: context.device_uuid,
        action: ActionType.CREATE,
        target_type: TargetType.EVENT_PARTICIPANT,
        target_id: instance_id,
      });

      eventBus.emit('alert', {
        binder_id: participantData.binder_id,
        sender_id: context.sender_id,
        type: 'assignment',
        title: participantData.binder_name || '',
        body: participantData.alert_body || '이벤트에 참가자로 배정되었습니다.',
        target_user_ids: [user_id],
        requiredLevel: 1,
        routeData: { route_type: 2, route_id: instance_id },
        device_uuid: context.device_uuid,
      });
    }

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

  async removeParticipant(instance_id, target_user_id, context) {
    await withTransaction(async (client) => {
      await EventDAO.removeParticipant(client, instance_id, target_user_id);
    });

    eventBus.emit('sync', {
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
