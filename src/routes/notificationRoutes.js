const express = require('express');
const router = express.Router();
const notificationController = require('../api/notifications/notificationController');

router.get('/', notificationController.getNotifications);
router.get('/unread-count', notificationController.getUnreadCount);
router.patch('/read-all', notificationController.markAllAsRead);
router.patch('/:id/read', notificationController.markAsRead);
// SC-notifications.md §7 API 표가 이미 `DELETE /notifications`(일괄 삭제·조건부)를
// "신규"로 명시해 뒀다 — 새 경로를 짓지 않고 그 표를 그대로 따른다. `/:id`보다 먼저
// 등록해야 한다(안 그러면 `/notifications`가 빈 세그먼트라 `/:id`엔 안 걸리므로 순서
// 자체는 충돌이 없지만, 명확성을 위해 구체적인 경로를 먼저 둔다).
router.delete('/', notificationController.deleteOldNotifications);
router.delete('/:id', notificationController.deleteNotification);

module.exports = router;
