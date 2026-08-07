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
  // 0-1. RLY-20260806-173 — notifications는 연도별 파티션(PARTITION BY RANGE(created_at),
  //      notifications_2026/2027/2028, config/schema.sql:1035-1041)인데 cleanupJobs.js
  //      정리 대상에 아예 없었다 — soft delete(NotificationDAO.softDelete)로 deleted_at만
  //      찍히고 행이 영구히 남아 있었다(Architect 확인). User 판정: 보관 1년.
  //      ⚠️ 이 표는 다른 STEPS 항목처럼 "행 단위 DELETE"를 쓰지 않는다 — 파티션 테이블에서
  //      대량 DELETE는 vacuum 부담·lock을 만든다. 대신 1년보다 완전히 지난 연도 파티션을
  //      통째로 DROP한다(행 스캔 0). 자기 deleted_at 유무와 무관하게 파티션 전체가
  //      사라진다 — 파티션 키가 created_at이라 deleted_at 기준으로 부분 DROP은 애초에
  //      불가능하다(제거 대상을 고르는 게 아니라 "그 해에 만들어진 알림 전체"가 단위다).
  //      other STEPS 항목의 "삭제(soft) 후 30일" 관행과 보존 의미가 다르다는 뜻을 그대로
  //      드러낸다 — 유저가 개별로 지운 적 없는 활성 알림도 1년이 지나면 함께 사라진다.
  { custom: 'notification_partitions' },
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

// RLY-20260806-173 — notifications(연도별 파티션) 1년 보관. 행 단위 DELETE 대신 완전히
// 지난 연도 파티션을 DROP TABLE로 통째로 없앤다.
//
// 파티션 목록은 하드코딩하지 않는다 — pg_inherits로 notifications의 실제 자식 파티션을
// 조회해 이름(`notifications_YYYY`)에서 연도를 뽑는다. 스키마에 파티션이 추가·삭제돼도
// 이 코드를 다시 손댈 필요가 없다. 이름이 그 패턴과 안 맞는 자식은(예상 못한 파티션) 건드리지
// 않고 건너뛴다 — 방어적으로 남긴다.
//
// ⚠️ 경계 판단 — "1년 지난 연도 파티션"을 정확히 어떤 연도까지로 볼 것인가:
// notifications_Y 파티션은 [Y-01-01, (Y+1)-01-01) 범위를 담는다. 이 파티션에 있을 수 있는
// "가장 최근" 행은 (Y+1)-01-01 바로 직전에 생성됐을 수 있다. 그 행조차 1년이 지났다고
// 확신하려면 지금 시각이 최소 (Y+1)-01-01 + 1년 = (Y+2)-01-01 이어야 한다 — 즉
// `EXTRACT(YEAR FROM NOW()) >= Y + 2`(= `Y <= 현재 연도 - 2`)일 때만 그 파티션 전체를
// 지운다. 이 기준을 만족하면 파티션 안의 어떤 행도(연초에 만들어졌든 연말에 만들어졌든)
// 최소 1년은 보존된 뒤에만 지워진다 — "방금 만든 알림이 지워지는" 경계 사고가 파티션
// 단위 granularity로는 구조적으로 불가능하다(현재 연도·직전 연도 파티션은 이 조건을
// 만족할 수 없어 이 로직이 절대 건드리지 않는다).
//
// deleted_at은 이 판단에 관여하지 않는다 — 파티션 키가 created_at이라 deleted_at 기준
// 부분 DROP은 애초에 불가능하다(위 STEPS 주석 참조).
async function cleanupNotificationPartitions() {
  const { rows: children } = await pool.query(`
    SELECT child.relname
    FROM pg_inherits
    JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
    JOIN pg_class child  ON pg_inherits.inhrelid  = child.oid
    WHERE parent.relname = 'notifications'
  `);
  if (children.length === 0) return 0;

  const { rows: nowRows } = await pool.query(`SELECT EXTRACT(YEAR FROM NOW())::int AS year`);
  const currentYear = nowRows[0].year;

  let dropped = 0;
  for (const { relname } of children) {
    const match = /^notifications_(\d{4})$/.exec(relname);
    if (!match) continue; // 예상 패턴과 다른 자식은 건드리지 않는다(방어적).
    const partitionYear = parseInt(match[1], 10);
    if (partitionYear + 2 > currentYear) continue; // 아직 1년 보존 기간이 안 지났다.

    // relname은 DB(pg_class)에서 직접 얻었고 위 정규식으로 검증했다 — 임의 문자열 삽입이 아니다.
    await pool.query(`DROP TABLE IF EXISTS ${relname}`);
    logger.info(`Cleanup: dropped notifications partition (1년 보관 경과)`, { partition: relname });
    dropped += 1;
  }
  return dropped;
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
      } else if (step.custom === 'notification_partitions') {
        count = await cleanupNotificationPartitions();
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

// cleanupNotificationPartitions — RLY-20260806-173 회귀(notificationPartitionRetentionRegression.test.js)가
// 직접 구동하기 위해 export한다(다른 STEPS의 개별 cleanup*는 export 안 함 — 이 함수만 첫
// 전용 회귀 파일의 대상이라 필요했다).
module.exports = { startCleanupJobs, runCleanup, cleanupNotificationPartitions };
