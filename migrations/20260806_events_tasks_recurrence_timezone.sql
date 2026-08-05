-- RLY-20260806-019 — events/tasks.recurrence_timezone 단독 이식.
-- 컬럼이 없어 클라의 반복 anchor 시간대가 sync pull마다 리셋되던 결함(진단:
-- .outbox/diagnosis-drift-and-sync-20260806.md §B)을 막는다.
--
-- spec 원문(docs/database/schema.md:374,532)의 anchor 6컬럼 중 이 컬럼만 이식한다.
-- 나머지 5개(start_kind·dtstart_date·dtstart_local·day_span·duration_seconds)는
-- fork 전환(2026-08-03) 미착수라, ck_ev_anchor/ck_tk_anchor 배타 CHECK는 그 5개가
-- 함께 들어올 때 한 번에 건다 — 지금 걸면 "5개 모두 NULL"만 통과하는 무의미한 제약이 된다.
ALTER TABLE events ADD COLUMN IF NOT EXISTS recurrence_timezone VARCHAR(64);
ALTER TABLE tasks  ADD COLUMN IF NOT EXISTS recurrence_timezone VARCHAR(64);
