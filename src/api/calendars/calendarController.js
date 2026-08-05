const { CalendarService } = require('../../services/calendarService');
const asyncHandler = require('../../core/asyncHandler');
const { BadRequestError, GoneError } = require('../../core/errors');

const calendarController = {
  getBinderCalendars: asyncHandler(async (req, res) => {
    const { binderId } = req.params;
    const calendars = await CalendarService.getBinderCalendars(binderId, req.user_id);
    res.json({ success: true, data: calendars });
  }),

  create: asyncHandler(async (req, res) => {
    if (!req.body.binder_id) throw new BadRequestError('binder_id가 필요합니다');
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

  // Shift는 active 기능에서 제거됐다 (2026-08-01 User 결정, api.md §4).
  // 호환 기간 구 클라이언트가 이 경로로 보내는 요청은 조용히 404 처리하지 않고
  // SHIFT_NOT_SUPPORTED(410)로 명시 거부한다.
  shiftNotSupported: asyncHandler(async (req, res) => {
    throw new GoneError('Shift 기능은 더 이상 지원되지 않습니다', 'SHIFT_NOT_SUPPORTED');
  }),
};

module.exports = calendarController;
