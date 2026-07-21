/**
 * src/jobs/mediaLifecycleJobs.js
 * =========================================
 * 첨부 파일 GCS 생명주기 배치
 *
 * 6-2. 매일 새벽 03:00 — Free tier 365일 경과 파일 숨김 전환
 *      status: ready → hidden, hidden_at = NOW()
 *
 * 6-3. 매일 새벽 03:30 — GCS Storage Class 단계적 전환
 *      standard → nearline (숨김 후 1일 안전 마진)
 *      nearline  → coldline  (숨김 후 30일)
 *      coldline  → archive   (숨김 후 120일)
 * =========================================
 */

const { Storage } = require('@google-cloud/storage');
const { AttachmentDAO } = require('../daos/attachmentDAO');
const pool = require('../../config/db');
const logger = require('../utils/logger');
const eventBus = require('../events/eventBus');

const storage = new Storage();
const BUCKET = process.env.GCS_BUCKET_MEDIA || 'rally-media';

// ──────────────────────────────────────────
// 6-2. 숨김 전환 (매일 03:00)
// ──────────────────────────────────────────
async function hideExpiredAttachments() {
  try {
    const rows = await AttachmentDAO.findExpiredFreeAttachments(pool);
    if (rows.length === 0) return;

    const ids = rows.map((r) => r.id);
    const count = await AttachmentDAO.markHidden(pool, ids);
    logger.info('Lifecycle: attachments hidden', { count });

    // 바인더별 집계 후 WebSocket 알림 (binder_files_hidden)
    const byBinder = rows.reduce((acc, r) => {
      acc[r.binder_id] = (acc[r.binder_id] || 0) + 1;
      return acc;
    }, {});
    for (const [binder_id, hiddenCount] of Object.entries(byBinder)) {
      eventBus.emit('ws:broadcast', {
        binder_id,
        type: 'binder_files_hidden',
        payload: { binder_id, count: hiddenCount },
      });
    }
  } catch (err) {
    logger.error('Lifecycle hideExpiredAttachments failed', { error: err.message });
  }
}

// ──────────────────────────────────────────
// 6-3. GCS Storage Class 전환 (매일 03:30)
// ──────────────────────────────────────────
const TRANSITIONS = [
  { from: 'standard', to: 'NEARLINE',  interval: '1 day' },
  { from: 'nearline',  to: 'COLDLINE',  interval: '30 days' },
  { from: 'coldline',  to: 'ARCHIVE',   interval: '120 days' },
];

async function transitionStorageClasses() {
  const bucket = storage.bucket(BUCKET);

  for (const { from, to, interval } of TRANSITIONS) {
    try {
      const rows = await AttachmentDAO.findByStorageClassForTransition(pool, from, interval);
      if (rows.length === 0) continue;

      // GCS copy-in-place with new storage class (rewrite)
      const results = await Promise.allSettled(
        rows.map(({ storage_key }) =>
          bucket.file(storage_key).copy(bucket.file(storage_key), { storageClass: to })
        )
      );

      const succeeded = rows
        .filter((_, i) => results[i].status === 'fulfilled')
        .map((r) => r.id);

      if (succeeded.length > 0) {
        await AttachmentDAO.markStorageClass(pool, succeeded, to.toLowerCase());
        logger.info(`Lifecycle: ${from} → ${to.toLowerCase()}`, { count: succeeded.length });
      }

      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        logger.warn(`Lifecycle: ${from} → ${to.toLowerCase()} partial failure`, { failed });
      }
    } catch (err) {
      logger.error(`Lifecycle transitionStorageClasses ${from}→${to} failed`, { error: err.message });
    }
  }
}

// ──────────────────────────────────────────
// 스케줄러 등록
// ──────────────────────────────────────────
function startMediaLifecycleJobs() {
  // node-cron 사용 (subscriptionJobs.js 패턴 동일)
  const cron = require('node-cron');

  // 매일 03:00 — 숨김 전환
  cron.schedule('0 3 * * *', hideExpiredAttachments, { timezone: 'Asia/Seoul' });

  // 매일 03:30 — GCS 클래스 전환
  cron.schedule('30 3 * * *', transitionStorageClasses, { timezone: 'Asia/Seoul' });

  logger.info('Media lifecycle jobs scheduled (03:00, 03:30 KST)');
}

module.exports = { startMediaLifecycleJobs };
