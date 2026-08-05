const express = require('express');
const router = express.Router();
const calendarController = require('../api/calendars/calendarController');
const castController = require('../api/casts/castController');

// 내 캘린더 구독 목록 (/:calId 보다 앞에 등록)
router.get('/subscriptions', calendarController.getMySubscriptions);

// 캘린더 단건 조회 / 수정 / 삭제
router.get('/:calId', calendarController.getById);
router.patch('/:calId', calendarController.update);
router.delete('/:calId', calendarController.delete);

// 캘린더 구독 관리
router.post('/:calId/subscribe', calendarController.subscribe);
router.delete('/:calId/subscribe', calendarController.unsubscribe);
router.get('/:calId/subscriptions', calendarController.getSubscriptions);

// 시프트 통계 — 폐기 (2026-08-01 User 결정, api.md §4). 구 클라이언트 호환을 위해
// 라우트는 유지하되 SHIFT_NOT_SUPPORTED(410)로 명시 거부한다.
router.get('/:calId/shift-stats', calendarController.shiftNotSupported);

// 캐스트 목록
router.get('/:calId/casts', castController.getCasts);

module.exports = router;
