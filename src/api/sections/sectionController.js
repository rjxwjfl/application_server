const { SectionService } = require('../../services/sectionService');
const { MessageService } = require('../../services/messageService');
const { MessageDAO } = require('../../daos/messageDAO');
const pool = require('../../../config/db');
const asyncHandler = require('../../core/asyncHandler');

const sectionController = {
  // ============================================
  // Section CRUD
  // ============================================

  getSection: asyncHandler(async (req, res) => {
    const { binderId } = req.params;
    const section = await SectionService.getSectionByBinderId(binderId, req.user_id);
    res.json({ success: true, data: section });
  }),

  createSection: asyncHandler(async (req, res) => {
    const section = await SectionService.createSection(req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.status(201).json({ success: true, data: section, message: '섹션이 생성되었습니다' });
  }),

  updateSection: asyncHandler(async (req, res) => {
    const { sectionId } = req.params;
    const section = await SectionService.updateSection(sectionId, req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, data: section, message: '섹션이 수정되었습니다' });
  }),

  deleteSection: asyncHandler(async (req, res) => {
    const { sectionId } = req.params;
    await SectionService.deleteSection(sectionId, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, message: '섹션이 삭제되었습니다' });
  }),

  connectGroup: asyncHandler(async (req, res) => {
    const grant = await SectionService.connectGroup(req.params.sectionId, req.body, req.user_id);
    res.status(201).json({ success: true, data: grant });
  }),

  disconnectGroup: asyncHandler(async (req, res) => {
    await SectionService.disconnectGroup(req.params.sectionId, req.params.groupId, req.user_id);
    res.json({ success: true });
  }),

  // ============================================
  // Messages
  // ============================================

  getMessages: asyncHandler(async (req, res) => {
    const { sectionId } = req.params;
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

    await SectionService.assertContentAccess(sectionId, req.user_id);
    const messages = await MessageService.getMessages(sectionId, {
      cursor_at: cursorAt, cursor_id: cursorId, limit: parsedLimit,
    });
    res.json({ success: true, data: messages });
  }),

  createMessage: asyncHandler(async (req, res) => {
    const { sectionId } = req.params;
    await SectionService.assertContentAccess(sectionId, req.user_id);
    const message = await MessageService.createMessage(sectionId, req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.status(201).json({ success: true, data: message, message: '메시지가 생성되었습니다' });
  }),

  updateMessage: asyncHandler(async (req, res) => {
    const { messageId } = req.params;
    await SectionService.assertMessageAccess(messageId, req.user_id);
    const message = await MessageService.updateMessage(messageId, req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, data: message, message: '메시지가 수정되었습니다' });
  }),

  deleteMessage: asyncHandler(async (req, res) => {
    const { messageId } = req.params;
    await SectionService.assertMessageAccess(messageId, req.user_id);
    await MessageService.deleteMessage(messageId, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, message: '메시지가 삭제되었습니다' });
  }),

  togglePin: asyncHandler(async (req, res) => {
    const { messageId } = req.params;
    await SectionService.assertMessageAccess(messageId, req.user_id);
    const result = await MessageService.togglePin(messageId, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, data: result, message: '핀 상태가 변경되었습니다' });
  }),

  // ============================================
  // Files
  // ============================================

  listFiles: asyncHandler(async (req, res) => {
    const { sectionId } = req.params;
    const files = await SectionService.listFiles(sectionId, req.query, req.user_id);
    res.json({ success: true, data: files });
  }),

  // ============================================
  // Reactions
  // ============================================

  addReaction: asyncHandler(async (req, res) => {
    const { messageId } = req.params;
    const { emoji } = req.body;
    await SectionService.assertMessageAccess(messageId, req.user_id);
    const result = await MessageService.addReaction(messageId, emoji, { sender_id: req.user_id });
    res.status(201).json({ success: true, data: result });
  }),

  removeReaction: asyncHandler(async (req, res) => {
    const { messageId, emoji } = req.params;
    await SectionService.assertMessageAccess(messageId, req.user_id);
    await MessageService.removeReaction(messageId, emoji, { sender_id: req.user_id });
    res.json({ success: true, message: '리액션이 제거되었습니다' });
  }),

  // ============================================
  // Cursor (읽음 위치)
  // ============================================

  updateCursor: asyncHandler(async (req, res) => {
    const { sectionId } = req.params;
    await SectionService.assertContentAccess(sectionId, req.user_id);
    await MessageService.updateCursor(sectionId, req.user_id, req.body);
    res.json({ success: true });
  }),

  // ============================================
  // Pinned Messages
  // ============================================

  getPinnedMessages: asyncHandler(async (req, res) => {
    const { sectionId } = req.params;
    await SectionService.assertContentAccess(sectionId, req.user_id);
    const messages = await MessageService.getPinnedMessages(sectionId);
    res.json({ success: true, data: messages });
  }),

  // ============================================
  // Polls
  // ============================================

  getPoll: asyncHandler(async (req, res) => {
    const { messageId, pollId } = req.params;
    await SectionService.assertMessageAccess(messageId, req.user_id);
    const poll = await MessageService.getPoll(messageId, pollId, req.user_id);
    res.json({ success: true, data: poll });
  }),

  votePoll: asyncHandler(async (req, res) => {
    const { messageId, pollId } = req.params;
    await SectionService.assertMessageAccess(messageId, req.user_id);
    await MessageService.votePoll(messageId, pollId, req.body, req.user_id);
    res.json({ success: true });
  }),

  closePoll: asyncHandler(async (req, res) => {
    const { messageId, pollId } = req.params;
    await SectionService.assertMessageAccess(messageId, req.user_id);
    await MessageService.closePoll(messageId, pollId, { sender_id: req.user_id });
    res.json({ success: true });
  }),
};

module.exports = sectionController;
