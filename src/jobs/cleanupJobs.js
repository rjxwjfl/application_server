/**
 * src/jobs/cleanupJobs.js
 * =========================================
 * Soft delete TTL 정리 배치 (schema.md 2026-06-11)
 *
 * 매일 04:00 KST: deleted_at < NOW() - 30일 인 행 hard delete
 *
 * 삭제 순서: FK 의존성 역순 (child → parent)
 *   1. message_reactions, message_mentions, message_embeds
 *   2. section_messages (polls/options/votes 는 ON DELETE CASCADE)
 *   3. cast_comments, post_comments (독립 soft delete 건)
 *   4. event_participants, task_participants
 *   5. event_sections, task_sections
 *   6. event_instances, task_instances
 *   7. attachments (binder 삭제 전에 처리) — binder_storage_usage는 여기서 건드리지 않는다.
 *      soft delete 시점에 이미 차감했다(F-S9). 하드 삭제에서 또 빼면 이중 차감이다.
 *      GCS 객체 삭제도 여기서 한다(F-S6 §3 · 결정 61) — mediaService.deleteAttachment는
 *      더 이상 GCS를 만지지 않는다. attachments 단계만 특수화한다(cleanupAttachments 참조).
 *   8. events, tasks, casts, posts
 *   9. sections, calendar_subscriptions, binder_members
 *  10. calendars
 *  10-1. binder_storage_usage (binder FK, binder 삭제 전 정리 — F-S9) — 이 표에서 유일하게
 *        deleted_at 자기 컬럼이 없는 집계 행이라 binders.deleted_at 기준으로 정리한다.
 *  11. binders
 * =========================================
 */

const cron = require('node-cron');
const { Storage } = require('@google-cloud/storage');
const pool = require('../../config/db');
const logger = require('../utils/logger');

const storage = new Storage();
const BUCKET = process.env.GCS_BUCKET_MEDIA || 'rally-media';

const STEPS = [
  // 0. 리마인더 발송 원장 — RLY-20260806-032. 자기 deleted_at이 없고(13컬럼 확정, schema.md
  //    §10-4) 대신 sent_at 기준으로 GC한다("일회성은 발송 후 sent_at 기록 → 30일 후 GC
  //    DELETE", SC-reminder.md:49). SpecialDay(target_type=2)는 발송 후 롤링되어 sent_at이
  //    영구 NULL이므로 이 GC 대상이 아니다(같은 tick에서 자동으로 걸러진다) — 별도 분기 불필요.
  //    다른 테이블과 FK 관계가 없어(참조하는 쪽도 참조받는 쪽도 없음) STEPS 순서 어디에 둬도
  //    무방하다 — binder_storage_usage처럼 자기 deleted_at이 없는 케이스라 custom으로 뺀다.
  { custom: 'reminders' },
  // 1. 메시지 부속 (leaf, FK no cascade)
  { table: 'message_reactions', column: 'deleted_at' },
  { table: 'message_mentions',  column: 'deleted_at' },
  { table: 'message_embeds',    column: 'deleted_at' },
  // 2. 섹션 메시지 (polls/options/votes cascade)
  { table: 'section_messages',   column: 'deleted_at' },
  // 3. 댓글 독립 soft delete 건
  { table: 'cast_comments',     column: 'deleted_at' },
  { table: 'post_comments',     column: 'deleted_at' },
  // 4. 참여자
  { table: 'event_participants', column: 'deleted_at' },
  { table: 'task_participants',  column: 'deleted_at' },
  // 5. section 연결
  { table: 'event_sections', column: 'deleted_at' },
  { table: 'task_sections',  column: 'deleted_at' },
  // 6. 인스턴스 (sub-instance cascade from parent)
  { table: 'event_instances', column: 'deleted_at' },
  { table: 'task_instances',  column: 'deleted_at' },
  // 7. 첨부 파일 (binder FK, binder 삭제 전) — GCS 객체 삭제까지 포함하는 특수 단계
  //    (F-S6 §3 · 결정 61). storage_key SELECT → 가드 → GCS 삭제 → 행 DELETE.
  { custom: 'attachments' },
  // 8. 이벤트·태스크·캐스트·포스트 (cast_comments·post_comments·post_likes cascade)
  { table: 'events', column: 'deleted_at' },
  { table: 'tasks',  column: 'deleted_at' },
  { table: 'casts',  column: 'deleted_at' },
  { table: 'posts',  column: 'deleted_at' },
  // 9. 섹션·구독·멤버 (binder FK)
  { table: 'sections',               column: 'deleted_at' },
  { table: 'calendar_subscriptions', column: 'deleted_at' },
  { table: 'binder_members',         column: 'deleted_at' },
  // 10. 캘린더
  { table: 'calendars', column: 'deleted_at' },
  // 10-1. 바인더 스토리지 사용량 집계 행 — 자기 deleted_at이 없어 일반 STEPS 패턴에 안 맞는다.
  //       binders 하드 삭제 직전에 특수 처리한다(F-S9).
  { custom: 'binder_storage_usage' },
  // 11. 바인더 (최후)
  { table: 'binders', column: 'deleted_at' },
];

/**
 * attachments 단계 전용 — 결정 61(F-S6 §3): GCS 객체 삭제를 soft delete 시점이 아니라
 * 여기(하드 삭제 시점)로 옮긴 지점. storage_key는 참조 카운트를 저장하지 않고 매번 계산한다
 * (idx_att_storage_key, F-S0) — 올리고 내릴 지점이 없어 드리프트가 원천적으로 불가능하다.
 *
 * 같은 storage_key를 이번 배치에서 함께 하드 삭제될 여러 행이 공유할 수 있다(첨부 복제, F-S6 §2).
 * 행 단위로 독립 처리하면 한 행 처리 중 물리 객체를 지운 직후, 아직 처리되지 않은 같은 배치의
 * 자매 행이 그 키를 가리킨 채 테이블에 남는 창이 생긴다 — storage_key로 묶어 그룹당 객체 삭제
 * 1회 + 행 삭제 1회(그룹 전체 동시)로 처리해 그 창을 없앤다.
 */
async function cleanupAttachments() {
  const { rows: candidates } = await pool.query(
    `SELECT id, storage_key FROM attachments
     WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days'
     ORDER BY storage_key`
  );
  if (candidates.length === 0) return 0;

  const groups = new Map(); // storage_key(또는 null) → [id, ...]
  for (const row of candidates) {
    const key = row.storage_key || null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row.id);
  }

  const bucket = storage.bucket(BUCKET);
  let deleted = 0;

  for (const [storageKey, ids] of groups) {
    if (storageKey) {
      // 가드: 이 storage_key를 가리키는, 이 그룹 밖의 활성(soft delete 안 된) 행이 있으면
      // 물리 객체를 지우지 않는다. 참조 카운트 없이 매번 이 시점에 계산한다.
      const guard = await pool.query(
        `SELECT NOT EXISTS (
           SELECT 1 FROM attachments
           WHERE storage_key = $1 AND deleted_at IS NULL AND id <> ALL($2)
         ) AS is_boundary`,
        [storageKey, ids]
      );

      if (guard.rows[0].is_boundary) {
        try {
          // 이미 지워진 객체(이전 배치 재시도·수동 정리 등)는 성공으로 취급 — 행이 영원히
          // 안 지워지는 일을 막는다.
          await bucket.file(storageKey).delete({ ignoreNotFound: true });
        } catch (err) {
          // 객체 삭제와 행 DELETE의 순서: 객체를 먼저 지우고 행을 지운다(반대로 하면 삭제
          // 실패 시 storage_key를 잃어 영원히 회수 불가능한 고아 객체가 된다). 실패 시 이
          // 그룹의 행은 이번 배치에서 건너뛰고 남긴다 — 다음 배치가 재시도한다. 배치 전체는
          // 중단시키지 않는다.
          logger.error('Cleanup: attachments GCS 객체 삭제 실패, 행 보존(다음 배치 재시도)', {
            storageKey, error: err.message,
          });
          continue;
        }
      }
      // guard가 false면(다른 활성 행이 이 키를 공유) 객체는 건드리지 않는다 — 그 활성 행이
      // 여전히 필요로 한다. 이 그룹의 행은 자신의 30일 DB 보존 기간이 지났으므로 그대로 지운다.
    }
    // storageKey가 없는 행(레거시·비정상 데이터)은 지울 객체 자체가 없다 — 행만 정리한다.

    const result = await pool.query(`DELETE FROM attachments WHERE id = ANY($1)`, [ids]);
    deleted += result.rowCount;
  }

  return deleted;
}

// RLY-20260806-032 — sent_at 기준 GC(deleted_at 기준 일반 STEPS 패턴과 다르다).
// SpecialDay 롤링 행은 sent_at이 영구 NULL이라 이 WHERE에 걸리지 않는다.
async function cleanupReminders() {
  const result = await pool.query(
    `DELETE FROM reminders WHERE sent_at IS NOT NULL AND sent_at < NOW() - INTERVAL '30 days'`
  );
  return result.rowCount;
}

async function runCleanup() {
  logger.info('Cleanup job started');
  let totalDeleted = 0;

  for (const step of STEPS) {
    const label = step.table || step.custom;
    try {
      let count;
      if (step.custom === 'reminders') {
        count = await cleanupReminders();
      } else if (step.custom === 'attachments') {
        count = await cleanupAttachments();
      } else if (step.custom === 'binder_storage_usage') {
        // binder_storage_usage는 soft delete 대상이 아닌 집계 행이다(자기 deleted_at 없음).
        // 하드 삭제 예정 binder에 딸린 행만 정리한다 — 이중 차감과 무관(F-S9는 값을 만지지 않는다,
        // 행 자체를 지운다).
        const result = await pool.query(
          `DELETE FROM binder_storage_usage
           WHERE binder_id IN (
             SELECT id FROM binders
             WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days'
           )`
        );
        count = result.rowCount;
      } else {
        const result = await pool.query(
          `DELETE FROM ${step.table}
           WHERE ${step.column} IS NOT NULL
             AND ${step.column} < NOW() - INTERVAL '30 days'`
        );
        count = result.rowCount;
      }
      if (count > 0) {
        logger.info(`Cleanup: hard deleted from ${label}`, { count });
        totalDeleted += count;
      }
    } catch (err) {
      logger.error(`Cleanup: failed on ${label}`, { error: err.message });
    }
  }

  logger.info('Cleanup job finished', { totalDeleted });
}

function startCleanupJobs() {
  // 매일 04:00 KST
  cron.schedule('0 4 * * *', runCleanup, { timezone: 'Asia/Seoul' });
  logger.info('Cleanup jobs scheduled (daily 04:00 KST)');
}

module.exports = { startCleanupJobs, runCleanup };
