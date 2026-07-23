DROP TABLE IF EXISTS section_members;
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS groups;
ALTER TABLE sections DROP CONSTRAINT IF EXISTS chk_sections_access_scope;
ALTER TABLE sections ADD COLUMN required_grade SMALLINT NOT NULL DEFAULT 3;
COMMENT ON COLUMN sections.access_scope IS NULL;
