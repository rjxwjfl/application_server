DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM sections
    WHERE access_scope NOT IN (0, 1)
  ) THEN
    RAISE EXCEPTION
      'cannot migrate sections: legacy access_scope values outside 0=public and 1=private require an explicit product-approved mapping';
  END IF;
END
$$;
ALTER TABLE sections DROP COLUMN IF EXISTS required_grade;
ALTER TABLE sections DROP COLUMN IF EXISTS group_id;
ALTER TABLE binder_members DROP COLUMN IF EXISTS primary_group_id;
ALTER TABLE sections ADD CONSTRAINT chk_sections_access_scope CHECK (access_scope IN (0, 1));
COMMENT ON COLUMN sections.access_scope IS '0=public (active binder members), 1=private (section_members membership); immutable after creation';

CREATE TABLE section_members (
  id UUID PRIMARY KEY,
  section_id UUID NOT NULL REFERENCES sections(id),
  user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_section_members_active ON section_members (section_id, user_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_section_members_section_id ON section_members (section_id);
CREATE INDEX idx_section_members_user_id ON section_members (user_id);

CREATE TABLE groups (
  id UUID PRIMARY KEY,
  binder_id UUID NOT NULL REFERENCES binders(id),
  name VARCHAR(100) NOT NULL,
  color VARCHAR(20),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_groups_binder_sync ON groups (binder_id, updated_at);

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
