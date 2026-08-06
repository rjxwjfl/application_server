-- RLY-20260806-080 (S1) — 아바타·커버를 첨부와 동일한 검사 경로로 통합.
--
-- User 판정 2026-08-07: 아바타·커버는 attachments 행 없이 별도 GCS 경로로 올라가
-- Worker(MIME 위변조 검사·EXIF 파기·파생 생성)에 도달 자체를 하지 않았다 — 실제로
-- application/octet-stream으로 선언한 GIF가 이미지 허용 목록 검사를 우회해 영구 저장되는
-- 것이 확인됐다(media.md §3-3-1). 상태(재시도·점유·거부 종결·회수)가 전부 attachments
-- 행에 붙어 있어 행 없이는 검사가 성립하지 않는다 — 그래서 아바타·커버도 attachments
-- 행을 만들고 presign → confirm → Worker를 그대로 통과하게 한다.
--
-- 이 migration은 스키마만 바꾼다(S1) — presign·Worker·DAO 로직은 후속 Task(S2~S4)다.
--
-- 1) context_type CHECK를 9종으로 확장(기존 6종 + USER_AVATAR·BINDER_AVATAR·CAST_COVER).
--    기존 데이터는 전부 6종 중 하나이므로 CHECK 위반 없이 안전하게 대체 가능하다.
-- 2) binder_id NOT NULL 해제 — USER_AVATAR에는 귀속 바인더가 없다(유저 개인 파일).
--    기존 행은 전부 binder_id가 채워져 있어(현재 NOT NULL) 이 완화 자체가 데이터를
--    깨뜨리지 않는다.
-- 3) chk_att_binder_scope — USER_AVATAR만 binder_id NULL을 허용, 그 외 8종은 필수로
--    되돌려 막는다. 기존 데이터에 USER_AVATAR 행이 없으므로(방금 CHECK로 처음 허용)
--    이 제약도 즉시 통과한다.
-- 4) chk_att_entity_target — 엔티티 이미지 3종은 context_id(대상 엔티티 PK)가 항상 있어야
--    한다(pre-upload 개념이 없다). 같은 이유로 기존 데이터와 충돌하지 않는다.
--
-- ⚠️ (context_type, context_id) 유일 인덱스는 걸지 않는다 — 걸면 교체(새 파일이 검사를
-- 통과할 때까지 이전 파일이 살아있어야 하는 것)가 불가능해진다(media.md §3-3-1). 이 문장을
-- 지우지 말 것 — 지우면 다음 사람이 "1:1인데 왜 유일 제약이 없지?" 하고 다시 넣는다.
--
-- 전체를 한 트랜잭션으로 묶는다 — 실측 확인(Docker Postgres 16): `psql -f`는 기본적으로
-- ON_ERROR_STOP이 꺼져 있어 문장 하나가 실패해도 다음 문장을 계속 실행한다. BEGIN/COMMIT
-- 없이는 중간에 실패할 경우 절반만 적용된 스키마가 남을 수 있다 — 이 트랜잭션으로 전부
-- 적용되거나 전부 롤백되거나 둘 중 하나만 가능하게 만든다.
BEGIN;

ALTER TABLE attachments DROP CONSTRAINT IF EXISTS chk_att_context;
ALTER TABLE attachments ADD CONSTRAINT chk_att_context CHECK (context_type IN (
  'SECTION_MESSAGE','EVENT','TASK','POST','CAST','SPECIAL_DAY',
  'USER_AVATAR','BINDER_AVATAR','CAST_COVER'));

ALTER TABLE attachments ALTER COLUMN binder_id DROP NOT NULL;

ALTER TABLE attachments ADD CONSTRAINT chk_att_binder_scope
  CHECK (context_type = 'USER_AVATAR' OR binder_id IS NOT NULL);

ALTER TABLE attachments ADD CONSTRAINT chk_att_entity_target CHECK (
  context_type NOT IN ('USER_AVATAR','BINDER_AVATAR','CAST_COVER') OR context_id IS NOT NULL);

-- 레거시 아바타·커버 값 일괄 초기화 — 출시 전이라 backfill 없이 비운다. 기존 값은 이번에
-- 신설되는 검사 경로(attachments 행)를 거친 적이 없어 그 참조가 가리키는 GCS 객체가
-- 검사받지 않은 상태로 남는다 — 새 경로로 다시 올리게 한다(S2~S4에서 presign/Worker가
-- 배선된 뒤). image_url·thumbnail_url이 이미 둘 다 NULL인 행은 건드리지 않는다
-- (불필요한 updated_at 처리 방지).
UPDATE user_infos
  SET image_url = NULL, thumbnail_url = NULL, updated_at = now()
  WHERE image_url IS NOT NULL OR thumbnail_url IS NOT NULL;

UPDATE binders
  SET image_url = NULL, thumbnail_url = NULL, updated_at = now()
  WHERE image_url IS NOT NULL OR thumbnail_url IS NOT NULL;

UPDATE casts
  SET cover_image_url = NULL, thumbnail_url = NULL, updated_at = now()
  WHERE cover_image_url IS NOT NULL OR thumbnail_url IS NOT NULL;

COMMIT;
