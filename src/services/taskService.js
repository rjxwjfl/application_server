const { TaskDAO } = require('../daos/taskDAO');
const { BinderDAO } = require('../daos/binderDAO');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const withTransaction = require('../core/withTransaction');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../core/errors');
const { TargetType, ActionType } = require('../utils/typeDefinitions');
const pool = require('../../config/db');

class TaskService {
  async getTask(taskId) {
    const task = await TaskDAO.findById(pool, taskId);
    if (!task) throw new NotFoundError('할 일을 찾을 수 없습니다');
    return task;
  }

  async createTask(taskData, context) {
    const taskId = taskData.id || generateUUID();

    const task = await withTransaction(async (client) => {
      return await TaskDAO.createTask(client, {
        ...taskData,
        id: taskId,
        author_id: context.sender_id,
      });
    });

    eventBus.emit('sync', {
      binder_id: taskData.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.CREATE, target_type: TargetType.TASK, target_id: task.id,
    });

    return task;
  }

  async updateTask(taskId, updateData, context) {
    const { task, result } = await withTransaction(async (client) => {
      const task = await TaskDAO.findById(client, taskId);
      if (!task) throw new NotFoundError('할 일을 찾을 수 없습니다');
      const result = await TaskDAO.updateTask(client, taskId, updateData);
      return { task, result };
    });

    eventBus.emit('sync', {
      binder_id: task.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.UPDATE, target_type: TargetType.TASK, target_id: taskId,
    });

    return result;
  }

  async updateTaskInstance(instanceId, updateData, context) {
    const { instance, result } = await withTransaction(async (client) => {
      const instance = await TaskDAO.findInstanceById(client, instanceId);
      if (!instance) throw new NotFoundError('할 일 인스턴스를 찾을 수 없습니다');
      const result = await TaskDAO.updateTaskInstance(client, instanceId, updateData);
      return { instance, result };
    });

    eventBus.emit('sync', {
      binder_id: instance.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.UPDATE, target_type: TargetType.TASK_INSTANCE, target_id: instanceId,
    });

    return result;
  }

  async splitTask(splitData, context) {
    const { taskId, instanceId } = splitData;
    if (!taskId || !instanceId) {
      throw new BadRequestError('taskId와 instanceId가 필요합니다');
    }

    const newTaskId = generateUUID();

    const result = await withTransaction(async (client) => {
      return await TaskDAO.splitTask(client, taskId, instanceId, newTaskId);
    });

    eventBus.emit('sync', {
      binder_id: splitData.binder_id,
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
      await TaskDAO.softDeleteTask(client, taskId);
      return { binder_id: task.binder_id };
    });

    eventBus.emit('sync', {
      binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE, target_type: TargetType.TASK, target_id: taskId,
    });
  }

  async deleteTaskInstance(instanceId, context) {
    const { binder_id } = await withTransaction(async (client) => {
      const instance = await TaskDAO.findInstanceById(client, instanceId);
      if (!instance) throw new NotFoundError('할 일 인스턴스를 찾을 수 없습니다');
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
      if (!actor || actor.deleted_at) throw new ForbiddenError('서랍 멤버만 참여할 수 있습니다');
      if (data.user_id !== context.sender_id && actor.role > 2)
        throw new ForbiddenError('편집자 이상만 타인을 추가할 수 있습니다');
      const target = await BinderDAO.getMember(client, instance.binder_id, data.user_id);
      if (!target || target.deleted_at) throw new BadRequestError('서랍 멤버만 추가할 수 있습니다');
      const participant = await TaskDAO.addParticipant(client, instanceId, data.user_id, context.sender_id);
      await TaskDAO.reevaluateInstanceCompletion(client, instanceId);
      return { participant, binder_id: instance.binder_id };
    });
    this.emitParticipantSync(result.binder_id, instanceId, context, ActionType.CREATE);
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
        throw new ForbiddenError('타인 상태 변경 역할 기준이 확정되지 않았습니다');
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
    this.emitParticipantSync(result.binder_id, instanceId, context, ActionType.UPDATE);
    return result.participant;
  }

  async removeParticipant(taskId, instanceId, targetUserId, context) {
    const result = await withTransaction(async (client) => {
      const instance = await TaskDAO.findInstanceContext(client, taskId, instanceId);
      if (!instance) throw new NotFoundError('할 일 인스턴스를 찾을 수 없습니다');
      const actor = await BinderDAO.getMember(client, instance.binder_id, context.sender_id);
      if (!actor || actor.deleted_at) throw new ForbiddenError('서랍 멤버만 제거할 수 있습니다');
      if (targetUserId !== context.sender_id && actor.role > 2)
        throw new ForbiddenError('편집자 이상만 타인을 제거할 수 있습니다');
      const participant = await TaskDAO.findParticipant(client, instanceId, targetUserId);
      if (!participant || participant.deleted_at)
        throw new NotFoundError('활성 참여자를 찾을 수 없습니다', 'TASK_PARTICIPANT_NOT_FOUND');
      const removed = await TaskDAO.removeParticipant(client, instanceId, targetUserId);
      await TaskDAO.reevaluateInstanceCompletion(client, instanceId);
      return { participant: removed, binder_id: instance.binder_id };
    });
    this.emitParticipantSync(result.binder_id, instanceId, context, ActionType.DELETE);
    return result.participant;
  }

  emitParticipantSync(binderId, instanceId, context, action) {
    eventBus.emit('sync', {
      binder_id: binderId,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action,
      target_type: TargetType.TASK_PARTICIPANT,
      target_id: instanceId,
    });
  }
}

module.exports = {
  TaskService: new TaskService(),
};
