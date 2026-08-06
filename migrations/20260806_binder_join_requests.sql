-- RLY-20260806-024 — binder_join_requests 이식 + 승인제 가입 신청을 스펙 계약으로 전환.
--
-- RLY-20260806-018이 승인 대기를 binder_members.role = -1 sentinel로 표시해 우회를 막았으나,
-- 스펙(schema.md:234-256, api.md:446-513)은 별도 상태 머신 테이블을 요구한다. 대기자가
-- binder_members에 전혀 들어가지 않게 되어 role >= 0 방어 필터(13곳, RLY-20260806-018)는 이제
-- 구조적으로 no-op이지만, CHECK 제약이 없던 role 컬럼의 유일한 방어선이었으므로 삭제하지 않는다
-- (RLY-20260806-023이 그 필터들에 회귀 커버리지를 붙이는 중이라 정면 충돌한다).
--
-- 대신 sentinel이 소멸한 지금 DB 레벨에서 음수 role을 원천 차단한다: binder_members.role에
-- CHECK (BETWEEN 0 AND 3)을 건다. 기존 데이터에 범위 밖 값(과거 role=-1 pending sentinel 등)이
-- 남아 있으면 제약 추가가 실패하므로, 먼저 확인해 남아있으면 예외를 던진다 — 자동 정리(그 pending
-- sentinel을 binder_join_requests로 백필하는 등)는 이 migration의 범위가 아니다. 남아 있다면
-- 배포 전에 수동으로 처리한다.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM binder_members
    WHERE role NOT BETWEEN 0 AND 3
  ) THEN
    RAISE EXCEPTION
      'cannot add chk_bm_role: binder_members has rows with role outside 0..3 (e.g. leftover role=-1 pending sentinels) — resolve manually before migrating';
  END IF;
END
$$;

-- 공개 binder 참가 신청 (D6, 2026-07-15) — require_approval=true binder 대상 (schema.md:234-256)
CREATE TABLE binder_join_requests (
  id            UUID        NOT NULL DEFAULT gen_random_uuid(),
  binder_id     UUID        NOT NULL,
  requester_id  UUID        NOT NULL,
  -- PENDING|APPROVED|REJECTED|CANCELLED|BLOCKED
  status        TEXT        NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED','BLOCKED')),
  decided_by    UUID,
  decided_at    TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '30 days',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT fk_bjr_binder    FOREIGN KEY (binder_id)    REFERENCES binders(id) ON DELETE CASCADE,
  CONSTRAINT fk_bjr_requester FOREIGN KEY (requester_id) REFERENCES users(id)   ON DELETE CASCADE,
  CONSTRAINT fk_bjr_decider   FOREIGN KEY (decided_by)   REFERENCES users(id)
);
-- 동일 유저 동시 복수 PENDING 금지 (부분 유니크 인덱스 — 인라인 CONSTRAINT ... WHERE 불가)
CREATE UNIQUE INDEX uq_bjr_pending ON binder_join_requests (binder_id, requester_id)
  WHERE status = 'PENDING';
-- 차단 이력 전용 인덱스: BLOCKED 유저 재신청 O(1) 확인
CREATE INDEX idx_bjr_blocked ON binder_join_requests (binder_id, requester_id)
  WHERE status = 'BLOCKED';

ALTER TABLE binder_members ADD CONSTRAINT chk_bm_role CHECK (role BETWEEN 0 AND 3);
