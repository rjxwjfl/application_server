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

  // RLY-20260806-216 — User 판정: "오래된 알림 삭제" 버튼(SC-notifications.md E22)이 서버에도
  // 알려 모든 기기에서 지워지게 한다. 30일은 클라 NotificationsActions.deleteOlderThan30Days()의
  // 기준을 그대로 옮겼다 — 요청 본문 없이 서버가 독립적으로 계산한다(클라와 다른 값을 받게
  // 두면 기기마다 다시 달라진다).
  deleteOldNotifications: asyncHandler(async (req, res) => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await NotificationDAO.softDeleteOlderThan(pool, req.user_id, cutoff);
    res.json({ success: true, message: '오래된 알림을 삭제했습니다' });
  }),
};

module.exports = notificationController;
