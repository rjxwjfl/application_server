-- RLY-20260806-147 — notifications.group_key 복원(T-1 down). 파티션 부모에 ADD COLUMN 하면
-- 자식 파티션(notifications_2026·2027·2028) 전부에 자동 전파된다 — 위 up과 동일 근거.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS group_key VARCHAR(100);
