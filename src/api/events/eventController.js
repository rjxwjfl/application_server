const { EventService } = require('../../services/eventService');
const asyncHandler = require('../../core/asyncHandler');

const eventController = {
  createEvent: asyncHandler(async (req, res) => {
    const event = await EventService.createEvent(req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.status(201).json({ success: true, data: event, message: '이벤트가 생성되었습니다' });
  }),

  getEvent: asyncHandler(async (req, res) => {
    const event = await EventService.getEvent(req.params.eventId);
    res.json({ success: true, data: event });
  }),

  updateEvent: asyncHandler(async (req, res) => {
    const { eventId } = req.params;
    const event = await EventService.updateEvent(eventId, req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, data: event, message: '이벤트가 수정되었습니다' });
  }),

  updateEventInstance: asyncHandler(async (req, res) => {
    const { instanceId } = req.params;
    const instance = await EventService.updateEventInstance(instanceId, req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, data: instance, message: '이벤트 인스턴스가 수정되었습니다' });
  }),

  splitEvent: asyncHandler(async (req, res) => {
    const { eventId, instanceId } = req.params;
    const result = await EventService.splitEvent(
      { event_id: eventId, instance_id: instanceId, ...req.body },
      { sender_id: req.user_id, device_uuid: req.device_uuid }
    );
    res.status(201).json({ success: true, data: result, message: '이벤트가 분리되었습니다' });
  }),

  deleteEvent: asyncHandler(async (req, res) => {
    const { eventId } = req.params;
    await EventService.deleteEvent(eventId, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, message: '이벤트가 삭제되었습니다' });
  }),

  deleteEventInstance: asyncHandler(async (req, res) => {
    const { instanceId } = req.params;
    await EventService.deleteEventInstance(instanceId, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, message: '이벤트 인스턴스가 삭제되었습니다' });
  }),

  addParticipant: asyncHandler(async (req, res) => {
    const { instanceId } = req.params;
    const participant = await EventService.addParticipant(instanceId, req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.status(201).json({ success: true, data: participant, message: '참가자가 추가되었습니다' });
  }),

  updateMyParticipation: asyncHandler(async (req, res) => {
    const { instanceId } = req.params;
    await EventService.updateMyParticipation(instanceId, req.user_id, req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, message: '참가 상태가 변경되었습니다' });
  }),

  removeParticipant: asyncHandler(async (req, res) => {
    const { instanceId, userId } = req.params;
    const target_id = userId || req.body.target_id;
    await EventService.removeParticipant(instanceId, target_id, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, message: '참가자가 삭제되었습니다' });
  }),
};

module.exports = eventController;
