const { TaskDAO } = require('../daos/taskDAO');
const { BinderDAO } = require('../daos/binderDAO');
const { ReminderDAO } = require('../daos/reminderDAO');
const { REMINDER_TARGET_TYPE } = require('../daos/deleteCascadeHelpers');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const withTransaction = require('../core/withTransaction');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../core/errors');
const { requireBinderMemberByCalendarId, requireBinderMember } = require('../core/authz');
const { TargetType, ActionType } = require('../utils/typeDefinitions');
const pool = require('../../config/db');

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

  async updateTask(taskId, updateData, context) {
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

  async splitTask(splitData, context) {
    // controller가 { task_id, instance_id, ...req.body }로 넘긴다(taskController.splitTask) —
    // 기존에 camelCase(taskId/instanceId)로 구조분해해 항상 undefined였던 버그를 함께 고친다
    // (Event 쪽 splitEvent는 이미 snake_case로 일치했다 — "구조가 같은데 한쪽만 고쳐졌다" 반복 방지).
    const { task_id: taskId, instance_id: instanceId } = splitData;
    if (!taskId || !instanceId) {
      throw new BadRequestError('taskId와 instanceId가 필요합니다');
    }

    const newTaskId = generateUUID();

    const { result, binder_id } = await withTransaction(async (client) => {
      const task = await TaskDAO.findById(client, taskId);
      if (!task) throw new NotFoundError('할 일을 찾을 수 없습니다');
      const { calendar, member } = await requireBinderMemberByCalendarId(client, task.calendar_id, context.sender_id);
      assertCanEditItem(task.author_id, context.sender_id, member);

      const instance = await TaskDAO.findInstanceContext(client, taskId, instanceId);
      if (!instance) throw new NotFoundError('할 일 인스턴스를 찾을 수 없습니다');

      const result = await TaskDAO.splitTask(client, taskId, instanceId, newTaskId);
      return { result, binder_id: calendar.binder_id };
    });

    eventBus.emit('sync', {
      binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.CREATE, target_type: TargetType.TASK, target_id: newTaskId,
    });

    return result;
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
      const participant = await TaskDAO.addParticipant(client, instanceId, data.user_id, context.sender_id);
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
