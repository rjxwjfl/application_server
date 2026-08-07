-- RLY-20260806-176 down — idx_feed_target 제거. 파티션 부모에서 DROP하면 자식 파티션의
-- 대응 인덱스도 함께 제거된다(위 up과 동일 근거 — 파티션된 인덱스는 부모·자식이 하나의
-- 단위로 관리된다).
DROP INDEX IF EXISTS idx_feed_target;
