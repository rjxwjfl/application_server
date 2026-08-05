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
 *   8. events, tasks, casts, posts
 *   9. sections, calendar_subscriptions, binder_members
 *  10. calendars
 *  10-1. binder_storage_usage (binder FK, binder 삭제 전 정리 — F-S9) — 이 표에서 유일하게
 *        deleted_at 자기 컬럼이 없는 집계 행이라 binders.deleted_at 기준으로 정리한다.
 *  11. binders
 * =========================================
 */

const cron = require('node-cron');
const pool = require('../../config/db');
const logger = require('../utils/logger');

const STEPS = [
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
  // 7. 첨부 파일 (binder FK, binder 삭제 전)
  { table: 'attachments', column: 'deleted_at' },
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

async function runCleanup() {
  logger.info('Cleanup job started');
  let totalDeleted = 0;

  for (const step of STEPS) {
    const label = step.table || step.custom;
    try {
      let count;
      if (step.custom === 'binder_storage_usage') {
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
