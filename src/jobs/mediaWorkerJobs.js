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
const withTransaction = require('../core/withTransaction');
const { AttachmentDAO } = require('../daos/attachmentDAO');
const { generateUUID } = require('../utils/uuid');
const logger = require('../utils/logger');
const eventBus = require('../events/eventBus');
const {
  detectActualMimeType, stripExif, generateImageThumbnail, generateImageDerivative, generateVideoPoster,
  getMediaDurationSecs,
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

// RLY-20260806-084 — media.md §3-3-1: 엔티티 이미지 3종은 binder_storage_usage 집계 대상이
// 아니다. mediaService.confirm()도 이 3종의 applyStorageDelta(+1)를 건너뛰므로, 아래
// rejectAttachment()가 조건 없이 -1을 적용하면 "적립한 적 없는 바이트"를 차감해 집계가
// 음수로 흐른다(BINDER_AVATAR·CAST_COVER는 binder_id가 채워져 있어 null 가드만으로는
// 걸러지지 않는다 — mediaService.js와 동일 이유).
const ENTITY_IMAGE_CONTEXT_TYPES = new Set(['USER_AVATAR', 'BINDER_AVATAR', 'CAST_COVER']);

// RLY-20260806-091(S3) — media.md §4-4 Step4: 엔티티 이미지 3종은 첨부 6종과 같은 720px thumb
// 외에 1080px full도 만든다(구 256px 규격 폐기 — 3배 밀도 화면에서 120px 헤더에 360px가
// 필요해 부족했다는 판정). 이 상수 하나만 6종의 720px(mediaPipeline.js generateImageThumbnail)
// 과 다르다 — 나머지 로직(WebP quality 80, fit:'inside', 업스케일 안 함)은 공유한다.
const ENTITY_IMAGE_FULL_DIMENSION_PX = 1080;

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
  //
  // RLY-20260806-084 — 엔티티 이미지 3종은 애초에 confirm()에서 +1을 적립하지 않는다(§3-3-1).
  // 여기서 무조건 -1을 적용하면 적립한 적 없는 바이트를 차감해 집계가 음수로 흐른다.
  if (!ENTITY_IMAGE_CONTEXT_TYPES.has(attachment.context_type)) {
    await AttachmentDAO.applyStorageDelta(pool, {
      binderId: attachment.binder_id,
      storageKey: attachment.storage_key,
      fileSize: attachment.file_size,
      attachmentId: attachment.id,
      sign: -1,
    });
  }
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

    // [Step 4] 파생 미디어 생성 (media.md §4-4 Step4). SECTION_MESSAGE|EVENT|TASK|POST|CAST|
    // SPECIAL_DAY는 thumb.webp(720px) 하나. 엔티티 이미지 3종(USER_AVATAR·BINDER_AVATAR·
    // CAST_COVER)은 thumb.webp(720px) + full.webp(1080px) 2종 — 분기 없이 3종 공통
    // (RLY-20260806-091, S3).
    const isEntityImage = ENTITY_IMAGE_CONTEXT_TYPES.has(attachment.context_type);
    let thumbnailUrl = null;
    let fullUrl = null; // 엔티티 이미지 3종 전용 — Step5(c) 포인터 갱신에서 image_url 자리에 쓴다.
    // RLY-20260806-108 — 오디오·비디오 전용(media.md:356·367). 클라가 confirm 시점에 값을
    // 보내지 않으므로(media_api.dart 확인) 서버가 원본에서 직접 뽑는다 — thumbnailUrl과 같은
    // Step4 파생값 취급. 추출 실패는 부가 정보 누락일 뿐이라 첨부 처리 자체를 막지 않는다
    // (null로 남고 로그만 남긴다 — MediaProcessingError로 승격하지 않는다).
    let durationSecs = null;
    const cdnBucket = storage.bucket(CDN_BUCKET);

    if (effectiveMime && effectiveMime.startsWith('image/')) {
      let thumbBuffer;
      try {
        thumbBuffer = await generateImageThumbnail(buffer);
      } catch (err) {
        throw new MediaProcessingError(`Step4 thumbnail generation failed: ${err.message}`);
      }
      const thumbKey = `derivatives/${attachment.id}/thumb.webp`;
      await cdnBucket.file(thumbKey).save(thumbBuffer, { contentType: 'image/webp', resumable: false });
      thumbnailUrl = `${CDN_BASE_URL}/${thumbKey}`;

      if (isEntityImage) {
        // 파생 키는 항상 {attachment_id} 기반(불변) — 같은 URL이 다른 내용을 갖는 일이 없어
        // CDN Invalidation 대상 자체가 없어진다(media.md §4-4 "파생 키를 불변으로 두는 이유").
        let fullBuffer;
        try {
          fullBuffer = await generateImageDerivative(buffer, ENTITY_IMAGE_FULL_DIMENSION_PX);
        } catch (err) {
          throw new MediaProcessingError(`Step4 full-size derivative generation failed: ${err.message}`);
        }
        const fullKey = `derivatives/${attachment.id}/full.webp`;
        await cdnBucket.file(fullKey).save(fullBuffer, { contentType: 'image/webp', resumable: false });
        fullUrl = `${CDN_BASE_URL}/${fullKey}`;
      }
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

      durationSecs = await getMediaDurationSecs(originalPath).catch((err) => {
        logger.warn('Media worker: Step4 duration extraction failed(video) — duration_secs left null', {
          attachmentId: attachment.id, error: err.message,
        });
        return null;
      });
    } else if (effectiveMime && effectiveMime.startsWith('audio/')) {
      // 오디오는 파생 미디어(썸네일·포스터)가 없다(media.md:252) — duration_secs만 뽑는다.
      durationSecs = await getMediaDurationSecs(originalPath).catch((err) => {
        logger.warn('Media worker: Step4 duration extraction failed(audio) — duration_secs left null', {
          attachmentId: attachment.id, error: err.message,
        });
        return null;
      });
    }
    // 문서·기타: 파생 미디어·재생시간 없음(media.md:252) — thumbnailUrl·durationSecs는 null로 유지.
    // (엔티티 이미지 3종은 §3-3상 항상 이미지 전용이라 video/오디오/문서 분기에 들어오지 않는다
    // — presign이 이미지 MIME만 허용한다, mediaService.js.)

    // [Step 5] DB 갱신 + 알림.
    if (isEntityImage) {
      // media.md §4-4 Step5 — USER_AVATAR|BINDER_AVATAR|CAST_COVER는 (a)~(d)를 같은
      // 트랜잭션에서 수행한다(RLY-20260806-091, S3). "성공했을 때만 포인터를 옮긴다"가
      // 이 분기의 요점이다 — 실패 경로(Step1 거부, Step3/4 위 throw)는 여기 자체에 도달하지
      // 않으므로 포인터는 자동으로 이전 값 그대로 남는다. 별도 롤백 로직을 두지 않는다.
      const outcome = await withTransaction(async (client) => {
        // (a) 순서 역전 가드
        const newer = await AttachmentDAO.findNewerActiveSibling(client, {
          contextType: attachment.context_type,
          contextId: attachment.context_id,
          excludeId: attachment.id,
          afterCreatedAt: attachment.created_at,
        });
        if (newer) {
          await AttachmentDAO.markSuperseded(client, attachment.id, claimToken, thumbnailUrl);
          return 'superseded';
        }

        // (b) attachments 행 종결
        const applied = await AttachmentDAO.markReady(client, attachment.id, claimToken, thumbnailUrl);
        if (!applied) return 'claim_stolen';

        // (c) 엔티티 포인터 갱신 — full=1080 파생, thumb=720 파생
        await AttachmentDAO.updateEntityImagePointer(
          client, attachment.context_type, attachment.context_id, fullUrl, thumbnailUrl
        );

        // (d) 이전 세대 정리
        await AttachmentDAO.markOtherGenerationsDeleted(
          client, attachment.context_type, attachment.context_id, attachment.id
        );
        return 'ready';
      });

      if (outcome === 'claim_stolen') {
        logger.warn('Media worker: markReady skipped — claim stolen by another worker (stale lease)', { attachmentId: attachment.id });
      } else if (outcome === 'superseded') {
        logger.warn('Media worker: entity image superseded by a newer upload — pointer not moved (order-reversal guard, media.md §4-4 Step5-a)', { attachmentId: attachment.id });
      }
      // media.md §4-4 Step5의 엔티티 분기는 6종 분기와 달리 이벤트 발행을 명시하지 않는다.
      // §4-4-1 "거부 시 동작" 규약과 같은 결 — 실시간 push는 전 도메인 미구현이고(§13) 아바타
      // 만을 위해 별도 통지 경로를 만들지 않는다. 클라는 낙관적 표시 후 다음 동기화로 수렴한다
      // (Writer 판단 — 문서가 이 분기에 이벤트 발행 줄을 두지 않은 것을 그대로 따랐다).
      return;
    }

    const applied = await AttachmentDAO.markReady(pool, attachment.id, claimToken, thumbnailUrl, durationSecs);
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
