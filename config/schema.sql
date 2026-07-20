-- ============================================================
-- Rally Database Schema
-- 2026-06-08 | spec: docs/database/schema.md
--
-- DROP TABLE ... CASCADE 포함 — 개발/시뮬레이터 DB 전용
-- DBeaver: Ctrl+A → Alt+X
-- ============================================================


-- ============================================================
-- SECTION 1: USERS
-- ============================================================

DROP TABLE IF EXISTS user_terms_consents  CASCADE;
DROP TABLE IF EXISTS user_settings        CASCADE;
DROP TABLE IF EXISTS user_devices         CASCADE;
DROP TABLE IF EXISTS user_infos           CASCADE;
DROP TABLE IF EXISTS users                CASCADE;

CREATE TABLE users (
  id                  UUID         NOT NULL,
  firebase_uid        VARCHAR(128),
  email               VARCHAR(255) NOT NULL,
  provider            VARCHAR(20),
  -- 0=active 1=inactive 2=suspended 3=banned
  status              SMALLINT     NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  latest_activity_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  suspended_reason    VARCHAR(200),
  suspended_until     TIMESTAMPTZ,
  inactive_since      TIMESTAMPTZ,
  deleted_at          TIMESTAMPTZ,
  PRIMARY KEY (id),
  UNIQUE (firebase_uid),
  UNIQUE (email)
);

CREATE TABLE user_infos (
  user_id       UUID         NOT NULL,
  user_code     VARCHAR(8)   NOT NULL,
  display_name  VARCHAR(100) NOT NULL,
  bio           TEXT,
  image_url     TEXT,
  thumbnail_url TEXT,
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id),
  UNIQUE (user_code),
  CONSTRAINT fk_ui_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE user_devices (
  id           UUID        NOT NULL,
  user_id      UUID        NOT NULL,
  device_uuid  UUID        NOT NULL,
  device_token TEXT,
  platform     VARCHAR(20) NOT NULL,
  device_name  TEXT,
  app_version  TEXT,
  os_version   TEXT,
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ          DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (user_id, device_uuid),
  CONSTRAINT fk_ud_user FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_user_devices_sync ON user_devices (user_id, updated_at);

CREATE TABLE user_settings (
  user_id             UUID        NOT NULL,
  -- 0=system 1=ko 2=en
  language_code       SMALLINT             DEFAULT 0,
  holidays_countries  TEXT[]               DEFAULT '{}',
  timezone            VARCHAR(50)          DEFAULT 'system',
  -- 0=sun 1=mon
  first_day_of_week   SMALLINT             DEFAULT 0,
  show_lunar_calendar BOOLEAN              DEFAULT FALSE,
  show_week_numbers   BOOLEAN              DEFAULT FALSE,
  blue_saturday       BOOLEAN              DEFAULT TRUE,
  is_push_enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
  is_notice_enabled   BOOLEAN     NOT NULL DEFAULT TRUE,
  -- 0=xs 1=sm 2=md 3=lg 4=xl
  font_size           SMALLINT             DEFAULT 1,
  -- 0=light 1=dark 2=system
  theme_preference    SMALLINT             DEFAULT 0,
  -- personal|family|club|school|work — 분석용 힌트
  persona_hint        VARCHAR(20),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id),
  CONSTRAINT fk_uset_user FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_user_settings_sync ON user_settings (user_id, updated_at);

CREATE TABLE user_terms_consents (
  id              UUID        NOT NULL,
  user_id         UUID        NOT NULL,
  terms_version   VARCHAR(20) NOT NULL,
  privacy_version VARCHAR(20) NOT NULL,
  consented_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- signup|reactivate|terms_update
  consent_source  VARCHAR(20),
  PRIMARY KEY (id),
  CONSTRAINT fk_utc_user FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_consent_user ON user_terms_consents (user_id, consented_at DESC);


-- ============================================================
-- SECTION 2: DRAWERS
-- ============================================================

DROP TABLE IF EXISTS drawer_storage_usage  CASCADE;
DROP TABLE IF EXISTS drawer_boosts         CASCADE;
DROP TABLE IF EXISTS drawer_invitations    CASCADE;
DROP TABLE IF EXISTS drawer_members        CASCADE;
DROP TABLE IF EXISTS drawer_settings       CASCADE;
DROP TABLE IF EXISTS drawers               CASCADE;

CREATE TABLE drawers (
  id               UUID        NOT NULL,
  name             TEXT        NOT NULL,
  description      TEXT,
  image_url        TEXT,
  thumbnail_url    TEXT,
  member_count     INT         NOT NULL DEFAULT 1,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  PRIMARY KEY (id)
);
CREATE INDEX idx_drawers_sync ON drawers (updated_at);

CREATE TABLE drawer_settings (
  drawer_id        UUID        NOT NULL,
  is_public        BOOLEAN     NOT NULL DEFAULT FALSE,
  is_searchable    BOOLEAN     NOT NULL DEFAULT FALSE,
  require_approval BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (drawer_id),
  CONSTRAINT fk_ds_drawer FOREIGN KEY (drawer_id) REFERENCES drawers(id)
);
CREATE INDEX idx_drawer_settings_sync ON drawer_settings (drawer_id, updated_at);

CREATE TABLE drawer_members (
  drawer_id           UUID        NOT NULL,
  user_id             UUID        NOT NULL,
  -- 0=master 1=manager 2=editor 3=member
  role                SMALLINT    NOT NULL,
  -- 0=allActivity 1=relatedOnly 2=mentionOnly 3=none
  notification_level  SMALLINT    NOT NULL DEFAULT 0,
  nickname_in_drawer  TEXT,
  joined_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ,
  PRIMARY KEY (drawer_id, user_id),
  CONSTRAINT fk_dm_drawer FOREIGN KEY (drawer_id) REFERENCES drawers(id),
  CONSTRAINT fk_dm_user   FOREIGN KEY (user_id)   REFERENCES users(id)
);
CREATE INDEX idx_drawer_members_sync ON drawer_members (drawer_id, updated_at);
CREATE INDEX idx_drawer_members_user ON drawer_members (user_id, updated_at);

CREATE TABLE drawer_invitations (
  id          UUID        NOT NULL,
  drawer_id   UUID        NOT NULL,
  inviter_id  UUID        NOT NULL,
  invite_code TEXT        NOT NULL,
  max_uses    INT                  DEFAULT 1,
  uses_count  INT                  DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (invite_code),
  CONSTRAINT fk_di_drawer  FOREIGN KEY (drawer_id)  REFERENCES drawers(id),
  CONSTRAINT fk_di_inviter FOREIGN KEY (inviter_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_inv_drawer ON drawer_invitations (drawer_id);

CREATE TABLE drawer_boosts (
  drawer_id                UUID        NOT NULL,
  -- 0=free 1=lite 2=plus
  tier                     SMALLINT    NOT NULL DEFAULT 0,
  -- ACTIVE|PAST_DUE|CANCELED|EXPIRED
  status                   VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  paid_by_user_id          UUID,
  product_id               VARCHAR(60),
  store_type               VARCHAR(20),
  original_transaction_id  VARCHAR(100),
  current_period_start     TIMESTAMPTZ,
  current_period_end       TIMESTAMPTZ,
  grace_period_end         TIMESTAMPTZ,
  cancel_at_period_end     BOOLEAN              DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (drawer_id),
  CONSTRAINT fk_db_payer FOREIGN KEY (paid_by_user_id) REFERENCES users(id)
);
CREATE INDEX idx_boost_payer  ON drawer_boosts (paid_by_user_id, status);
CREATE INDEX idx_boost_expiry ON drawer_boosts (current_period_end)
  WHERE status IN ('active', 'pastDue');
CREATE UNIQUE INDEX uk_boost_active_orig ON drawer_boosts (original_transaction_id)
  WHERE original_transaction_id IS NOT NULL AND status != 'expired';

CREATE TABLE drawer_storage_usage (
  drawer_id  UUID        NOT NULL,
  bytes_used BIGINT      NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (drawer_id)
);


-- ============================================================
-- SECTION 3: CALENDARS
-- ============================================================

DROP TABLE IF EXISTS calendar_subscriptions CASCADE;
DROP TABLE IF EXISTS calendars               CASCADE;

CREATE TABLE calendars (
  id          UUID        NOT NULL,
  drawer_id   UUID        NOT NULL,
  title       TEXT        NOT NULL,
  description TEXT,
  color       SMALLINT    NOT NULL DEFAULT 0,
  is_public   BOOLEAN     NOT NULL DEFAULT FALSE,
  -- 0=일반 1=시프트
  usage_type  SMALLINT    NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  PRIMARY KEY (id),
  CONSTRAINT fk_cal_drawer FOREIGN KEY (drawer_id) REFERENCES drawers(id)
);
CREATE INDEX idx_calendars_sync ON calendars (drawer_id, updated_at);

CREATE TABLE calendar_subscriptions (
  user_id     UUID        NOT NULL,
  calendar_id UUID        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  PRIMARY KEY (user_id, calendar_id),
  CONSTRAINT fk_cs_user FOREIGN KEY (user_id)     REFERENCES users(id),
  CONSTRAINT fk_cs_cal  FOREIGN KEY (calendar_id) REFERENCES calendars(id)
);
CREATE INDEX idx_cal_subs_sync ON calendar_subscriptions (user_id, updated_at);


-- ============================================================
-- SECTION 4: EVENTS
-- ============================================================

DROP TABLE IF EXISTS event_series        CASCADE;
DROP TABLE IF EXISTS event_participants  CASCADE;
DROP TABLE IF EXISTS event_instances     CASCADE;
DROP TABLE IF EXISTS events              CASCADE;

CREATE TABLE events (
  id          UUID        NOT NULL,
  calendar_id UUID        NOT NULL,
  author_id   UUID        NOT NULL,
  -- 0=general 1=container
  event_type  SMALLINT    NOT NULL DEFAULT 0,
  summary     TEXT        NOT NULL,
  description TEXT,
  color       SMALLINT    NOT NULL DEFAULT 0,
  r_rule      TEXT,
  locations   JSONB,
  forked_from UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  PRIMARY KEY (id),
  CONSTRAINT fk_ev_cal    FOREIGN KEY (calendar_id) REFERENCES calendars(id),
  CONSTRAINT fk_ev_author FOREIGN KEY (author_id)   REFERENCES users(id),
  CONSTRAINT fk_ev_fork   FOREIGN KEY (forked_from) REFERENCES events(id) ON DELETE SET NULL
);
CREATE INDEX idx_events_sync ON events (calendar_id, updated_at);

CREATE TABLE event_instances (
  id            UUID        NOT NULL,
  event_id      UUID        NOT NULL,
  -- 0=general 1=sub
  instance_type SMALLINT    NOT NULL DEFAULT 0,
  parent_id     UUID,
  summary       TEXT,
  description   TEXT,
  color         SMALLINT,
  locations     JSONB,
  is_all_day    BOOLEAN     NOT NULL DEFAULT FALSE,
  original_date TIMESTAMPTZ NOT NULL,
  start_date    TIMESTAMPTZ NOT NULL,
  end_date      TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  PRIMARY KEY (id),
  CONSTRAINT fk_ei_event  FOREIGN KEY (event_id)  REFERENCES events(id),
  CONSTRAINT fk_ei_parent FOREIGN KEY (parent_id) REFERENCES event_instances(id) ON DELETE CASCADE
);
CREATE INDEX idx_event_inst_sync ON event_instances (event_id, updated_at);

CREATE TABLE event_participants (
  instance_id UUID        NOT NULL,
  user_id     UUID        NOT NULL,
  -- 0=confirm 1=invite 2=apply 3=accept 4=tentative 5=decline 6=rejected(host)
  state       SMALLINT    NOT NULL DEFAULT 0 CHECK (state BETWEEN 0 AND 6),
  memo        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  PRIMARY KEY (instance_id, user_id),
  CONSTRAINT fk_ep_instance FOREIGN KEY (instance_id) REFERENCES event_instances(id),
  CONSTRAINT fk_ep_user     FOREIGN KEY (user_id)     REFERENCES users(id)
);
CREATE INDEX idx_event_part_sync ON event_participants (instance_id, updated_at);


-- ============================================================
-- SECTION 5: TASKS
-- ============================================================

DROP TABLE IF EXISTS task_series        CASCADE;
DROP TABLE IF EXISTS task_participants  CASCADE;
DROP TABLE IF EXISTS task_instances     CASCADE;
DROP TABLE IF EXISTS tasks              CASCADE;

CREATE TABLE tasks (
  id          UUID        NOT NULL,
  calendar_id UUID        NOT NULL,
  author_id   UUID        NOT NULL,
  -- 0=general 1=milestone
  task_type   SMALLINT    NOT NULL DEFAULT 0,
  summary     TEXT        NOT NULL,
  description TEXT,
  -- 0=low 1=medium 2=high 3=urgent
  priority    SMALLINT    NOT NULL DEFAULT 0,
  r_rule      TEXT,
  locations   JSONB,
  forked_from UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  PRIMARY KEY (id),
  CONSTRAINT fk_tk_cal    FOREIGN KEY (calendar_id) REFERENCES calendars(id),
  CONSTRAINT fk_tk_author FOREIGN KEY (author_id)   REFERENCES users(id),
  CONSTRAINT fk_tk_fork   FOREIGN KEY (forked_from) REFERENCES tasks(id) ON DELETE SET NULL
);
CREATE INDEX idx_tasks_sync ON tasks (calendar_id, updated_at);

CREATE TABLE task_instances (
  id              UUID        NOT NULL,
  task_id         UUID        NOT NULL,
  -- 0=general 1=subtask
  instance_type   SMALLINT    NOT NULL DEFAULT 0,
  parent_id       UUID,
  summary         TEXT,
  description     TEXT,
  priority        SMALLINT,
  locations       JSONB,
  is_all_day      BOOLEAN     NOT NULL DEFAULT FALSE,
  -- 0=individual 1=anyOne 2=allRequired
  completion_rule INT         NOT NULL DEFAULT 0,
  original_date   TIMESTAMPTZ NOT NULL,
  start_date      TIMESTAMPTZ,
  due_date        TIMESTAMPTZ NOT NULL,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  PRIMARY KEY (id),
  CONSTRAINT fk_ti_task   FOREIGN KEY (task_id)   REFERENCES tasks(id),
  CONSTRAINT fk_ti_parent FOREIGN KEY (parent_id) REFERENCES task_instances(id) ON DELETE CASCADE
);
CREATE INDEX idx_task_inst_task_id ON task_instances (task_id, updated_at);

CREATE TABLE task_participants (
  instance_id  UUID        NOT NULL,
  user_id      UUID        NOT NULL,
  -- 0=await 1=pending 2=done 3=expired(UI derived) 4=delayed 5=blocked
  state        SMALLINT    NOT NULL DEFAULT 0,
  memo         JSONB,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,
  PRIMARY KEY (instance_id, user_id),
  CONSTRAINT fk_tp_instance FOREIGN KEY (instance_id) REFERENCES task_instances(id),
  CONSTRAINT fk_tp_user     FOREIGN KEY (user_id)     REFERENCES users(id)
);
CREATE INDEX idx_task_part_sync ON task_participants (instance_id, updated_at);


-- ============================================================
-- SECTION 5.5: SERIES (before event_series / task_series)
-- ============================================================

DROP TABLE IF EXISTS series_message_cursors CASCADE;
DROP TABLE IF EXISTS message_poll_votes      CASCADE;
DROP TABLE IF EXISTS message_poll_options    CASCADE;
DROP TABLE IF EXISTS message_polls           CASCADE;
DROP TABLE IF EXISTS message_mentions        CASCADE;
DROP TABLE IF EXISTS message_reactions       CASCADE;
DROP TABLE IF EXISTS message_embeds          CASCADE;
DROP TABLE IF EXISTS attachments              CASCADE;
DROP TABLE IF EXISTS series_messages         CASCADE;
DROP TABLE IF EXISTS series                  CASCADE;

CREATE TABLE series (
  id             UUID        NOT NULL,
  drawer_id      UUID        NOT NULL,
  title          TEXT        NOT NULL,
  -- 0=public 1=gradeLimit 2=whiteList(미구현)
  access_scope   SMALLINT    NOT NULL DEFAULT 0,
  -- role <= required_grade 이어야 접근 가능
  required_grade SMALLINT             DEFAULT 3,
  is_default     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ,
  PRIMARY KEY (id),
  CONSTRAINT fk_sr_drawer FOREIGN KEY (drawer_id) REFERENCES drawers(id)
);
CREATE INDEX idx_series_sync ON series (drawer_id, updated_at);

-- event_series (events → series M:N)
CREATE TABLE event_series (
  event_id   UUID        NOT NULL,
  series_id  UUID        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (event_id, series_id),
  CONSTRAINT fk_es_event  FOREIGN KEY (event_id)  REFERENCES events(id),
  CONSTRAINT fk_es_series FOREIGN KEY (series_id) REFERENCES series(id)
);

-- task_series (tasks → series M:N)
CREATE TABLE task_series (
  task_id    UUID        NOT NULL,
  series_id  UUID        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (task_id, series_id),
  CONSTRAINT fk_tsr_task   FOREIGN KEY (task_id)   REFERENCES tasks(id),
  CONSTRAINT fk_tsr_series FOREIGN KEY (series_id) REFERENCES series(id)
);


-- ============================================================
-- SECTION 6: SPECIAL DAYS
-- ============================================================

DROP TABLE IF EXISTS holidays     CASCADE;
DROP TABLE IF EXISTS special_days CASCADE;

CREATE TABLE special_days (
  id             UUID        NOT NULL,
  calendar_id    UUID        NOT NULL,
  name           TEXT        NOT NULL,
  base_date      DATE        NOT NULL,
  is_yearly      BOOLEAN     NOT NULL DEFAULT TRUE,
  is_lunar       BOOLEAN     NOT NULL DEFAULT FALSE,
  show_dday      BOOLEAN     NOT NULL DEFAULT TRUE,
  count_from_one BOOLEAN     NOT NULL DEFAULT TRUE,
  show_every_day BOOLEAN     NOT NULL DEFAULT FALSE,
  sticker        TEXT,
  color          SMALLINT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ,
  PRIMARY KEY (id),
  CONSTRAINT fk_sd_cal FOREIGN KEY (calendar_id) REFERENCES calendars(id)
);
CREATE INDEX idx_special_days_sync ON special_days (calendar_id, updated_at);

CREATE TABLE holidays (
  id            SERIAL      NOT NULL,
  name          TEXT        NOT NULL,
  holiday_date  DATE        NOT NULL,
  country_code  VARCHAR(2)  NOT NULL,
  is_substitute BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  PRIMARY KEY (id)
);
CREATE INDEX idx_holidays_sync ON holidays (country_code, updated_at);


-- ============================================================
-- SECTION 7: SERIES MESSAGES & F7 EXTENSIONS
-- ============================================================

CREATE TABLE series_messages (
  id                UUID        NOT NULL,
  series_id         UUID        NOT NULL,
  user_id           UUID        NOT NULL,
  parent_id         UUID,
  content           TEXT,
  mention_everyone  BOOLEAN     NOT NULL DEFAULT FALSE,
  is_pinned         BOOLEAN     NOT NULL DEFAULT FALSE,
  pinned_at         TIMESTAMPTZ,
  pinned_by_user_id UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  PRIMARY KEY (id),
  CONSTRAINT fk_sm_series   FOREIGN KEY (series_id)         REFERENCES series(id),
  CONSTRAINT fk_sm_user     FOREIGN KEY (user_id)           REFERENCES users(id),
  CONSTRAINT fk_sm_parent   FOREIGN KEY (parent_id)         REFERENCES series_messages(id) ON DELETE SET NULL,
  CONSTRAINT fk_sm_pin_user FOREIGN KEY (pinned_by_user_id) REFERENCES users(id)
);
CREATE INDEX idx_sm_sync ON series_messages (series_id, updated_at);

CREATE TABLE attachments (
  id            UUID         NOT NULL,
  -- 다형 context: SERIES_MESSAGE · EVENT · TASK · POST · CAST · SPECIAL_DAY
  context_type  VARCHAR(30)  NOT NULL,
  -- 컨텍스트 PK (FK 없음 — 무결성은 서비스 레이어). pre-upload 시 null 허용
  context_id    UUID,
  -- denormalized: drawer 스토리지 사용량 집계 + GCS 키 네이밍
  drawer_id     UUID         NOT NULL,
  uploader_id   UUID         NOT NULL,
  filename      TEXT         NOT NULL,
  file_size     BIGINT       NOT NULL,
  content_type  VARCHAR(128) NOT NULL,
  -- GCS path — filled after confirm
  storage_key   TEXT,
  -- WebP CDN URL — Worker generated; null = client falls back to original
  thumbnail_url TEXT,
  duration_secs DOUBLE PRECISION,
  display_order INTEGER      NOT NULL DEFAULT 0,
  -- pending|processing|ready|hidden|deleted|rejected
  status        VARCHAR(20)  NOT NULL DEFAULT 'pending',
  -- standard|nearline|coldline|archive
  storage_class VARCHAR(20)  NOT NULL DEFAULT 'standard',
  hidden_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  PRIMARY KEY (id),
  CONSTRAINT fk_att_drawer   FOREIGN KEY (drawer_id)   REFERENCES drawers(id),
  CONSTRAINT fk_att_uploader FOREIGN KEY (uploader_id) REFERENCES users(id),
  CONSTRAINT chk_att_context CHECK (context_type IN ('SERIES_MESSAGE','EVENT','TASK','POST','CAST','SPECIAL_DAY'))
);
CREATE INDEX idx_att_context   ON attachments (context_type, context_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_att_drawer    ON attachments (drawer_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_att_uploader  ON attachments (uploader_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_att_sync      ON attachments (drawer_id, updated_at);
CREATE INDEX idx_att_lifecycle ON attachments (status, storage_class, hidden_at);
CREATE INDEX idx_att_orphan    ON attachments (status, created_at) WHERE context_id IS NULL;

CREATE TABLE message_embeds (
  id          UUID        NOT NULL,
  message_id  UUID        NOT NULL,
  -- link|image|video|event_instance|task_instance|special_day|cast|post
  type        TEXT        NOT NULL DEFAULT 'link',
  url         TEXT,
  title       TEXT,
  description TEXT,
  site_name   TEXT,
  image_url   TEXT,
  -- type별 스냅샷 메타데이터 (원본 삭제 후에도 카드 표시용)
  embed_data  JSONB,
  -- TargetType v4 값 (EVENT_INSTANCE|TASK_INSTANCE|SPECIAL_DAY|CAST|CAST_INSTANCE|POST)
  target_type VARCHAR(30),
  target_id   UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  PRIMARY KEY (id),
  CONSTRAINT fk_me_message FOREIGN KEY (message_id) REFERENCES series_messages(id)
);
CREATE INDEX idx_me_sync ON message_embeds (message_id, updated_at);

CREATE TABLE message_reactions (
  id         UUID        NOT NULL,
  message_id UUID        NOT NULL,
  user_id    UUID        NOT NULL,
  emoji      TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (id),
  CONSTRAINT fk_mr_message FOREIGN KEY (message_id) REFERENCES series_messages(id),
  CONSTRAINT fk_mr_user    FOREIGN KEY (user_id)    REFERENCES users(id)
);
CREATE UNIQUE INDEX uk_message_reactions_active
  ON message_reactions (message_id, user_id, emoji)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_mr_sync ON message_reactions (message_id, updated_at);

CREATE TABLE message_mentions (
  id         UUID        NOT NULL,
  message_id UUID        NOT NULL,
  user_id    UUID        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (id),
  CONSTRAINT fk_mm_message FOREIGN KEY (message_id) REFERENCES series_messages(id),
  CONSTRAINT fk_mm_user    FOREIGN KEY (user_id)    REFERENCES users(id)
);
CREATE UNIQUE INDEX uk_message_mentions_active
  ON message_mentions (message_id, user_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_mm_sync ON message_mentions (message_id, updated_at);

CREATE TABLE message_polls (
  id             UUID         NOT NULL,
  message_id     UUID         NOT NULL,
  question       VARCHAR(300) NOT NULL,
  allow_multiple BOOLEAN               DEFAULT FALSE,
  is_anonymous   BOOLEAN               DEFAULT FALSE,
  closes_at      TIMESTAMPTZ,
  closed_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (message_id),
  CONSTRAINT fk_mp_message FOREIGN KEY (message_id) REFERENCES series_messages(id) ON DELETE CASCADE
);
CREATE INDEX idx_poll_message ON message_polls (message_id);
CREATE INDEX idx_poll_closing ON message_polls (closes_at)
  WHERE closes_at IS NOT NULL AND closed_at IS NULL;

CREATE TABLE message_poll_options (
  id            UUID         NOT NULL,
  poll_id       UUID         NOT NULL,
  option_text   VARCHAR(200) NOT NULL,
  display_order SMALLINT     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT fk_mpo_poll FOREIGN KEY (poll_id) REFERENCES message_polls(id) ON DELETE CASCADE
);

CREATE TABLE message_poll_votes (
  poll_id   UUID        NOT NULL,
  option_id UUID        NOT NULL,
  user_id   UUID        NOT NULL,
  voted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, option_id, user_id),
  CONSTRAINT fk_mpv_poll   FOREIGN KEY (poll_id)   REFERENCES message_polls(id)        ON DELETE CASCADE,
  CONSTRAINT fk_mpv_option FOREIGN KEY (option_id) REFERENCES message_poll_options(id) ON DELETE CASCADE,
  CONSTRAINT fk_mpv_user   FOREIGN KEY (user_id)   REFERENCES users(id)
);
CREATE INDEX idx_poll_vote_poll ON message_poll_votes (poll_id, option_id);
CREATE INDEX idx_poll_vote_user ON message_poll_votes (user_id, poll_id);

CREATE TABLE series_message_cursors (
  user_id               UUID        NOT NULL,
  series_id             UUID        NOT NULL,
  last_read_message_id  UUID,
  last_read_message_at  TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, series_id),
  CONSTRAINT fk_smc_user   FOREIGN KEY (user_id)   REFERENCES users(id),
  CONSTRAINT fk_smc_series FOREIGN KEY (series_id) REFERENCES series(id)
);
CREATE INDEX idx_smc_sync ON series_message_cursors (user_id, updated_at);


-- ============================================================
-- SECTION 8: CASTS (F2)
-- ============================================================

DROP TABLE IF EXISTS cast_comments CASCADE;
DROP TABLE IF EXISTS casts         CASCADE;

CREATE TABLE casts (
  id              UUID         NOT NULL,
  calendar_id     UUID         NOT NULL,
  author_id       UUID         NOT NULL,
  title           VARCHAR(200) NOT NULL,
  summary         TEXT,
  body_markdown   TEXT,
  thumbnail_url   TEXT,
  cover_image_url TEXT,
  start_time      TIMESTAMPTZ,
  end_time        TIMESTAMPTZ,
  locations       JSONB,
  forked_from     UUID,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  PRIMARY KEY (id),
  CONSTRAINT fk_cast_cal    FOREIGN KEY (calendar_id) REFERENCES calendars(id),
  CONSTRAINT fk_cast_author FOREIGN KEY (author_id)   REFERENCES users(id),
  CONSTRAINT fk_cast_fork   FOREIGN KEY (forked_from) REFERENCES casts(id) ON DELETE SET NULL
);
CREATE INDEX idx_cast_cal_feed ON casts (calendar_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_cast_cal_time ON casts (calendar_id, start_time)
  WHERE deleted_at IS NULL AND start_time IS NOT NULL;

CREATE TABLE cast_comments (
  id         UUID        NOT NULL,
  cast_id    UUID        NOT NULL,
  user_id    UUID        NOT NULL,
  parent_id  UUID,
  content    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (id),
  CONSTRAINT fk_cc_cast   FOREIGN KEY (cast_id)   REFERENCES casts(id)          ON DELETE CASCADE,
  CONSTRAINT fk_cc_user   FOREIGN KEY (user_id)   REFERENCES users(id),
  CONSTRAINT fk_cc_parent FOREIGN KEY (parent_id) REFERENCES cast_comments(id)  ON DELETE SET NULL
);
CREATE INDEX idx_cast_comment_cast ON cast_comments (cast_id, created_at DESC)
  WHERE deleted_at IS NULL;


-- ============================================================
-- SECTION 9: POSTS (F3)
-- ============================================================

DROP TABLE IF EXISTS post_likes     CASCADE;
DROP TABLE IF EXISTS post_comments  CASCADE;
DROP TABLE IF EXISTS posts          CASCADE;

CREATE TABLE posts (
  id              UUID         NOT NULL,
  drawer_id       UUID         NOT NULL,
  author_id       UUID         NOT NULL,
  -- 0=content(SNS형) 1=announcement(공지형)
  post_type       SMALLINT     NOT NULL DEFAULT 0,
  is_public       BOOLEAN      NOT NULL DEFAULT FALSE,
  title           VARCHAR(200),
  body_markdown   TEXT         NOT NULL,
  thumbnail_url   TEXT,
  cover_image_url TEXT,
  media_urls      JSONB,
  is_pinned       BOOLEAN               DEFAULT FALSE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  PRIMARY KEY (id),
  CONSTRAINT fk_p_drawer FOREIGN KEY (drawer_id) REFERENCES drawers(id),
  CONSTRAINT fk_p_author FOREIGN KEY (author_id) REFERENCES users(id)
);
CREATE INDEX idx_p_drawer_recent ON posts (drawer_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_p_drawer_pinned ON posts (drawer_id, created_at DESC)
  WHERE is_pinned = TRUE AND deleted_at IS NULL;
CREATE INDEX idx_p_drawer_public ON posts (drawer_id, created_at DESC)
  WHERE is_public = TRUE AND deleted_at IS NULL;

CREATE TABLE post_comments (
  id         UUID        NOT NULL,
  post_id    UUID        NOT NULL,
  user_id    UUID        NOT NULL,
  parent_id  UUID,
  content    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (id),
  CONSTRAINT fk_pc_post   FOREIGN KEY (post_id)   REFERENCES posts(id)         ON DELETE CASCADE,
  CONSTRAINT fk_pc_user   FOREIGN KEY (user_id)   REFERENCES users(id),
  CONSTRAINT fk_pc_parent FOREIGN KEY (parent_id) REFERENCES post_comments(id) ON DELETE SET NULL
);
CREATE INDEX idx_pc_post ON post_comments (post_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE post_likes (
  post_id    UUID        NOT NULL,
  user_id    UUID        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id),
  CONSTRAINT fk_pl_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  CONSTRAINT fk_pl_user FOREIGN KEY (user_id) REFERENCES users(id)
);


-- ============================================================
-- SECTION 10: AUDITS & NOTIFICATIONS
-- ============================================================

DROP TABLE IF EXISTS activity_feed_cursors CASCADE;
DROP TABLE IF EXISTS reminders              CASCADE;
DROP TABLE IF EXISTS notifications          CASCADE;
DROP TABLE IF EXISTS activity_feeds         CASCADE;
DROP TABLE IF EXISTS audit_logs             CASCADE;

CREATE TABLE audit_logs (
  id          BIGINT      NOT NULL GENERATED ALWAYS AS IDENTITY,
  drawer_id   UUID,
  actor_id    UUID,
  device_uuid UUID,
  action_type VARCHAR(30) NOT NULL,
  target_type VARCHAR(30) NOT NULL,
  target_id   UUID        NOT NULL,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE audit_logs_2026 PARTITION OF audit_logs
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE audit_logs_2027 PARTITION OF audit_logs
  FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');

CREATE INDEX idx_al_drawer ON audit_logs (drawer_id);
CREATE INDEX idx_al_actor  ON audit_logs (actor_id);
CREATE INDEX idx_al_target ON audit_logs (target_type, target_id);
CREATE INDEX idx_al_device ON audit_logs (device_uuid);

CREATE TABLE activity_feeds (
  id          BIGINT      NOT NULL GENERATED ALWAYS AS IDENTITY,
  drawer_id   UUID        NOT NULL,
  actor_id    UUID,
  action_type VARCHAR(30) NOT NULL,
  target_type VARCHAR(30) NOT NULL,
  target_id   UUID        NOT NULL,
  metadata    JSONB                DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at),
  CONSTRAINT fk_af_drawer FOREIGN KEY (drawer_id) REFERENCES drawers(id),
  CONSTRAINT fk_af_actor  FOREIGN KEY (actor_id)  REFERENCES users(id)
) PARTITION BY RANGE (created_at);

CREATE TABLE activity_feeds_2026 PARTITION OF activity_feeds
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE activity_feeds_2027 PARTITION OF activity_feeds
  FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');

CREATE INDEX idx_feed_drawer_cursor ON activity_feeds (drawer_id, created_at DESC, id DESC);

CREATE TABLE activity_feed_cursors (
  user_id            UUID        NOT NULL,
  drawer_id          UUID        NOT NULL,
  last_read_feed_id  BIGINT      NOT NULL DEFAULT 0,
  last_read_feed_at  TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, drawer_id),
  CONSTRAINT fk_afc_user   FOREIGN KEY (user_id)   REFERENCES users(id),
  CONSTRAINT fk_afc_drawer FOREIGN KEY (drawer_id) REFERENCES drawers(id)
);
CREATE INDEX idx_feed_cursors_sync ON activity_feed_cursors (user_id, updated_at);

CREATE TABLE reminders (
  id             UUID        NOT NULL,
  user_id        UUID        NOT NULL,
  -- 0=event_instance 1=task_instance
  target_type    SMALLINT    NOT NULL,
  target_id      UUID        NOT NULL,
  base_time      TIMESTAMPTZ NOT NULL,
  trigger_at     TIMESTAMPTZ NOT NULL,
  trigger_offset INTERVAL,
  is_sent        BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT fk_rem_user FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_rem_trigger_pending ON reminders (trigger_at)
  WHERE is_sent = FALSE;

CREATE TABLE notifications (
  id                UUID        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  recipient_id      UUID        NOT NULL,
  sender_id         UUID,
  notification_type VARCHAR(30) NOT NULL,
  route_type        VARCHAR(30) NOT NULL,
  route_id          UUID,
  drawer_id         UUID,
  group_key         VARCHAR(100),
  title             TEXT,
  body              TEXT,
  payload           JSONB,
  is_read           BOOLEAN     NOT NULL DEFAULT FALSE,
  deleted_at        TIMESTAMPTZ,
  PRIMARY KEY (id, created_at),
  CONSTRAINT fk_noti_recipient FOREIGN KEY (recipient_id) REFERENCES users(id),
  CONSTRAINT fk_noti_sender    FOREIGN KEY (sender_id)    REFERENCES users(id),
  CONSTRAINT fk_noti_drawer    FOREIGN KEY (drawer_id)    REFERENCES drawers(id)
) PARTITION BY RANGE (created_at);

CREATE TABLE notifications_2026 PARTITION OF notifications
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE notifications_2027 PARTITION OF notifications
  FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');

CREATE INDEX idx_noti_sync             ON notifications (recipient_id, updated_at);
CREATE INDEX idx_noti_recipient_cursor ON notifications (recipient_id, is_read, created_at DESC);


-- ============================================================
-- SECTION 11: BILLING
-- ============================================================

DROP TABLE IF EXISTS user_assets           CASCADE;
DROP TABLE IF EXISTS subscription_events   CASCADE;
DROP TABLE IF EXISTS payment_receipt_logs  CASCADE;
DROP TABLE IF EXISTS user_subscriptions    CASCADE;

CREATE TABLE user_subscriptions (
  id                      UUID         NOT NULL,
  user_id                 UUID         NOT NULL,
  store_type              VARCHAR(20)  NOT NULL,
  product_id              VARCHAR(100) NOT NULL,
  -- 0=monthly 1=yearly
  billing_cycle           SMALLINT     NOT NULL DEFAULT 0,
  original_transaction_id VARCHAR(100),
  -- ACTIVE|PAST_DUE|CANCELED|EXPIRED
  status                  VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  current_period_start    TIMESTAMPTZ  NOT NULL,
  current_period_end      TIMESTAMPTZ  NOT NULL,
  grace_period_end        TIMESTAMPTZ,
  cancel_at_period_end    BOOLEAN      NOT NULL DEFAULT FALSE,
  canceled_at             TIMESTAMPTZ,
  cancel_reason           TEXT,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT fk_sub_user FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE UNIQUE INDEX uk_sub_user_active ON user_subscriptions (user_id)
  WHERE status IN ('ACTIVE', 'PAST_DUE', 'CANCELED');
CREATE UNIQUE INDEX uk_sub_ios_orig ON user_subscriptions (original_transaction_id)
  WHERE original_transaction_id IS NOT NULL;

CREATE TABLE payment_receipt_logs (
  id                      BIGINT       NOT NULL GENERATED ALWAYS AS IDENTITY,
  user_id                 UUID         NOT NULL,
  subscription_id         UUID,
  transaction_id          VARCHAR(100) NOT NULL,
  original_transaction_id VARCHAR(100) NOT NULL,
  store_type              VARCHAR(20)  NOT NULL,
  event_type              VARCHAR(50)  NOT NULL,
  raw_payload             JSONB        NOT NULL,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (transaction_id),
  CONSTRAINT fk_prl_user FOREIGN KEY (user_id)         REFERENCES users(id),
  CONSTRAINT fk_prl_sub  FOREIGN KEY (subscription_id) REFERENCES user_subscriptions(id) ON DELETE SET NULL
);

CREATE TABLE subscription_events (
  id              BIGINT   NOT NULL GENERATED ALWAYS AS IDENTITY,
  user_id         UUID     NOT NULL,
  subscription_id UUID     NOT NULL,
  -- 0=subscribed 1=renewed 2=canceled 3=expired 4=grace_start 5=reinstated 6=refunded 7=upgraded 8=downgraded 9=trial_start 10=trial_converted
  event_type      SMALLINT NOT NULL,
  from_plan_id    SMALLINT,
  to_plan_id      SMALLINT,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT fk_se_user FOREIGN KEY (user_id)         REFERENCES users(id),
  CONSTRAINT fk_se_sub  FOREIGN KEY (subscription_id) REFERENCES user_subscriptions(id)
);

CREATE TABLE user_assets (
  user_id      UUID        NOT NULL,
  asset_type   VARCHAR(20) NOT NULL,
  asset_id     VARCHAR(50) NOT NULL,
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, asset_type, asset_id),
  CONSTRAINT fk_ua_user FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_user_assets_sync ON user_assets (user_id, purchased_at);


-- ============================================================
-- END
-- ============================================================
