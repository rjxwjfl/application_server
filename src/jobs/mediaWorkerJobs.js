/**
 * src/jobs/mediaWorkerJobs.js
 * =========================================
 * RLY-20260806-047 — media.md §4-4 Worker 파이프라인.
 *
 * 트리거: 문서는 "Cloud Pub/Sub → Cloud Function gen2"를 지정하지만, 그건 §10-13(2026-08-01
 * 확정, "이 계약은 reminder 전용이 아니다")보다 먼저(2026-06-08) 쓰인 문서다. 이 저장소엔
 * `@google-cloud/pubsub` 의존성도, `/internal/jobs/{name}` 엔드포인트도 없다(F-S7 외부 트리거
 * 이관 전) — reminderJobs.js가 정확히 같은 이유로 쓰는 것과 동일하게 node-cron 폴링 +
 * `FOR UPDATE SKIP LOCKED` claim/lease를 쓴다(team-lead 승인, 047 착수 메시지 §2a).
 *
 * status='processing' 행을 claim해 Step1~5(악성코드 스캔 제외 — 아래 참조)를 수행한다.
 *
 * ⚠️ Step2(악성코드 스캔) 미구현 — User 판정(047 착수 승인 메시지): "Step1·3·4·5를 구현하고
 * Step2는 명시적 미구현으로 남긴다." 실제 스캐너(Cloud DLP는 PII 탐지지 악성코드 스캐너가
 * 아니다 — 문서 오류로 별건 등재됨. ClamAV·VirusTotal 등은 자격증명·인프라가 필요해 이 세션
 * 범위 밖)가 없다. **이 파일은 스캔했다는 어떤 신호도 남기지 않는다** — 처리마다 로그로
 * "스캐너 미도입"을 명시한다(아래 processAttachment 참조). 스캐너가 정해지면 이 자리에
 * Step2 구현을 끼워 넣으면 된다.
 * =========================================
 */

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const cron = require('node-cron');
const { Storage } = require('@google-cloud/storage');
const pool = require('../../config/db');
const { AttachmentDAO } = require('../daos/attachmentDAO');
const { generateUUID } = require('../utils/uuid');
const logger = require('../utils/logger');
const eventBus = require('../events/eventBus');
const {
  detectActualMimeType, stripExif, generateImageThumbnail, generateVideoPoster,
} = require('../utils/mediaPipeline');

const storage = new Storage();
const MEDIA_BUCKET = process.env.GCS_BUCKET_MEDIA || 'rally-media';
const CDN_BUCKET = process.env.GCS_BUCKET_CDN || 'rally-cdn';
const CDN_BASE_URL = process.env.CDN_BASE_URL || 'https://cdn.rallyapp.io';

// reminderJobs.js(BATCH_LIMIT=500)보다 훨씬 작게 잡는다 — 리마인더는 DB 갱신 + FCM 호출뿐이지만
// 이 워커는 매 건마다 GCS 다운로드(최대 5GB, §3-1)·sharp/ffmpeg 처리·GCS 업로드가 들어간다.
// 판단 근거 문서 없음(Writer 판단) — 047 보고서에 명시.
const BATCH_LIMIT = 20;
const LEASE_MINUTES = 5; // reminderJobs.js와 동일 근거(schema.md claim_token 주석).
const MAX_ATTEMPTS = 5; // 동일.

// Step3·4(콘텐츠 처리 자체)의 결정적 실패 — 재시도해도 같은 결과다(손상된 파일 등).
// 재시도 대상인 일시적 실패(GCS 네트워크 등)와 구분하기 위한 표식.
class MediaProcessingError extends Error {}

function backoffMinutes(attemptCount) {
  return Math.min(2 ** (attemptCount - 1), 16);
}

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rally-media-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function rejectAttachment(attachment, claimToken, file, reason) {
  const rejected = await AttachmentDAO.markRejected(pool, attachment.id, claimToken);
  if (!rejected) {
    logger.warn('Media worker: markRejected skipped — claim stolen by another worker (stale lease)', { attachmentId: attachment.id });
    return;
  }
  try {
    await file.delete({ ignoreNotFound: true });
  } catch (err) {
    logger.warn('Media worker: GCS object delete failed after rejection', { attachmentId: attachment.id, error: err.message });
  }
  // F-S9 — confirm()이 이미 이 파일의 바이트를 binder_storage_usage에 반영했다(034/047 이전엔
  // confirm 이후 거부라는 경로 자체가 없어서 이 문제가 존재하지 않았다 — Worker가 사후 거부를
  // 새로 도입하며 생긴 지점). GCS 객체를 지웠으니 quota도 반환한다 — deleteAttachment(§8-1)와
  // 동일한 sign=-1 패턴을 그대로 재사용한다(applyStorageDelta는 이미 양방향으로 설계돼 있다,
  // 새 구조 아님).
  await AttachmentDAO.applyStorageDelta(pool, {
    binderId: attachment.binder_id,
    storageKey: attachment.storage_key,
    fileSize: attachment.file_size,
    attachmentId: attachment.id,
    sign: -1,
  });
  eventBus.emit('ws:broadcast', {
    binder_id: attachment.binder_id,
    type: 'attachment_rejected',
    payload: { attachment_id: attachment.id, reason },
  });
  logger.warn('Media worker: attachment rejected', { attachmentId: attachment.id, reason });
}

// media.md §4-4 Step1~5. 실패하면 throw — 호출부(dispatchOne)가 재시도/종결을 판정한다.
async function processAttachment(attachment, claimToken) {
  await withTempDir(async (dir) => {
    const originalPath = path.join(dir, 'original');
    const bucket = storage.bucket(MEDIA_BUCKET);
    const file = bucket.file(attachment.storage_key);

    await file.download({ destination: originalPath });
    let buffer = await fs.readFile(originalPath);

    // [Step 1] MIME 위변조 검사 (media.md:221-228)
    const detectedMime = await detectActualMimeType(buffer);
    if (detectedMime && detectedMime !== attachment.content_type) {
      await rejectAttachment(attachment, claimToken, file, 'MIME_MISMATCH');
      return;
    }
    if (!detectedMime) {
      // 매직 바이트가 없는 포맷(일부 텍스트·문서)은 위조를 증명할 근거가 없다 — 문서에 이
      // 경우의 명시가 없어 직접 정한 해석(047 보고서 참조): 거부하지 않고 진행한다.
      logger.warn('Media worker: Step1 MIME undetectable — no forgery evidence, proceeding', {
        attachmentId: attachment.id, declaredType: attachment.content_type,
      });
    }

    // [Step 2] 악성코드 스캔 — 미구현. 파일 상단 주석 참조. 통과 신호를 남기지 않는다.
    logger.warn('Media worker: Step2 malware scan NOT IMPLEMENTED for this attachment — no scanner configured (see media.md §4-4 Step2, RLY-20260806-047 report). This file was not scanned.', {
      attachmentId: attachment.id,
    });

    const effectiveMime = detectedMime || attachment.content_type;

    // [Step 3] EXIF 파기 (이미지만, media.md:239-242)
    let exifStripped = false;
    if (effectiveMime && effectiveMime.startsWith('image/')) {
      try {
        const result = stripExif(buffer, effectiveMime);
        if (result.applied) {
          buffer = result.buffer;
          exifStripped = true;
        } else {
          logger.warn('Media worker: Step3 EXIF strip skipped — unsupported image format, original left unchanged', {
            attachmentId: attachment.id, reason: result.reason,
          });
        }
      } catch (err) {
        throw new MediaProcessingError(`Step3 EXIF strip failed: ${err.message}`);
      }
    }

    if (exifStripped) {
      // media.md:242 "EXIF 제거된 파일을 동일 storage_key에 덮어쓰기"
      await file.save(buffer, { contentType: attachment.content_type, resumable: false });
      await fs.writeFile(originalPath, buffer); // Step4가 로컬 파일(비디오 포스터용 등)을 다시 쓸 수 있게 갱신.
    }

    // [Step 4] 파생 미디어 생성 (media.md:244-294 — SECTION_MESSAGE|EVENT|TASK|POST|CAST 분기만
    // 다룬다. avatar·cover 분기는 이 코드베이스의 attachments 테이블에 행 자체가 생기지 않아
    // — mediaService.presign()이 avatar/cover는 INSERT를 건너뛴다 — claim 대상이 될 수 없다.
    // 사전 존재 결함이라 이 Task 범위에서 다루지 않는다. 047 보고서에 명시.)
    let thumbnailUrl = null;
    const cdnBucket = storage.bucket(CDN_BUCKET);

    if (effectiveMime && effectiveMime.startsWith('image/')) {
      let thumbBuffer;
      try {
        thumbBuffer = await generateImageThumbnail(buffer);
      } catch (err) {
        throw new MediaProcessingError(`Step4 thumbnail generation failed: ${err.message}`);
      }
      const derivativeKey = `derivatives/${attachment.id}/thumb.webp`;
      await cdnBucket.file(derivativeKey).save(thumbBuffer, { contentType: 'image/webp', resumable: false });
      thumbnailUrl = `${CDN_BASE_URL}/${derivativeKey}`;
    } else if (effectiveMime && effectiveMime.startsWith('video/')) {
      const posterPath = path.join(dir, 'poster.webp');
      try {
        await generateVideoPoster(originalPath, posterPath);
      } catch (err) {
        throw new MediaProcessingError(`Step4 poster generation failed: ${err.message}`);
      }
      const posterBuffer = await fs.readFile(posterPath);
      const derivativeKey = `derivatives/${attachment.id}/poster.webp`;
      await cdnBucket.file(derivativeKey).save(posterBuffer, { contentType: 'image/webp', resumable: false });
      thumbnailUrl = `${CDN_BASE_URL}/${derivativeKey}`;
    }
    // 오디오·문서·기타: 파생 미디어 없음(media.md:252) — thumbnailUrl은 null로 유지.

    // [Step 5] DB 갱신 + 알림 (media.md:272-280)
    const applied = await AttachmentDAO.markReady(pool, attachment.id, claimToken, thumbnailUrl);
    if (!applied) {
      logger.warn('Media worker: markReady skipped — claim stolen by another worker (stale lease)', { attachmentId: attachment.id });
      return;
    }
    eventBus.emit('ws:broadcast', {
      binder_id: attachment.binder_id,
      type: 'attachment_ready',
      payload: { attachment_id: attachment.id, thumbnail_url: thumbnailUrl },
    });
  });
}

async function retryOrError(attachment, claimToken, error) {
  // 콘텐츠 처리 자체의 결정적 실패는 재시도하지 않는다(손상된 파일은 다시 시도해도 손상돼
  // 있다) — attachments의 기존 'error' 정의(media.md:186 "업로드·처리의 기술적 실패")를
  // 그대로 쓴다(team-lead 승인).
  if (error instanceof MediaProcessingError || attachment.attempt_count >= MAX_ATTEMPTS) {
    logger.error('Media worker: giving up (unrecoverable content error or max attempts)', {
      attachmentId: attachment.id, attemptCount: attachment.attempt_count, error: error?.message,
    });
    await AttachmentDAO.markError(pool, attachment.id, claimToken);
    return;
  }
  // 그 외(GCS 네트워크 등 일시적 실패)는 지수 백오프로 재시도한다(reminderJobs.js와 동일 패턴).
  const nextAttemptAt = new Date(Date.now() + backoffMinutes(attachment.attempt_count) * 60 * 1000);
  logger.error('Media worker: processing failed, will retry', {
    attachmentId: attachment.id, attemptCount: attachment.attempt_count,
    nextAttemptAt: nextAttemptAt.toISOString(), error: error?.message,
  });
  await AttachmentDAO.markFailed(pool, attachment.id, claimToken, nextAttemptAt);
}

async function dispatchOne(attachment, claimToken) {
  try {
    await processAttachment(attachment, claimToken);
  } catch (err) {
    await retryOrError(attachment, claimToken, err);
  }
}

async function dispatchMediaWorker() {
  const claimToken = generateUUID();
  try {
    const claimed = await AttachmentDAO.claimProcessingBatch(pool, {
      claimToken, limit: BATCH_LIMIT, leaseMinutes: LEASE_MINUTES, maxAttempts: MAX_ATTEMPTS,
    });
    if (claimed.length === 0) return;

    logger.info('Media worker tick', { claimed: claimed.length });
    for (const attachment of claimed) {
      // eslint-disable-next-line no-await-in-loop
      await dispatchOne(attachment, claimToken);
    }
  } catch (err) {
    logger.error('Media worker tick failed', { error: err.message });
  }
}

function startMediaWorkerJobs() {
  cron.schedule('* * * * *', dispatchMediaWorker);
  logger.info('Media worker jobs scheduled (every 1 minute)');
}

module.exports = {
  startMediaWorkerJobs,
  dispatchMediaWorker,
  dispatchOne,
  processAttachment,
  backoffMinutes,
  MediaProcessingError,
};
