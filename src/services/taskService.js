const { TaskDAO } = require('../daos/taskDAO');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const withTransaction = require('../core/withTransaction');
const { BadRequestError, NotFoundError } = require('../core/errors');
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
      drawer_id: taskData.drawer_id,
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
      drawer_id: task.drawer_id,
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
      drawer_id: instance.drawer_id,
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
      drawer_id: splitData.drawer_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.CREATE, target_type: TargetType.TASK, target_id: newTaskId,
    });

    return result;
  }

  async deleteTask(taskId, context) {
    const { drawer_id } = await withTransaction(async (client) => {
      const task = await TaskDAO.findById(client, taskId);
      if (!task) throw new NotFoundError('할 일을 찾을 수 없습니다');
      await TaskDAO.softDeleteTask(client, taskId);
      return { drawer_id: task.drawer_id };
    });

    eventBus.emit('sync', {
      drawer_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE, target_type: TargetType.TASK, target_id: taskId,
    });
  }

  async deleteTaskInstance(instanceId, context) {
    const { drawer_id } = await withTransaction(async (client) => {
      const instance = await TaskDAO.findInstanceById(client, instanceId);
      if (!instance) throw new NotFoundError('할 일 인스턴스를 찾을 수 없습니다');
      await TaskDAO.softDeleteTaskInstance(client, instanceId);
      return { drawer_id: instance.drawer_id };
    });

    eventBus.emit('sync', {
      drawer_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE, target_type: TargetType.TASK_INSTANCE, target_id: instanceId,
    });
  }

  async adjustParticipants(instanceId, data, context) {
    const { add = [], remove = [] } = data;

    const { addResults } = await withTransaction(async (client) => {
      const addResults = await TaskDAO.addParticipantsBatch(client, instanceId, add);
      await TaskDAO.removeParticipantsBatch(client, instanceId, remove);
      return { addResults };
    });

    if (data.drawer_id) {
      eventBus.emit('sync', {
        drawer_id: data.drawer_id,
        sender_id: context.sender_id,
        device_uuid: context.device_uuid,
        action: ActionType.UPDATE, target_type: TargetType.TASK_PARTICIPANT, target_id: instanceId,
      });

      if (add.length > 0) {
        eventBus.emit('alert', {
          drawer_id: data.drawer_id,
          sender_id: context.sender_id,
          type: 'assignment',
          title: data.drawer_name || '',
          body: data.alert_body || '할 일에 담당자로 배정되었습니다.',
          target_user_ids: add,
          requiredLevel: 1,
          routeData: { route_type: TargetType.TASK_INSTANCE, route_id: instanceId },
          device_uuid: context.device_uuid,
        });
      }
    }

    return { added: addResults, removed: remove };
  }

  async updateMyParticipation(instanceId, updateData, context) {
    const { state } = updateData;
    if (state === undefined) throw new BadRequestError('state가 필요합니다');

    await withTransaction(async (client) => {
      await TaskDAO.updateParticipantState(client, instanceId, context.sender_id, state);
    });

    if (updateData.drawer_id) {
      eventBus.emit('sync', {
        drawer_id: updateData.drawer_id,
        sender_id: context.sender_id,
        device_uuid: context.device_uuid,
        action: ActionType.UPDATE, target_type: TargetType.TASK_PARTICIPANT, target_id: instanceId,
      });
    }
  }

  async removeParticipant(instanceId, targetUserId, context) {
    await withTransaction(async (client) => {
      await TaskDAO.removeParticipant(client, instanceId, targetUserId);
    });

    eventBus.emit('sync', {
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE, target_type: TargetType.TASK_PARTICIPANT, target_id: instanceId,
    });
  }
}

module.exports = {
  TaskService: new TaskService(),
};
