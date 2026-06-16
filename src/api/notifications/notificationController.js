const { NotificationDAO } = require('../../daos/notificationDAO');
const asyncHandler = require('../../core/asyncHandler');
const pool = require('../../../config/db');

const notificationController = {
  getNotifications: asyncHandler(async (req, res) => {
    const { cursor_at, limit = 30, unread_only } = req.query;
    const notifications = await NotificationDAO.getByRecipient(pool, req.user_id, {
      cursor_at,
      limit: Math.min(parseInt(limit, 10) || 30, 100),
      unread_only: unread_only === 'true',
    });
    res.json({ success: true, data: notifications });
  }),

  getUnreadCount: asyncHandler(async (req, res) => {
    const count = await NotificationDAO.getUnreadCount(pool, req.user_id);
    res.json({ success: true, data: { count } });
  }),

  markAsRead: asyncHandler(async (req, res) => {
    await NotificationDAO.markAsRead(pool, req.params.id, req.user_id);
    res.json({ success: true, message: '알림을 읽음 처리했습니다' });
  }),

  markAllAsRead: asyncHandler(async (req, res) => {
    await NotificationDAO.markAllAsRead(pool, req.user_id);
    res.json({ success: true, message: '모든 알림을 읽음 처리했습니다' });
  }),

  deleteNotification: asyncHandler(async (req, res) => {
    await NotificationDAO.softDelete(pool, req.params.id, req.user_id);
    res.json({ success: true, message: '알림이 삭제되었습니다' });
  }),
};

module.exports = notificationController;
