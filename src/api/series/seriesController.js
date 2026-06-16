const { SeriesService } = require('../../services/seriesService');
const { MessageService } = require('../../services/messageService');
const { MessageDAO } = require('../../daos/messageDAO');
const pool = require('../../../config/db');
const asyncHandler = require('../../core/asyncHandler');

const seriesController = {
  // ============================================
  // Series CRUD
  // ============================================

  getSeries: asyncHandler(async (req, res) => {
    const { drawerId } = req.params;
    const series = await SeriesService.getSeriesByDrawerId(drawerId);
    res.json({ success: true, data: series });
  }),

  createSeries: asyncHandler(async (req, res) => {
    const series = await SeriesService.createSeries(req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.status(201).json({ success: true, data: series, message: '시리즈가 생성되었습니다' });
  }),

  updateSeries: asyncHandler(async (req, res) => {
    const { seriesId } = req.params;
    const series = await SeriesService.updateSeries(seriesId, req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, data: series, message: '시리즈가 수정되었습니다' });
  }),

  deleteSeries: asyncHandler(async (req, res) => {
    const { seriesId } = req.params;
    await SeriesService.deleteSeries(seriesId, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, message: '시리즈가 삭제되었습니다' });
  }),

  // ============================================
  // Messages
  // ============================================

  getMessages: asyncHandler(async (req, res) => {
    const { seriesId } = req.params;
    const { cursor_at, cursor_id, before_cursor, limit } = req.query;
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;

    let cursorAt = cursor_at;
    let cursorId = cursor_id;

    if (before_cursor && !cursor_at) {
      const cursorMsg = await MessageDAO.findById(pool, before_cursor);
      if (cursorMsg) {
        cursorAt = cursorMsg.created_at;
        cursorId = cursorMsg.id;
      }
    }

    const messages = await MessageService.getMessages(seriesId, {
      cursor_at: cursorAt, cursor_id: cursorId, limit: parsedLimit,
    });
    res.json({ success: true, data: messages });
  }),

  createMessage: asyncHandler(async (req, res) => {
    const { seriesId } = req.params;
    const message = await MessageService.createMessage(seriesId, req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.status(201).json({ success: true, data: message, message: '메시지가 생성되었습니다' });
  }),

  updateMessage: asyncHandler(async (req, res) => {
    const { messageId } = req.params;
    const message = await MessageService.updateMessage(messageId, req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, data: message, message: '메시지가 수정되었습니다' });
  }),

  deleteMessage: asyncHandler(async (req, res) => {
    const { messageId } = req.params;
    await MessageService.deleteMessage(messageId, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, message: '메시지가 삭제되었습니다' });
  }),

  togglePin: asyncHandler(async (req, res) => {
    const { messageId } = req.params;
    const result = await MessageService.togglePin(messageId, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, data: result, message: '핀 상태가 변경되었습니다' });
  }),

  // ============================================
  // Files
  // ============================================

  listFiles: asyncHandler(async (req, res) => {
    const { seriesId } = req.params;
    const files = await SeriesService.listFiles(seriesId, req.query, req.user_id);
    res.json({ success: true, data: files });
  }),

  // ============================================
  // Reactions
  // ============================================

  addReaction: asyncHandler(async (req, res) => {
    const { messageId } = req.params;
    const { emoji } = req.body;
    const result = await MessageService.addReaction(messageId, emoji, { sender_id: req.user_id });
    res.status(201).json({ success: true, data: result });
  }),

  removeReaction: asyncHandler(async (req, res) => {
    const { messageId, emoji } = req.params;
    await MessageService.removeReaction(messageId, emoji, { sender_id: req.user_id });
    res.json({ success: true, message: '리액션이 제거되었습니다' });
  }),

  // ============================================
  // Cursor (읽음 위치)
  // ============================================

  updateCursor: asyncHandler(async (req, res) => {
    const { seriesId } = req.params;
    await MessageService.updateCursor(seriesId, req.user_id, req.body);
    res.json({ success: true });
  }),

  // ============================================
  // Pinned Messages
  // ============================================

  getPinnedMessages: asyncHandler(async (req, res) => {
    const { seriesId } = req.params;
    const messages = await MessageService.getPinnedMessages(seriesId);
    res.json({ success: true, data: messages });
  }),

  // ============================================
  // Polls
  // ============================================

  getPoll: asyncHandler(async (req, res) => {
    const { messageId, pollId } = req.params;
    const poll = await MessageService.getPoll(messageId, pollId, req.user_id);
    res.json({ success: true, data: poll });
  }),

  votePoll: asyncHandler(async (req, res) => {
    const { messageId, pollId } = req.params;
    await MessageService.votePoll(messageId, pollId, req.body, req.user_id);
    res.json({ success: true });
  }),

  closePoll: asyncHandler(async (req, res) => {
    const { messageId, pollId } = req.params;
    await MessageService.closePoll(messageId, pollId, { sender_id: req.user_id });
    res.json({ success: true });
  }),
};

module.exports = seriesController;
