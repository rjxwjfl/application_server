-- RLY-20260806-080 (S1) 롤백.
--
-- ⚠️ user_infos·binders·casts의 아바타·커버 값을 NULL로 비운 부분(up migration 하단)은
-- 복구할 수 없다 — 원래 값을 어디에도 보존하지 않았다(출시 전 backfill 없이 비운다는
-- 판정 자체가 "복구 불필요"를 전제한다). 이 down은 스키마(제약·컬럼)만 되돌린다.
--
-- 전체를 한 트랜잭션으로 묶는다 — 실측 확인(Docker Postgres 16): BEGIN/COMMIT 없이 아래
-- 가드(DO 블록)가 RAISE EXCEPTION을 던져도 psql은 그 문장 하나만 실패시키고 다음 ALTER
-- TABLE 문을 계속 실행한다(각 최상위 문장이 독립된 암묵적 트랜잭션이라 서로를 막지 못한다).
-- 그 결과 chk_att_entity_target·chk_att_binder_scope는 지워졌는데 binder_id NOT NULL·
-- chk_att_context(6종)는 복원되지 않는 반쪽 상태가 실제로 재현됐다. BEGIN으로 묶으면 가드가
-- 실패하는 순간 트랜잭션이 abort 상태가 되어 이후 문장은 전부 무시되고, COMMIT 시점에
-- 자동으로 롤백된다 — 전부 적용되거나 전부 롤백되거나 둘 중 하나만 가능해진다.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM attachments
    WHERE context_type IN ('USER_AVATAR','BINDER_AVATAR','CAST_COVER')
  ) THEN
    RAISE EXCEPTION
      'cannot roll back chk_att_context: attachments has rows with USER_AVATAR/BINDER_AVATAR/CAST_COVER — resolve manually before rolling back (S2 presign 배선 이후엔 정상적으로 이 값들이 생긴다)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM attachments WHERE binder_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'cannot roll back binder_id NOT NULL: attachments has rows with binder_id IS NULL (USER_AVATAR rows) — resolve manually before rolling back';
  END IF;
END
$$;

ALTER TABLE attachments DROP CONSTRAINT IF EXISTS chk_att_entity_target;
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS chk_att_binder_scope;

ALTER TABLE attachments ALTER COLUMN binder_id SET NOT NULL;

ALTER TABLE attachments DROP CONSTRAINT IF EXISTS chk_att_context;
ALTER TABLE attachments ADD CONSTRAINT chk_att_context
  CHECK (context_type IN ('SECTION_MESSAGE','EVENT','TASK','POST','CAST','SPECIAL_DAY'));

COMMIT;
