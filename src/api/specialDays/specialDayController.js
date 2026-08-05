const { SpecialDayService } = require('../../services/specialDayService');
const asyncHandler = require('../../core/asyncHandler');
const { BadRequestError } = require('../../core/errors');

const specialDayController = {
  getById: asyncHandler(async (req, res) => {
    const day = await SpecialDayService.getById(req.params.id, req.user_id);
    res.json({ success: true, data: day });
  }),

  getHolidays: asyncHandler(async (req, res) => {
    const holidays = await SpecialDayService.getHolidays(req.query);
    res.json({ success: true, data: { holidays } });
  }),

  create: asyncHandler(async (req, res) => {
    if (!req.body.calendar_id) throw new BadRequestError('calendar_id가 필요합니다');
    if (!req.body.name)   throw new BadRequestError('name이 필요합니다');
    if (!req.body.base_date) throw new BadRequestError('base_date가 필요합니다');

    const day = await SpecialDayService.create(req.body, {
      sender_id: req.user_id,
      device_uuid: req.device_uuid,
    });
    res.status(201).json({ success: true, data: day, message: '기념일이 생성되었습니다' });
  }),

  update: asyncHandler(async (req, res) => {
    const day = await SpecialDayService.update(req.params.id, req.body, {
      sender_id: req.user_id,
      device_uuid: req.device_uuid,
    });
    res.json({ success: true, data: day, message: '기념일이 수정되었습니다' });
  }),

  delete: asyncHandler(async (req, res) => {
    await SpecialDayService.delete(req.params.id, {
      sender_id: req.user_id,
      device_uuid: req.device_uuid,
    });
    res.json({ success: true, message: '기념일이 삭제되었습니다' });
  }),
};

module.exports = specialDayController;
