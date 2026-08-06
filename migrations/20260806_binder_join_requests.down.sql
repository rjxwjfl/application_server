ALTER TABLE binder_members DROP CONSTRAINT IF EXISTS chk_bm_role;
DROP INDEX IF EXISTS idx_bjr_blocked;
DROP INDEX IF EXISTS uq_bjr_pending;
DROP TABLE IF EXISTS binder_join_requests;
