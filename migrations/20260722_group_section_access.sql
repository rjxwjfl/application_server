-- UP
ALTER TABLE sections DROP COLUMN IF EXISTS required_grade;
COMMENT ON COLUMN sections.access_scope IS '0=public (active binder members), 1=private (section_groups joined to group_members)';

CREATE TABLE groups (
  id UUID PRIMARY KEY,
  binder_id UUID NOT NULL REFERENCES binders(id),
  name TEXT NOT NULL,
  color TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_groups_sync ON groups (binder_id, updated_at);

CREATE TABLE group_members (
  id UUID PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES groups(id),
  user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_group_members_active ON group_members (group_id, user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_gm_user_sync ON group_members (user_id, updated_at);
CREATE INDEX idx_gm_group ON group_members (group_id) WHERE deleted_at IS NULL;

CREATE TABLE section_groups (
  id UUID PRIMARY KEY,
  section_id UUID NOT NULL REFERENCES sections(id),
  group_id UUID NOT NULL REFERENCES groups(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_section_groups_active ON section_groups (section_id, group_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_sg_section ON section_groups (section_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_sg_group_sync ON section_groups (group_id, updated_at);

ALTER TABLE binder_members ADD COLUMN primary_group_id UUID;
ALTER TABLE binder_members ADD CONSTRAINT fk_bm_primary_group
  FOREIGN KEY (primary_group_id) REFERENCES groups(id) ON DELETE SET NULL;

-- DOWN (execute this block to roll back)
-- ALTER TABLE binder_members DROP CONSTRAINT IF EXISTS fk_bm_primary_group;
-- ALTER TABLE binder_members DROP COLUMN IF EXISTS primary_group_id;
-- DROP TABLE IF EXISTS section_groups;
-- DROP TABLE IF EXISTS group_members;
-- DROP TABLE IF EXISTS groups;
-- ALTER TABLE sections ADD COLUMN required_grade SMALLINT NOT NULL DEFAULT 3;
-- COMMENT ON COLUMN sections.access_scope IS NULL;
