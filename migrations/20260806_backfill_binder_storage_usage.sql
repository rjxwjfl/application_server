-- F-S9 — binder_storage_usage 최초 백필.
--
-- binder_storage_usage(schema.md:284-289)는 이 배포 전까지 서버 코드 참조 0건이었다
-- (task-packets-fork-20260803.md F-S9). 이 배포부터는 confirm/soft-delete 시점 증분 갱신으로
-- 유지되지만, 배포 이전에 이미 존재하는 첨부는 그 증분 경로를 타지 않았으므로 값이 비어 있다.
-- 값이 비어 있으면 402 한도 집행이 기존 데이터에 대해 무력하다 — 이 마이그레이션이 §2 집계
-- 쿼리(대조·복구용, task-packets-fork-20260803.md F-S9 §2)로 최초 1회 채운다.
--
-- storage_key 단위 DISTINCT — 결정 56: 같은 binder_id 안에서 storage_key를 공유하는 행은
-- 물리 객체 하나이므로 한 번만 센다.
INSERT INTO binder_storage_usage (binder_id, bytes_used, updated_at)
SELECT binder_id, SUM(file_size), now()
FROM (
  SELECT DISTINCT ON (binder_id, storage_key) binder_id, storage_key, file_size
  FROM attachments
  WHERE deleted_at IS NULL AND storage_key IS NOT NULL
  ORDER BY binder_id, storage_key
) t
GROUP BY binder_id
ON CONFLICT (binder_id) DO UPDATE
  SET bytes_used = EXCLUDED.bytes_used,
      updated_at = now();
