const { EventDAO } = require('../daos/eventDao');
const { CalendarDAO } = require('../daos/calendarDAO');
const { SectionDAO } = require('../daos/sectionDAO');
const { ReminderDAO } = require('../daos/reminderDAO');
const { cascadeDeleteInstanceChildren, REMINDER_TARGET_TYPE } = require('../daos/deleteCascadeHelpers');
const { adjustRuleCount } = require('../utils/recurrenceRule');
const { assertOccurrencesMatchRule } = require('../utils/recurrenceExpansion');
const { BinderDAO } = require('../daos');
const eventBus = require('../events/eventBus');
const withTransaction = require('../core/withTransaction');
const { BadRequestError, NotFoundError, ForbiddenError, ConflictError } = require('../core/errors');
const { requireBinderMemberByCalendarId, requireBinderMember } = require('../core/authz');
const { TargetType, ActionType } = require('../utils/typeDefinitions');
const pool = require('../../config/db');

// reminders.target_type: 0=event_instance 1=task_instance 2=special_day (schema.md §10-4)
const EVENT_INSTANCE_TARGET_TYPE = 0;

// domain.md §3-13 · system.md §4-7 — 회차 상한. 서버가 강제한다(재생성 경로에서도 예외 없음).
const MAX_OCCURRENCES = 365;

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

    // RLY-20260806-037 — system.md §4-7: 클라가 제출한 회차 집합을 r_rule로 독립 전개해 대조한다.
    // DB 접근이 필요 없어 트랜잭션 밖(가장 먼저)에서 검사한다 — 실패하면 쓰기 자체가 없다.
    // DTSTART는 제출된 인스턴스 중 가장 이른 original_date다 — 생성 시점엔 그것이 곧 계열의
    // 진짜 시작점이다(기존 계열이 없다).
    if (data.instances && data.instances.length > 0) {
      const earliest = data.instances.reduce((min, inst) => {
        const t = new Date(inst.original_date).getTime();
        return t < min ? t : min;
      }, Infinity);
      assertOccurrencesMatchRule({
        rRule: data.r_rule,
        isAllDay: !!data.instances[0].is_all_day,
        recurrenceTimezone: data.recurrence_timezone,
        dtstartInstant: new Date(earliest),
        submittedInstances: data.instances,
      });
    }

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

  // scope 유무로 "메타데이터만 편집"과 "범위 재생성(fork)"이 갈린다(api.md §8 "body.scope 유무로
  // 갈린다", 8-A "scope 필드는 생략 가능하며, 없으면 회차를 건드리지 않는 메타데이터 편집").
  // scope가 있으면 applyRecurrenceScope로 위임한다 — split(POST .../split)과 같은 함수를 탄다.
  async updateEvent(event_id, updateData, context) {
    if (updateData.scope) {
      return this.applyRecurrenceScope(event_id, updateData, context);
    }

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

  // ============================================================================================
  // 범위 편집(fork) — RLY-20260806-034, 결정 64(domain.md §3-14) · api.md §8-A · system.md §4-3.
  // ============================================================================================
  // PATCH scope=this_and_future/all_upcoming와 POST .../split(호환 alias, EventService.splitEvent가
  // 여기로 위임)이 이 함수 하나로 수렴한다 — "두 벌" 금지(팀리드 지시).
  //
  // 처리 순서는 system.md §4-3을 그대로 따른다: ①원본 행 잠금+인가 ②stale_revision 검사
  // ③대상(경계) 소속 검증 ④과거 제외 재평가 ⑤적용(삭제→생성) ⑥응답(skipped_past_count 포함).
  // 전부 한 트랜잭션 — LWW가 아니라 "회차 구조를 바꾸는 조작"의 예외 경로다.
  //
  // @param {object} opts
  // @param {'this_and_future'|'all_upcoming'} opts.scope
  // @param {string} [opts.boundary_instance_id] - split alias 전용. 이 인스턴스의 original_date가
  //   경계다(선택 회차 포함, "이후"). PATCH this_and_future는 대신 instances[0]을 경계로 쓴다
  //   (api.md 8-A "첫 항목이 선택 회차").
  // @param {Array} [opts.instances] - 재생성할 회차 전량(클라 계산, 상한 365). this_and_future/
  //   all_upcoming 공통.
  // @param {string} [opts.new_event_id] - this_and_future 전용, 클라 UUIDv7(H19 — 서버가 안 만듦).
  // @param {string} [opts.expected_updated_at] - 낙관적 동시성(stale_revision).
  // @param {...*} patch - summary·description·color·r_rule·locations·recurrence_timezone·
  //   reminder_offsets 등 편집값. this_and_future면 새 owner 행에, all_upcoming이면 기존 owner
  //   행에 적용된다.
  async applyRecurrenceScope(eventId, opts, context) {
    const {
      scope, boundary_instance_id: boundaryInstanceId, instances,
      new_event_id: newEventId, expected_updated_at: expectedUpdatedAt,
      ...patch
    } = opts;

    if (scope !== 'this_and_future' && scope !== 'all_upcoming') {
      throw new BadRequestError('지원하지 않는 scope입니다', 'unsupported_scope');
    }

    const { result, binder_id } = await withTransaction(async (client) => {
      // ① 원본 행 잠금 + 인가
      const origin = await EventDAO.findByIdForUpdate(client, eventId);
      if (!origin) throw new NotFoundError('이벤트를 찾을 수 없습니다');
      const { calendar, member } = await requireBinderMemberByCalendarId(client, origin.calendar_id, context.sender_id);
      assertCanEditItem(origin.author_id, context.sender_id, member);

      // ② stale_revision — 낡은 화면에서 제출한 요청이 잠금·소속 검증을 통과하면서 사용자가
      // 의도한 것보다 좁은 범위에 조용히 적용되는 것을 막는 유일한 검사(system.md §4-3 step3).
      if (expectedUpdatedAt) {
        const expectedMs = new Date(expectedUpdatedAt).getTime();
        const actualMs = new Date(origin.updated_at).getTime();
        if (Number.isNaN(expectedMs) || expectedMs !== actualMs) {
          throw new ConflictError('편집 대상이 이미 변경되었습니다', 'stale_revision');
        }
      }

      // ③ 대상(경계) 소속 검증
      let boundaryDate;
      if (scope === 'this_and_future') {
        if (boundaryInstanceId) {
          // split alias 경로 — URL의 instanceId가 경계다.
          const boundaryInstance = await EventDAO.findInstanceById(client, boundaryInstanceId);
          if (!boundaryInstance || boundaryInstance.event_id !== eventId) {
            throw new ConflictError('선택한 회차가 이 이벤트에 속하지 않습니다', 'instance_not_in_event');
          }
          boundaryDate = new Date(boundaryInstance.original_date);
        } else if (Array.isArray(instances) && instances.length > 0) {
          // PATCH scope=this_and_future 경로 — "첫 항목이 선택 회차"(api.md 8-A).
          boundaryDate = new Date(instances[0].original_date);
        } else {
          throw new BadRequestError('경계 회차를 판정할 수 없습니다(instance_id 또는 instances[0] 필요)');
        }
        if (!newEventId) throw new BadRequestError('new_event_id가 필요합니다');
      } else {
        // all_upcoming — 경계는 항상 "지금"(선택 회차 개념이 없다).
        boundaryDate = new Date();
      }

      // ④ 과거 제외 재평가 — 처리 시각 기준으로 이미 시작한 회차는 대상에서 뺀다. stale_revision
      // 검사(②)보다 반드시 뒤에 둔다(system.md §4-3 step5 순서 그대로) — 앞에 두면 남이 이미
      // 손댄 요청이 과거 제외만 통과해 부분 적용된다.
      const now = new Date();
      const effectiveBoundary = boundaryDate > now ? boundaryDate : now;

      const submitted = Array.isArray(instances) ? instances : [];
      const toCreate = submitted.filter((inst) => new Date(inst.original_date) >= effectiveBoundary);
      const skippedPastCount = submitted.length - toCreate.length;

      if (toCreate.length > MAX_OCCURRENCES) {
        throw new BadRequestError(`회차는 최대 ${MAX_OCCURRENCES}개까지 생성할 수 있습니다`, 'occurrence_limit_exceeded');
      }

      // ④-1 RLY-20260806-037 — 재생성될 회차 집합을 이번에 적용될 r_rule로 독립 전개해 대조한다.
      // r_rule·recurrence_timezone은 patch에 있으면 그 값, 없으면 origin값(패치 병합과 동일 규칙,
      // ⑥의 forkEvent 생성 로직과 값 출처를 맞춘다).
      // DTSTART(계열의 진짜 시작점, recurrenceExpansion.js 헤더 참조):
      //   this_and_future — boundaryDate(fork가 새로 시작하는 지점, 이미 서버가 검증한 값).
      //   all_upcoming — 같은 owner 행을 유지하므로 boundaryDate(=지금)를 쓰면 위상이 틀어진다.
      //     삭제 전에 조회한 "그 이벤트의 살아있는 첫 회차"가 진짜 시작점이다(원본이든 fork
      //     조각이든 동일하게 성립 — findEarliestActiveInstance 주석 참조).
      if (toCreate.length > 0) {
        const effectiveRRule = patch.r_rule !== undefined ? patch.r_rule : origin.r_rule;
        const effectiveRecurrenceTimezone = Object.prototype.hasOwnProperty.call(patch, 'recurrence_timezone')
          ? patch.recurrence_timezone : origin.recurrence_timezone;

        let dtstartInstant;
        if (scope === 'this_and_future') {
          dtstartInstant = boundaryDate;
        } else {
          const earliest = await EventDAO.findEarliestActiveInstance(client, eventId);
          dtstartInstant = earliest ? new Date(earliest.original_date) : new Date(toCreate[0].original_date);
        }

        assertOccurrencesMatchRule({
          rRule: effectiveRRule,
          isAllDay: !!toCreate[0].is_all_day,
          recurrenceTimezone: effectiveRecurrenceTimezone,
          dtstartInstant,
          submittedInstances: toCreate,
        });
      }

      // ⑤ 적용 — 삭제(경계 이후 기존 회차, 참가자·리마인더 cascade) 후 재생성.
      const deletedInstanceIds = await EventDAO.deleteInstancesFromBoundary(client, eventId, effectiveBoundary);
      await cascadeDeleteInstanceChildren(client, {
        participantTable: 'event_participants',
        reminderTargetType: REMINDER_TARGET_TYPE.EVENT_INSTANCE,
        instanceIds: deletedInstanceIds,
      });

      if (deletedInstanceIds.length === 0 && toCreate.length === 0) {
        throw new ConflictError('영향받는 회차가 없습니다(이미 다른 분리가 가져갔거나 전부 과거 회차입니다)', 'no_occurrences_moved');
      }

      let targetEventId = eventId;
      let forkEvent = null;

      if (scope === 'this_and_future') {
        // 새 owner(fork) 행 — 패치값이 있으면 그 값, 없으면 원본값을 그대로 물려받는다
        // (COALESCE(patch, origin)과 동치). event_type·calendar_id·author_id는 패치 대상이
        // 아니라 항상 원본에서 상속한다.
        forkEvent = await EventDAO.createForkEvent(client, {
          id: newEventId,
          calendar_id: origin.calendar_id,
          author_id: origin.author_id,
          event_type: origin.event_type,
          forked_from: eventId,
          summary: patch.summary !== undefined && patch.summary !== null ? patch.summary : origin.summary,
          description: patch.description !== undefined ? patch.description : origin.description,
          color: patch.color !== undefined && patch.color !== null ? patch.color : origin.color,
          r_rule: patch.r_rule !== undefined ? patch.r_rule : origin.r_rule,
          locations: patch.locations !== undefined ? patch.locations : origin.locations,
          recurrence_timezone: Object.prototype.hasOwnProperty.call(patch, 'recurrence_timezone')
            ? patch.recurrence_timezone : origin.recurrence_timezone,
          // RLY-20260806-041 — summary/r_rule과 같은 patch⊕origin 병합이지만, `??`(nullish
          // coalescing)를 쓴다는 점이 다르다. reminder_offsets는 SC-reminder §7-1(RLY-20260806-031)
          // 계약상 "부재/null 둘 다 무변동"이라 recurrence_timezone(명시적 null=지우기)과 계약이
          // 다르다 — `patch.reminder_offsets !== undefined` 식(r_rule 패턴)을 그대로 베끼면
          // 클라가 이 필드를 명시적으로 null로 보냈을 때(=무변동 의도) fork의 알림이 사라진다.
          // 새로 만드는 행이라 "무변동"은 곧 "origin 상속"과 동치다 — `??`가 부재·명시적 null
          // 양쪽을 전부 origin으로 폴백시켜 그 계약을 그대로 지킨다.
          reminder_offsets: patch.reminder_offsets ?? origin.reminder_offsets,
        });
        targetEventId = forkEvent.id;

        // "구간은 서로소다"(domain.md §3-13) — 원본에 남은(경계 이전) 회차 수로 원본 r_rule을
        // 조정한다(COUNT 치환 또는 UNTIL 재계산 — RLY-20260806-061, utils/recurrenceRule.js).
        // UNTIL 조정엔 원본의 진짜 시작점이 필요하다 — deleteInstancesFromBoundary가 이미 위에서
        // 미래 회차를 지웠으므로, 지금 남아있는(경계 이전) 것 중 가장 이른 회차가 곧 원본
        // 계열이 애초에 시작한 지점이다(fork 이후에도 원본 자신의 시작점은 바뀌지 않는다).
        const remainingCount = await EventDAO.countActiveInstances(client, eventId);
        let expansionContext;
        if (remainingCount > 0) {
          const originEarliest = await EventDAO.findEarliestActiveInstance(client, eventId);
          if (originEarliest) {
            expansionContext = {
              isAllDay: !!originEarliest.is_all_day,
              recurrenceTimezone: origin.recurrence_timezone,
              dtstartInstant: new Date(originEarliest.original_date),
            };
          }
        }
        const adjustedRRule = adjustRuleCount(origin.r_rule, remainingCount, expansionContext);
        if (adjustedRRule !== origin.r_rule) {
          await EventDAO.updateEvent(client, eventId, { r_rule: adjustedRRule });
        }
      } else {
        // all_upcoming — 새 owner 행 없음. 같은 이벤트의 메타데이터를 그대로 갱신한다
        // (기존 EventDAO.updateEvent 재사용 — COALESCE partial update).
        await EventDAO.updateEvent(client, eventId, patch);
      }

      // 재생성 회차 — 참가자는 절대 승계하지 않는다(명단 초기화, 결정 64).
      const createdInstances = await EventDAO.insertInstancesBulk(client, targetEventId, toCreate);

      for (const inst of createdInstances) {
        await ReminderDAO.syncTarget(client, {
          targetType: EVENT_INSTANCE_TARGET_TYPE,
          targetId: inst.id,
          baseTime: inst.start_date,
          offsets: patch.reminder_offsets,
          timezone: null,
        });
      }

      return {
        binder_id: calendar.binder_id,
        result: {
          event_id: targetEventId,
          original_event_id: eventId,
          new_event_id: scope === 'this_and_future' ? targetEventId : null,
          created_instance_count: createdInstances.length,
          deleted_instance_count: deletedInstanceIds.length,
          skipped_past_count: skippedPastCount,
        },
      };
    });

    eventBus.emit('sync', {
      binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: scope === 'this_and_future' ? ActionType.CREATE : ActionType.UPDATE,
      target_type: TargetType.EVENT,
      target_id: result.event_id,
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

  // 【결정 64】 POST .../split은 활성 액션이 아니라 구 클라이언트·동결 큐 호환용 alias다
  // (api.md §8, ~~POST~~ 행). 처리는 scope=this_and_future와 완전히 같은 함수로 수렴한다 —
  // "patch 부재 여부와 무관하게 삭제·재생성이고 명단은 초기화된다"(api.md 8-A) — 순수 분리
  // 옵션은 없다.
  async splitEvent(splitData, context) {
    const { event_id, instance_id, ...rest } = splitData;
    if (!event_id || !instance_id) {
      throw new BadRequestError('eventId와 instanceId가 필요합니다');
    }
    return this.applyRecurrenceScope(event_id, {
      ...rest,
      scope: 'this_and_future',
      boundary_instance_id: instance_id,
    }, context);
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
      // RLY-20260806-031 — event_participants에 inviter_id가 없어(2026-07-20 결정) DAO
      // 시그니처에서 뺐다. "누가 초대했는지"는 audit_logs/activity_feeds의 actor_id가 이미
      // 담당한다(이 함수 하단 eventBus emit의 sender_id).
      const result = await EventDAO.addParticipant(client, instance_id, user_id);
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

  // RLY-20260806-114 — 강퇴는 item_edit_role(editor, 이벤트 필드 수정·삭제 기준)이 아니라
  // 별도의 더 엄격한 축이다. SC-event.md가 3곳에서(§1-Background:69·§8-1:565·§7 API맵:449)
  // 일관되게 "apply 승인/거부·rejected 복원·강퇴는 승인 권한자(author 또는 role≤1=master·
  // manager)만"이라고 명시하고, api.md:958도 동일("master·manager 또는 본인 탈퇴") — 편집
  // 권한 정정(2026-08-06, §11 표 597-603행)과 달리 강퇴 쪽엔 상충·정정 이력이 없다. Task의
  // "editor 이상"(SC-task.md:141)과는 의도적으로 다른 축이다 — 동형 문서라 착각하기 쉬운
  // 지점(107·111이 이미 지적).
  async removeParticipant(event_id, instance_id, target_user_id, context) {
    const { binder_id } = await withTransaction(async (client) => {
      const instance = await EventDAO.findInstanceContext(client, event_id, instance_id);
      if (!instance) throw new NotFoundError('이벤트 인스턴스를 찾을 수 없습니다');
      const actor = await BinderDAO.getMember(client, instance.binder_id, context.sender_id);
      if (!actor || actor.deleted_at) throw new ForbiddenError('바인더 멤버만 제거할 수 있습니다');
      if (target_user_id !== context.sender_id) {
        const isAuthor = instance.author_id === context.sender_id;
        if (!isAuthor && actor.role > 1) {
          throw new ForbiddenError('작성자 또는 관리자(master·manager)만 참여자를 제거할 수 있습니다');
        }
      }
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
