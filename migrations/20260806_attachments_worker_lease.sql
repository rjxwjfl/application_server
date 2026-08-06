-- RLY-20260806-047 — attachments Worker claim/lease 컬럼.
--
-- media.md §4-4 Worker 파이프라인이 지금까지 전혀 구현돼 있지 않았다(MIME 검사·EXIF 파기·
-- 파생 미디어 생성 grep 0건). 트리거 메커니즘은 문서(Cloud Pub/Sub)와 system.md §10-13
-- (2026-08-01 확정, "이 계약은 reminder 전용이 아니다")이 충돌해 후자를 따른다 — 이 저장소의
-- 유일한 선례(reminderJobs.js)가 이미 같은 이유(F-S7 외부 트리거 이관 전)로 node-cron 폴링 +
-- FOR UPDATE SKIP LOCKED claim/lease를 쓴다.
--
-- attachments에는 reminders(schema.md §10-4)와 달리 claim/lease 컬럼이 없어 워커가 처리 도중
-- 죽으면 그 행이 영원히 'processing'에 멈춘다 — reminders의 lease 4컬럼을 컬럼명·타입·기본값
-- 그대로 복제한다(이미 승인된 설계 재사용, 새 구조 아님).
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS claim_token     UUID;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS claimed_at      TIMESTAMPTZ;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS attempt_count   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_att_dispatch ON attachments (status, next_attempt_at) WHERE status = 'processing';
