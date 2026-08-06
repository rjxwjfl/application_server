const { TaskDAO } = require('../daos/taskDAO');
const { BinderDAO } = require('../daos/binderDAO');
const { ReminderDAO } = require('../daos/reminderDAO');
const { cascadeDeleteInstanceChildren, REMINDER_TARGET_TYPE } = require('../daos/deleteCascadeHelpers');
const { adjustRuleCount } = require('../utils/recurrenceRule');
const { assertOccurrencesMatchRule } = require('../utils/recurrenceExpansion');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const withTransaction = require('../core/withTransaction');
const { BadRequestError, NotFoundError, ForbiddenError, ConflictError } = require('../core/errors');
const { requireBinderMemberByCalendarId, requireBinderMember } = require('../core/authz');
const { TargetType, ActionType } = require('../utils/typeDefinitions');
const pool = require('../../config/db');

// reminders.target_type: 0=event_instance 1=task_instance 2=special_day (schema.md §10-4)
const TASK_INSTANCE_TARGET_TYPE = 1;

// domain.md §3-13 · system.md §4-7 — 회차 상한. 서버가 강제한다.
const MAX_OCCURRENCES = 365;

// 캘린더 항목(Task) 편집·삭제 권한 (domain.md §(12) [확정], api.md DELETE /tasks/:taskId와 동일 축):
// 작성자는 항상 가능, 그 외는 Binder 편집자(editor, role<=2) 이상. Event 쪽 assertCanEditItem과
// 동일 상수·구조 — 이 저장소에서 Event/Task 구조 불일치가 반복돼 여기서도 값을 고정한다.
const ITEM_EDIT_ROLE_DEFAULT = 2;

function assertCanEditItem(authorId, userId, member) {
  if (authorId === userId) return;
  if (member.role > ITEM_EDIT_ROLE_DEFAULT) {
    throw new ForbiddenError('작성자 또는 편집자 이상만 수정·삭제할 수 있습니다');
  }
}

class TaskService {
  async getTask(taskId, userId) {
    const task = await TaskDAO.findById(pool, taskId);
    if (!task) throw new NotFoundError('할 일을 찾을 수 없습니다');
    await requireBinderMemberByCalendarId(pool, task.calendar_id, userId);
    return task;
  }

  async createTask(taskData, context) {
    // 반환된 calendar.binder_id를 emit에 재사용한다(A-NEW-13) — taskData.binder_id는 클라 payload라 신뢰할 수 없다.
    const { calendar: authzCalendar } = await requireBinderMemberByCalendarId(pool, taskData.calendar_id, context.sender_id);

    // RLY-20260806-037 — eventService.createEvent와 동일 사유·동일 계약(system.md §4-7).
    if (taskData.instances && taskData.instances.length > 0) {
      const earliest = taskData.instances.reduce((min, inst) => {
        const t = new Date(inst.original_date).getTime();
        return t < min ? t : min;
      }, Infinity);
      assertOccurrencesMatchRule({
        rRule: taskData.r_rule,
        isAllDay: !!taskData.instances[0].is_all_day,
        recurrenceTimezone: taskData.recurrence_timezone,
        dtstartInstant: new Date(earliest),
        submittedInstances: taskData.instances,
      });
    }

    const taskId = taskData.id || generateUUID();

    const task = await withTransaction(async (client) => {
      const created = await TaskDAO.createTask(client, {
        ...taskData,
        id: taskId,
        author_id: context.sender_id,
      });

      // RLY-20260806-026 — Task 축은 ReminderDAO를 아예 호출하지 않아 리마인더가 조용히
      // 버려지고 있었다(회귀 없이 그냥 무시). SC-reminder §7-1 계약대로 `reminder_offsets`
      // (초 배열)을 owner row(tasks.reminder_offsets)에 저장하고, 그 저장된 값
      // (created.reminder_offsets)에서 회차(due 기준)마다 발송 원장을 파생한다.
      if (taskData.instances && taskData.instances.length > 0) {
        for (const instance of taskData.instances) {
          await ReminderDAO.syncTarget(client, {
            targetType: REMINDER_TARGET_TYPE.TASK_INSTANCE,
            targetId: instance.id,
            baseTime: instance.due_date,
            offsets: created.reminder_offsets,
            timezone: null, // Event와 동일 — 수신자가 여럿이라 항목 기준 시간대 불가(§2-B)
          });
        }
      }

      return created;
    });

    eventBus.emit('sync', {
      binder_id: authzCalendar.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.CREATE, target_type: TargetType.TASK, target_id: task.id,
    });

    return task;
  }

  // scope 유무로 갈린다 — EventService.updateEvent와 동일 계약(api.md §8, 8-A).
  async updateTask(taskId, updateData, context) {
    if (updateData.scope) {
      return this.applyRecurrenceScope(taskId, updateData, context);
    }

    const { result, binder_id } = await withTransaction(async (client) => {
      const task = await TaskDAO.findById(client, taskId);
      if (!task) throw new NotFoundError('할 일을 찾을 수 없습니다');
      const { calendar, member } = await requireBinderMemberByCalendarId(client, task.calendar_id, context.sender_id);
      assertCanEditItem(task.author_id, context.sender_id, member);
      const result = await TaskDAO.updateTask(client, taskId, updateData);

      // RLY-20260806-026 — eventService.updateEvent와 동일 패턴: reminder_offsets가 명시된
      // 요청에서만 회차 전부를 재파생한다.
      if (Object.prototype.hasOwnProperty.call(updateData, 'reminder_offsets') && updateData.reminder_offsets != null) {
        const instances = await TaskDAO.findInstancesByTaskId(client, taskId);
        for (const instance of instances) {
          await ReminderDAO.syncTarget(client, {
            targetType: REMINDER_TARGET_TYPE.TASK_INSTANCE,
            targetId: instance.id,
            baseTime: instance.due_date,
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
      action: ActionType.UPDATE, target_type: TargetType.TASK, target_id: taskId,
    });

    return result;
  }

  // ============================================================================================
  // 범위 편집(fork) — RLY-20260806-034. EventService.applyRecurrenceScope와 대칭 구현(대칭 이유는
  // eventService.js 주석 참조 — Event/Task는 스키마가 달라 완전한 함수 공유는 하지 않되, 각
  // 도메인 내부에서는 split·PATCH scope가 반드시 이 함수 하나로 수렴한다).
  // ============================================================================================
  async applyRecurrenceScope(taskId, opts, context) {
    const {
      scope, boundary_instance_id: boundaryInstanceId, instances,
      new_task_id: newTaskId, expected_updated_at: expectedUpdatedAt,
      ...patch
    } = opts;

    if (scope !== 'this_and_future' && scope !== 'all_upcoming') {
      throw new BadRequestError('지원하지 않는 scope입니다', 'unsupported_scope');
    }

    const { result, binder_id } = await withTransaction(async (client) => {
      const origin = await TaskDAO.findByIdForUpdate(client, taskId);
      if (!origin) throw new NotFoundError('할 일을 찾을 수 없습니다');
      const { calendar, member } = await requireBinderMemberByCalendarId(client, origin.calendar_id, context.sender_id);
      assertCanEditItem(origin.author_id, context.sender_id, member);

      if (expectedUpdatedAt) {
        const expectedMs = new Date(expectedUpdatedAt).getTime();
        const actualMs = new Date(origin.updated_at).getTime();
        if (Number.isNaN(expectedMs) || expectedMs !== actualMs) {
          throw new ConflictError('편집 대상이 이미 변경되었습니다', 'stale_revision');
        }
      }

      let boundaryDate;
      if (scope === 'this_and_future') {
        if (boundaryInstanceId) {
          const boundaryInstance = await TaskDAO.findInstanceById(client, boundaryInstanceId);
          if (!boundaryInstance || boundaryInstance.task_id !== taskId) {
            throw new ConflictError('선택한 회차가 이 할 일에 속하지 않습니다', 'instance_not_in_event');
          }
          boundaryDate = new Date(boundaryInstance.original_date);
        } else if (Array.isArray(instances) && instances.length > 0) {
          boundaryDate = new Date(instances[0].original_date);
        } else {
          throw new BadRequestError('경계 회차를 판정할 수 없습니다(instance_id 또는 instances[0] 필요)');
        }
        if (!newTaskId) throw new BadRequestError('new_task_id가 필요합니다');
      } else {
        boundaryDate = new Date();
      }

      const now = new Date();
      const effectiveBoundary = boundaryDate > now ? boundaryDate : now;

      const submitted = Array.isArray(instances) ? instances : [];
      const toCreate = submitted.filter((inst) => new Date(inst.original_date) >= effectiveBoundary);
      const skippedPastCount = submitted.length - toCreate.length;

      if (toCreate.length > MAX_OCCURRENCES) {
        throw new BadRequestError(`회차는 최대 ${MAX_OCCURRENCES}개까지 생성할 수 있습니다`, 'occurrence_limit_exceeded');
      }

      // RLY-20260806-037 — eventService.applyRecurrenceScope와 동일 사유·동일 DTSTART 규칙
      // (recurrenceExpansion.js 헤더·eventDao.findEarliestActiveInstance 주석 참조).
      if (toCreate.length > 0) {
        const effectiveRRule = patch.r_rule !== undefined ? patch.r_rule : origin.r_rule;
        const effectiveRecurrenceTimezone = Object.prototype.hasOwnProperty.call(patch, 'recurrence_timezone')
          ? patch.recurrence_timezone : origin.recurrence_timezone;

        let dtstartInstant;
        if (scope === 'this_and_future') {
          dtstartInstant = boundaryDate;
        } else {
          const earliest = await TaskDAO.findEarliestActiveInstance(client, taskId);
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

      const deletedInstanceIds = await TaskDAO.deleteInstancesFromBoundary(client, taskId, effectiveBoundary);
      await cascadeDeleteInstanceChildren(client, {
        participantTable: 'task_participants',
        reminderTargetType: REMINDER_TARGET_TYPE.TASK_INSTANCE,
        instanceIds: deletedInstanceIds,
      });

      if (deletedInstanceIds.length === 0 && toCreate.length === 0) {
        throw new ConflictError('영향받는 회차가 없습니다(이미 다른 분리가 가져갔거나 전부 과거 회차입니다)', 'no_occurrences_moved');
      }

      let targetTaskId = taskId;
      let forkTask = null;

      if (scope === 'this_and_future') {
        forkTask = await TaskDAO.createForkTask(client, {
          id: newTaskId,
          calendar_id: origin.calendar_id,
          author_id: origin.author_id,
          task_type: origin.task_type,
          forked_from: taskId,
          summary: patch.summary !== undefined && patch.summary !== null ? patch.summary : origin.summary,
          description: patch.description !== undefined ? patch.description : origin.description,
          priority: patch.priority !== undefined && patch.priority !== null ? patch.priority : origin.priority,
          r_rule: patch.r_rule !== undefined ? patch.r_rule : origin.r_rule,
          locations: patch.locations !== undefined ? patch.locations : origin.locations,
          recurrence_timezone: Object.prototype.hasOwnProperty.call(patch, 'recurrence_timezone')
            ? patch.recurrence_timezone : origin.recurrence_timezone,
          // 알림 오프셋은 owner 행에 안 남는다(findByIdForUpdate 주석 참조) — 아래 리마인더
          // 파생은 patch.reminder_offsets를 직접 읽는다(origin 폴백 없음, createTask와 동일 한계).
        });
        targetTaskId = forkTask.id;

        const remainingCount = await TaskDAO.countActiveInstances(client, taskId);
        const adjustedRRule = adjustRuleCount(origin.r_rule, remainingCount);
        if (adjustedRRule !== origin.r_rule) {
          await TaskDAO.updateTask(client, taskId, { r_rule: adjustedRRule });
        }
      } else {
        await TaskDAO.updateTask(client, taskId, patch);
      }

      const createdInstances = await TaskDAO.insertInstancesBulk(client, targetTaskId, toCreate);

      // domain.md §3-13 Task 표 — "회차 생성마다 reevaluateInstanceCompletion 호출 필수". 명단이
      // 비어 있어(결정 64) 실질적으로 completed_at=NULL 유지지만, 계약을 그대로 지킨다.
      for (const inst of createdInstances) {
        await ReminderDAO.syncTarget(client, {
          targetType: TASK_INSTANCE_TARGET_TYPE,
          targetId: inst.id,
          baseTime: inst.due_date,
          offsets: patch.reminder_offsets,
          timezone: null,
        });
        await TaskDAO.reevaluateInstanceCompletion(client, inst.id);
      }

      return {
        binder_id: calendar.binder_id,
        result: {
          task_id: targetTaskId,
          original_task_id: taskId,
          new_task_id: scope === 'this_and_future' ? targetTaskId : null,
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
      target_type: TargetType.TASK,
      target_id: result.task_id,
    });

    return result;
  }

  async updateTaskInstance(taskId, instanceId, updateData, context) {
    const { result, binder_id } = await withTransaction(async (client) => {
      const instance = await TaskDAO.findInstanceContext(client, taskId, instanceId);
      if (!instance) throw new NotFoundError('할 일 인스턴스를 찾을 수 없습니다');
      const member = await requireBinderMember(client, instance.binder_id, context.sender_id);
      assertCanEditItem(instance.author_id, context.sender_id, member);
      const result = await TaskDAO.updateTaskInstance(client, instanceId, updateData);

      // RLY-20260806-026 — due_date가 바뀌었으면 이미 붙어 있는 리마인더의 trigger_at을 다시
      // 파생한다(eventService.updateEventInstance와 동일 패턴). 오프셋은 findInstanceContext가
      // 함께 실어 온 부모 태스크의 tasks.reminder_offsets(instance.reminder_offsets)에서만
      // 가져온다 — 역산 없음.
      await ReminderDAO.syncTarget(client, {
        targetType: REMINDER_TARGET_TYPE.TASK_INSTANCE,
        targetId: instanceId,
        baseTime: result.due_date,
        offsets: instance.reminder_offsets,
        timezone: null,
      });

      return { result, binder_id: instance.binder_id };
    });

    eventBus.emit('sync', {
      binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.UPDATE, target_type: TargetType.TASK_INSTANCE, target_id: instanceId,
    });

    return result;
  }

  // 【결정 64】 POST .../split은 호환용 alias — 처리는 scope=this_and_future와 같은 함수로
  // 수렴한다(EventService.splitEvent와 동일 계약).
  async splitTask(splitData, context) {
    // controller가 { task_id, instance_id, ...req.body }로 넘긴다(taskController.splitTask).
    const { task_id: taskId, instance_id: instanceId, ...rest } = splitData;
    if (!taskId || !instanceId) {
      throw new BadRequestError('taskId와 instanceId가 필요합니다');
    }
    return this.applyRecurrenceScope(taskId, {
      ...rest,
      scope: 'this_and_future',
      boundary_instance_id: instanceId,
    }, context);
  }

  async deleteTask(taskId, context) {
    const { binder_id } = await withTransaction(async (client) => {
      const task = await TaskDAO.findById(client, taskId);
      if (!task) throw new NotFoundError('할 일을 찾을 수 없습니다');
      const { calendar, member } = await requireBinderMemberByCalendarId(client, task.calendar_id, context.sender_id);
      assertCanEditItem(task.author_id, context.sender_id, member);
      await TaskDAO.softDeleteTask(client, taskId);
      return { binder_id: calendar.binder_id };
    });

    eventBus.emit('sync', {
      binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE, target_type: TargetType.TASK, target_id: taskId,
    });
  }

  async deleteTaskInstance(taskId, instanceId, context) {
    const { binder_id } = await withTransaction(async (client) => {
      const instance = await TaskDAO.findInstanceContext(client, taskId, instanceId);
      if (!instance) throw new NotFoundError('할 일 인스턴스를 찾을 수 없습니다');
      const member = await requireBinderMember(client, instance.binder_id, context.sender_id);
      assertCanEditItem(instance.author_id, context.sender_id, member);
      await TaskDAO.softDeleteTaskInstance(client, instanceId);
      return { binder_id: instance.binder_id };
    });

    eventBus.emit('sync', {
      binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE, target_type: TargetType.TASK_INSTANCE, target_id: instanceId,
    });
  }

  async addParticipant(taskId, instanceId, data, context) {
    if (!data.user_id) throw new BadRequestError('user_id가 필요합니다');
    const result = await withTransaction(async (client) => {
      const instance = await TaskDAO.findInstanceContext(client, taskId, instanceId);
      if (!instance) throw new NotFoundError('할 일 인스턴스를 찾을 수 없습니다');
      const actor = await BinderDAO.getMember(client, instance.binder_id, context.sender_id);
      if (!actor || actor.deleted_at) throw new ForbiddenError('바인더 멤버만 참여할 수 있습니다');
      if (data.user_id !== context.sender_id && actor.role > 2)
        throw new ForbiddenError('편집자 이상만 타인을 추가할 수 있습니다');
      const target = await BinderDAO.getMember(client, instance.binder_id, data.user_id);
      if (!target || target.deleted_at) throw new BadRequestError('바인더 멤버만 추가할 수 있습니다');
      // RLY-20260806-031 — eventService.addParticipant와 동일 사유(inviter_id 컬럼 없음).
      const participant = await TaskDAO.addParticipant(client, instanceId, data.user_id);
      await TaskDAO.reevaluateInstanceCompletion(client, instanceId);
      return { participant, binder_id: instance.binder_id };
    });
    this.emitParticipantSync(
      result.binder_id, instanceId, context, ActionType.ASSIGN,
      { target_user_id: data.user_id }
    );
    return result.participant;
  }

  async updateParticipantState(taskId, instanceId, userId, data, context) {
    if (!Number.isInteger(data.state) || data.state < 0 || data.state > 3)
      throw new BadRequestError('state는 0부터 3 사이의 정수여야 합니다');
    if (data.state === 2 && (typeof data.memo !== 'string' || !data.memo.trim()))
      throw new BadRequestError('onHold 상태에는 memo가 필요합니다');

    const transitions = { 0: [1, 2], 1: [2, 3], 2: [1], 3: [1] };
    const result = await withTransaction(async (client) => {
      const instance = await TaskDAO.findInstanceContext(client, taskId, instanceId);
      if (!instance) throw new NotFoundError('할 일 인스턴스를 찾을 수 없습니다');
      if (userId !== context.sender_id)
        throw new ForbiddenError('본인 상태만 변경할 수 있습니다');
      const participant = await TaskDAO.findParticipant(client, instanceId, userId);
      if (!participant || participant.deleted_at)
        throw new NotFoundError('활성 참여자를 찾을 수 없습니다', 'TASK_PARTICIPANT_NOT_FOUND');
      if (!transitions[participant.state]?.includes(data.state))
        throw new BadRequestError('허용되지 않은 상태 전이입니다');
      const updated = await TaskDAO.updateParticipantState(
        client, instanceId, userId, data.state, data.state === 2 ? data.memo.trim() : null
      );
      await TaskDAO.reevaluateInstanceCompletion(client, instanceId);
      return { participant: updated, binder_id: instance.binder_id };
    });
    this.emitParticipantSync(
      result.binder_id, instanceId, context, ActionType.STATE_UPDATE,
      { new_state: data.state }
    );
    return result.participant;
  }

  async removeParticipant(taskId, instanceId, targetUserId, context) {
    const result = await withTransaction(async (client) => {
      const instance = await TaskDAO.findInstanceContext(client, taskId, instanceId);
      if (!instance) throw new NotFoundError('할 일 인스턴스를 찾을 수 없습니다');
      const actor = await BinderDAO.getMember(client, instance.binder_id, context.sender_id);
      if (!actor || actor.deleted_at) throw new ForbiddenError('바인더 멤버만 제거할 수 있습니다');
      if (targetUserId !== context.sender_id && actor.role > 2)
        throw new ForbiddenError('편집자 이상만 타인을 제거할 수 있습니다');
      const participant = await TaskDAO.findParticipant(client, instanceId, targetUserId);
      if (!participant || participant.deleted_at)
        throw new NotFoundError('활성 참여자를 찾을 수 없습니다', 'TASK_PARTICIPANT_NOT_FOUND');
      const removed = await TaskDAO.removeParticipant(client, instanceId, targetUserId);
      await TaskDAO.reevaluateInstanceCompletion(client, instanceId);
      return { participant: removed, binder_id: instance.binder_id };
    });
    this.emitParticipantSync(result.binder_id, instanceId, context, ActionType.UNASSIGN);
    return result.participant;
  }

  emitParticipantSync(binderId, instanceId, context, action, metadata) {
    eventBus.emit('sync', {
      binder_id: binderId,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action,
      target_type: TargetType.TASK_PARTICIPANT,
      target_id: instanceId,
      ...(metadata ? { metadata } : {}),
    });
  }
}

module.exports = {
  TaskService: new TaskService(),
};
