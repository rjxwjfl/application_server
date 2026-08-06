DROP INDEX IF EXISTS idx_att_dispatch;
ALTER TABLE attachments DROP COLUMN IF EXISTS next_attempt_at;
ALTER TABLE attachments DROP COLUMN IF EXISTS attempt_count;
ALTER TABLE attachments DROP COLUMN IF EXISTS claimed_at;
ALTER TABLE attachments DROP COLUMN IF EXISTS claim_token;
