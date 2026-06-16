const { TaskService } = require('../../services/taskService');
const asyncHandler = require('../../core/asyncHandler');

const taskController = {
  createTask: asyncHandler(async (req, res) => {
    const task = await TaskService.createTask(req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.status(201).json({ success: true, data: task, message: '할 일이 생성되었습니다' });
  }),

  getTask: asyncHandler(async (req, res) => {
    const task = await TaskService.getTask(req.params.taskId);
    res.json({ success: true, data: task });
  }),

  updateTask: asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const task = await TaskService.updateTask(taskId, req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, data: task, message: '할 일이 수정되었습니다' });
  }),

  updateTaskInstance: asyncHandler(async (req, res) => {
    const { instanceId } = req.params;
    const instance = await TaskService.updateTaskInstance(instanceId, req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, data: instance, message: '할 일 인스턴스가 수정되었습니다' });
  }),

  splitTask: asyncHandler(async (req, res) => {
    const { taskId, instanceId } = req.params;
    const result = await TaskService.splitTask(
      { task_id: taskId, instance_id: instanceId, ...req.body },
      { sender_id: req.user_id, device_uuid: req.device_uuid }
    );
    res.status(201).json({ success: true, data: result, message: '할 일이 분리되었습니다' });
  }),

  deleteTask: asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    await TaskService.deleteTask(taskId, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, message: '할 일이 삭제되었습니다' });
  }),

  deleteTaskInstance: asyncHandler(async (req, res) => {
    const { instanceId } = req.params;
    await TaskService.deleteTaskInstance(instanceId, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, message: '할 일 인스턴스가 삭제되었습니다' });
  }),

  adjustParticipants: asyncHandler(async (req, res) => {
    const { instanceId } = req.params;
    const result = await TaskService.adjustParticipants(instanceId, req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, data: result, message: '참가자가 조정되었습니다' });
  }),

  updateMyParticipation: asyncHandler(async (req, res) => {
    const { instanceId } = req.params;
    await TaskService.updateMyParticipation(instanceId, req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, message: '참가 상태가 변경되었습니다' });
  }),

  removeParticipant: asyncHandler(async (req, res) => {
    const { instanceId, userId } = req.params;
    const target_id = userId || req.body.target_id;
    await TaskService.removeParticipant(instanceId, target_id, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, message: '참가자가 삭제되었습니다' });
  }),
};

module.exports = taskController;
