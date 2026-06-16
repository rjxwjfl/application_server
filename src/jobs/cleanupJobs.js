/**
 * src/jobs/cleanupJobs.js
 * =========================================
 * Soft delete TTL 정리 배치 (schema.md 2026-06-11)
 *
 * 매일 04:00 KST: deleted_at < NOW() - 30일 인 행 hard delete
 *
 * 삭제 순서: FK 의존성 역순 (child → parent)
 *   1. message_reactions, message_mentions, message_embeds
 *   2. series_messages (polls/options/votes 는 ON DELETE CASCADE)
 *   3. cast_comments, post_comments (독립 soft delete 건)
 *   4. event_participants, task_participants
 *   5. event_series, task_series
 *   6. event_instances, task_instances
 *   7. attachments (drawer 삭제 전에 처리)
 *   8. events, tasks, casts, posts
 *   9. series, calendar_subscriptions, drawer_members
 *  10. calendars
 *  11. drawers
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
  // 2. 시리즈 메시지 (polls/options/votes cascade)
  { table: 'series_messages',   column: 'deleted_at' },
  // 3. 댓글 독립 soft delete 건
  { table: 'cast_comments',     column: 'deleted_at' },
  { table: 'post_comments',     column: 'deleted_at' },
  // 4. 참여자
  { table: 'event_participants', column: 'deleted_at' },
  { table: 'task_participants',  column: 'deleted_at' },
  // 5. series 연결
  { table: 'event_series', column: 'deleted_at' },
  { table: 'task_series',  column: 'deleted_at' },
  // 6. 인스턴스 (sub-instance cascade from parent)
  { table: 'event_instances', column: 'deleted_at' },
  { table: 'task_instances',  column: 'deleted_at' },
  // 7. 첨부 파일 (drawer FK, drawer 삭제 전)
  { table: 'attachments', column: 'deleted_at' },
  // 8. 이벤트·태스크·캐스트·포스트 (cast_comments·post_comments·post_likes cascade)
  { table: 'events', column: 'deleted_at' },
  { table: 'tasks',  column: 'deleted_at' },
  { table: 'casts',  column: 'deleted_at' },
  { table: 'posts',  column: 'deleted_at' },
  // 9. 시리즈·구독·멤버 (drawer FK)
  { table: 'series',                column: 'deleted_at' },
  { table: 'calendar_subscriptions', column: 'deleted_at' },
  { table: 'drawer_members',         column: 'deleted_at' },
  // 10. 캘린더
  { table: 'calendars', column: 'deleted_at' },
  // 11. 드로어 (최후)
  { table: 'drawers', column: 'deleted_at' },
];

async function runCleanup() {
  logger.info('Cleanup job started');
  let totalDeleted = 0;

  for (const { table, column } of STEPS) {
    try {
      const result = await pool.query(
        `DELETE FROM ${table}
         WHERE ${column} IS NOT NULL
           AND ${column} < NOW() - INTERVAL '30 days'`
      );
      const count = result.rowCount;
      if (count > 0) {
        logger.info(`Cleanup: hard deleted from ${table}`, { count });
        totalDeleted += count;
      }
    } catch (err) {
      logger.error(`Cleanup: failed on ${table}`, { error: err.message });
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
