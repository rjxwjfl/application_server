-- RLY-20260806-026 — events/tasks.reminder_offsets 단독 이식.
--
-- schema.md:384(events)·541(tasks) 원문: `reminder_offsets INTEGER[]` — nullable, 기본값 없음.
-- special_days.reminder_offsets(이미 config/schema.sql에 존재)와 동일 정의를 복제했다.
--
-- 이 컬럼이 없어 항목 공통 알림 오프셋을 저장할 곳이 없었고, ReminderDAO.create가 대신
-- 존재하지 않는 user_id·base_time 컬럼으로 INSERT해 리마인더가 붙은 이벤트 생성이 트랜잭션
-- 통째로 롤백되던 결함(진단: RLY-20260806-026 구현보고서)의 근본 원인 중 하나다.
ALTER TABLE events ADD COLUMN IF NOT EXISTS reminder_offsets INTEGER[];
ALTER TABLE tasks  ADD COLUMN IF NOT EXISTS reminder_offsets INTEGER[];
