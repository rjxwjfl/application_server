const SyncService = require('../../services/syncService');
const asyncHandler = require('../../core/asyncHandler');
const { BadRequestError } = require('../../core/errors');

const syncController = {
  pullChanges: asyncHandler(async (req, res) => {
    const { sync_token } = req.body;
    const { data, next_sync_token } = await SyncService.pullChanges(
      req.user_id,
      sync_token ?? null
    );
    res.json({ success: true, data, next_sync_token });
  }),

  fetchCalendarWindow: asyncHandler(async (req, res) => {
    const { start, end } = req.query;
    if (!start || !end) throw new BadRequestError('start, end 날짜가 필요합니다.');

    const startDate = new Date(start);
    const endDate = new Date(end);
    if (isNaN(startDate) || isNaN(endDate)) throw new BadRequestError('유효하지 않은 날짜 형식입니다.');

    const data = await SyncService.fetchCalendarWindow(req.user_id, startDate, endDate);
    res.json({ success: true, data });
  }),

  syncNewBinder: asyncHandler(async (req, res) => {
    const { binderId } = req.params;
    const data = await SyncService.syncNewBinder(req.user_id, binderId);
    res.json({ success: true, data });
  }),

  syncSettings: asyncHandler(async (req, res) => {
    const updatedSettings = await SyncService.syncSettings(req.user_id, req.body);
    res.json({ success: true, data: updatedSettings });
  }),
};

module.exports = syncController;
