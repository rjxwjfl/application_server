ALTER TABLE binder_members DROP CONSTRAINT IF EXISTS fk_bm_primary_group;
ALTER TABLE binder_members DROP COLUMN IF EXISTS primary_group_id;
DROP TABLE IF EXISTS section_groups;
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS groups;
ALTER TABLE sections ADD COLUMN required_grade SMALLINT NOT NULL DEFAULT 3;
COMMENT ON COLUMN sections.access_scope IS NULL;
