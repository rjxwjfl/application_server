-- F-S9 선행 — attachments(storage_key) 부분 인덱스.
-- F-S0(schema.sql 수리, 별도 Task)가 정식으로 config/schema.sql에 이식할 항목이나,
-- F-S9의 판정 쿼리(결정 56 하드 삭제 가드와 같은 술어 — "이 바인더에서 이 storage_key가
-- 유일한 활성 행인가")가 이 인덱스에 의존하므로 여기서 먼저 만든다.
-- 정의는 docs/database/schema.md:949 원문과 문자 단위로 같아야 한다(이름·부분 조건 포함).
CREATE INDEX IF NOT EXISTS idx_att_storage_key ON attachments (storage_key) WHERE deleted_at IS NULL;
