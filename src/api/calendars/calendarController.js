const { CalendarService } = require('../../services/calendarService');
const asyncHandler = require('../../core/asyncHandler');
const { BadRequestError } = require('../../core/errors');

const calendarController = {
  getDrawerCalendars: asyncHandler(async (req, res) => {
    const { drawerId } = req.params;
    const calendars = await CalendarService.getDrawerCalendars(drawerId, req.user_id);
    res.json({ success: true, data: calendars });
  }),

  create: asyncHandler(async (req, res) => {
    if (!req.body.drawer_id) throw new BadRequestError('drawer_id가 필요합니다');
    if (!req.body.title)     throw new BadRequestError('title이 필요합니다');

    const calendar = await CalendarService.create(req.body, {
      sender_id: req.user_id,
      device_uuid: req.device_uuid,
    });
    res.status(201).json({ success: true, data: calendar, message: '캘린더가 생성되었습니다' });
  }),

  update: asyncHandler(async (req, res) => {
    const calendar = await CalendarService.update(req.params.calId, req.body, {
      sender_id: req.user_id,
      device_uuid: req.device_uuid,
    });
    res.json({ success: true, data: calendar, message: '캘린더가 수정되었습니다' });
  }),

  delete: asyncHandler(async (req, res) => {
    await CalendarService.delete(req.params.calId, {
      sender_id: req.user_id,
      device_uuid: req.device_uuid,
    });
    res.json({ success: true, message: '캘린더가 삭제되었습니다' });
  }),

  subscribe: asyncHandler(async (req, res) => {
    const sub = await CalendarService.subscribe(req.params.calId, {
      sender_id: req.user_id,
      device_uuid: req.device_uuid,
    });
    res.status(201).json({ success: true, data: sub, message: '캘린더를 구독했습니다' });
  }),

  unsubscribe: asyncHandler(async (req, res) => {
    await CalendarService.unsubscribe(req.params.calId, {
      sender_id: req.user_id,
      device_uuid: req.device_uuid,
    });
    res.json({ success: true, message: '캘린더 구독을 해제했습니다' });
  }),

  getMySubscriptions: asyncHandler(async (req, res) => {
    const subs = await CalendarService.getMySubscriptions(req.user_id);
    res.json({ success: true, data: subs });
  }),

  getById: asyncHandler(async (req, res) => {
    const calendar = await CalendarService.getById(req.params.calId, req.user_id);
    res.json({ success: true, data: calendar });
  }),

  getSubscriptions: asyncHandler(async (req, res) => {
    const subs = await CalendarService.getCalendarSubscriptions(req.params.calId, req.user_id);
    res.json({ success: true, data: subs });
  }),

  getShiftStats: asyncHandler(async (req, res) => {
    const { period } = req.query;
    if (!period) throw new BadRequestError('period 파라미터가 필요합니다 (YYYY-MM)');
    const stats = await CalendarService.getShiftStats(req.params.calId, period, req.user_id);
    res.json({ success: true, data: stats });
  }),
};

module.exports = calendarController;
