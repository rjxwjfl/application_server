const express = require("express");
const router = express.Router();
const syncController = require("../api/sync/syncController");

// ── 메인 동기화 ───────────────────────────────────────────────────
// POST /sync
// Body: { sync_token?: string }
// Response: { success, data, next_sync_token }
router.post("/", syncController.pullChanges);

// ── Contextual Fetch A: 캘린더 날짜 윈도우 확장 ───────────────────
// GET /sync/window?start=ISO&end=ISO
// 달력 스크롤로 기본 윈도우(과거 90일~미래 1년) 밖을 탐색할 때 호출
// Sync Token 갱신 없음 (Backfill 전용)
router.get("/window", syncController.fetchCalendarWindow);

// ── Contextual Fetch C: 신규 가입 바인더 즉시 동기화 ───────────────
// GET /sync/binder/:binderId
// 초대 코드로 바인더 가입 직후 해당 바인더의 전체 데이터를 즉시 가져올 때 호출
// Sync Token 갱신 없음 (다음 pullChanges 에서 자동 반영)
router.get("/binder/:binderId", syncController.syncNewBinder);

// ── Settings Sync ─────────────────────────────────────────────────
// PATCH /sync/settings
router.patch("/settings", syncController.syncSettings);

module.exports = router;
