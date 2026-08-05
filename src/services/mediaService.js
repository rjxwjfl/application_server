const { Storage } = require('@google-cloud/storage');
const { generateUUID } = require('../utils/uuid');
const pool = require('../../config/db');
const withTransaction = require('../core/withTransaction');
const {
  NotFoundError, ForbiddenError, BadRequestError, PaymentRequiredError,
  UnprocessableEntityError, ServiceUnavailableError,
} = require('../core/errors');
const { SectionDAO } = require('../daos/sectionDAO');
const { CastDAO } = require('../daos/castDAO');
const { AttachmentDAO } = require('../daos/attachmentDAO');
const { requireBinderMember, requireBinderMemberByCalendarId } = require('../core/authz');

const storage = new Storage();

const SIGNED_URL_TTL = {
  image: 60 * 60,       // 1h
  video: 4 * 60 * 60,   // 4h
  document: 15 * 60,    // 15m
  default: 60 * 60,
};

function getTTL(contentType) {
  if (!contentType) return SIGNED_URL_TTL.default;
  if (contentType.startsWith('image/')) return SIGNED_URL_TTL.image;
  if (contentType.startsWith('video/')) return SIGNED_URL_TTL.video;
  return SIGNED_URL_TTL.document;
}

function getMediaBucket() {
  return process.env.GCS_BUCKET_MEDIA || 'rally-media';
}

// RLY-20260806-015 — confirm 실제 크기 재확인. media.md §4-3: "실제 size vs presign 신고 size
// 비교 (±10% 초과 시 422)". 클라 선언값(presign.file_size)은 신뢰하지 않는다(api.md:2396).
const SIZE_MISMATCH_TOLERANCE_RATIO = 0.1;

function buildStorageKey(binderId, attachmentId, filename) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const ext = filename ? filename.split('.').pop() : '';
  return `attachments/${binderId}/${yyyy}/${mm}/${attachmentId}${ext ? '.' + ext : ''}`;
}

class MediaService {
  /**
   * context_type: SECTION_MESSAGE | EVENT | TASK | POST | CAST | avatar | cover
   * context_id: UUID of the context entity
   * binder_id: UUID — required for non-avatar/cover contexts
   */
  async presign(data, context) {
    const { filename, content_type, file_size, context_type, context_id, binder_id } = data;
    const id = generateUUID();

    if (context_type === 'SECTION_MESSAGE') {
      const sectionId = await SectionDAO.findSectionIdByMessage(pool, context_id);
      if (!sectionId || !(await SectionDAO.hasAccess(pool, sectionId, context.sender_id))) {
        throw new ForbiddenError('섹션 첨부 접근 권한이 없습니다', 'SECTION_ACCESS_DENIED');
      }
    } else if (context_type !== 'avatar' && context_type !== 'cover') {
      // EVENT · TASK · POST · CAST 등 binder 소속 첨부 업로드 — getSignedUrl과 같은 갭이었다.
      // 업로드(쓰기)이므로 공개 캘린더라도 비멤버는 허용하지 않는다(공개 읽기 예외는 조회 전용).
      if (!binder_id) throw new BadRequestError('binder_id required for attachment contexts');
      await requireBinderMember(pool, binder_id, context.sender_id);
    }

    // F-S9 — 한도 집행 지점. avatar/cover는 binder_storage_usage 대상이 아니다(binder_id 없음).
    // SECTION_MESSAGE도 binder_id로 집계되므로 같이 검사한다(결정 33·SC-billing.md 액션 E).
    if (context_type !== 'avatar' && context_type !== 'cover') {
      const [bytesUsed, limitBytes] = await Promise.all([
        AttachmentDAO.getBytesUsed(pool, binder_id),
        AttachmentDAO.getStorageLimitBytes(pool, binder_id),
      ]);
      if (bytesUsed + (Number(file_size) || 0) > limitBytes) {
        throw new PaymentRequiredError(
          '바인더 저장 공간이 부족합니다. Binder Boost로 용량을 늘려보세요.',
          'BOOST_STORAGE_LIMIT'
        );
      }
    }

    let storage_key;
    if (context_type === 'avatar' || context_type === 'cover') {
      // Avatar/cover use entity-centric path
      storage_key = `${context_type}s/${context_id}/${id}${filename ? '.' + filename.split('.').pop() : ''}`;
    } else {
      storage_key = buildStorageKey(binder_id, id, filename);
    }

    const bucket = storage.bucket(getMediaBucket());
    const file = bucket.file(storage_key);

    const [uploadUrl] = await file.generateSignedPostPolicyV4({
      expires: Date.now() + 15 * 60 * 1000,
      conditions: [
        ['content-length-range', 1, 5 * 1024 * 1024 * 1024], // max 5GB
        ['starts-with', '$Content-Type', ''],
      ],
      fields: { 'Content-Type': content_type },
    });

    if (context_type !== 'avatar' && context_type !== 'cover') {
      await pool.query(
        `INSERT INTO attachments
           (id, binder_id, context_type, context_id, storage_key, filename,
            file_size, content_type, status, storage_class, uploader_id,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending','standard',$9,now(),now())`,
        [id, binder_id, context_type, context_id || null,
         storage_key, filename || null, file_size || null,
         content_type || null, context.sender_id]
      );
    }

    return { id, upload_url: uploadUrl, storage_key };
  }

  async confirm(attachmentId, context) {
    // 1. 대상 확인(트랜잭션 밖 — 아래 GCS 네트워크 호출 동안 DB 락을 잡지 않는다).
    //    최종 확정은 아래 UPDATE가 status='pending' 조건으로 다시 원자 검증한다(TOCTOU 무해).
    const pre = await pool.query(
      `SELECT id, binder_id, storage_key, file_size
       FROM attachments WHERE id = $1 AND uploader_id = $2 AND status = 'pending'`,
      [attachmentId, context.sender_id]
    );
    const pending = pre.rows[0];
    if (!pending) throw new NotFoundError('첨부 파일을 찾을 수 없거나 이미 처리되었습니다');

    // 2. GCS 실제 크기 재확인 — 클라 선언값(presign.file_size)을 신뢰하지 않는다.
    //    조회 실패(네트워크·권한 등 일시적 장애)는 선언값으로 조용히 넘어가지 않고 재시도 가능하도록
    //    전파한다(attachment는 'pending'에 그대로 남는다 — 상태·회계 변경 없음).
    const bucket = storage.bucket(getMediaBucket());
    const file = bucket.file(pending.storage_key);
    let actualSize;
    try {
      const [metadata] = await file.getMetadata();
      actualSize = Number(metadata.size);
    } catch (error) {
      if (error && (error.code === 404 || error.code === '404')) {
        await this._rejectAndCleanup(attachmentId, pending.storage_key);
        throw new NotFoundError(
          '업로드된 파일을 찾을 수 없습니다. 다시 업로드해주세요',
          'ATTACHMENT_OBJECT_NOT_FOUND'
        );
      }
      throw new ServiceUnavailableError(
        '파일 확인에 실패했습니다. 잠시 후 다시 시도해주세요',
        'ATTACHMENT_VERIFY_UNAVAILABLE'
      );
    }

    // 3. 선언값 대비 편차 검사(media.md §4-3): ±10% 초과 시 422 + 거부.
    const declared = Number(pending.file_size) || 0;
    const withinTolerance = declared === 0
      ? actualSize === 0
      : Math.abs(actualSize - declared) <= declared * SIZE_MISMATCH_TOLERANCE_RATIO;
    if (!withinTolerance) {
      await this._rejectAndCleanup(attachmentId, pending.storage_key);
      throw new UnprocessableEntityError(
        '업로드된 파일 크기가 신고된 크기와 일치하지 않습니다',
        'ATTACHMENT_SIZE_MISMATCH'
      );
    }

    // 4. F-S9 한도 — ±10% tolerance 이내(§2 판정 · Orchestrator 확정)면 한도를 근소 초과해도
    //    거부하지 않는다. 위조 방어는 위 3단계(±10% 편차 검사)가 이미 담당한다 — 여기 남는 것은
    //    압축률 차이 등 선의의 오차뿐이므로 이미 업로드된 사용자 데이터를 지우지 않는다.
    //    실제 값으로 집계는 그대로 반영되며, 한도 초과 상태는 다음 presign이 402로 막아 자연 수렴한다
    //    (media.md §4-4의 "위험한 파일 → 삭제" 선례는 여기 적용하지 않는다 — 정상 파일이 조금 큰 것뿐).

    // 5. 확정 — 실제 크기로 file_size를 고친 뒤 델타를 적용한다(선언값이 아니라 재확인된 값).
    return withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE attachments
         SET status = 'ready', file_size = $3, updated_at = now()
         WHERE id = $1 AND uploader_id = $2 AND status = 'pending'
         RETURNING *`,
        [attachmentId, context.sender_id, actualSize]
      );

      const attachment = result.rows[0];
      if (!attachment) throw new NotFoundError('첨부 파일을 찾을 수 없거나 이미 처리되었습니다');

      // F-S9 — 첨부 행 갱신과 같은 트랜잭션에서 원자 갱신(같은 storage_key의 다른 활성 행이
      // 이미 있으면 0 — 멱등 재confirm·복제 승계 양쪽에 forward-compatible).
      await AttachmentDAO.applyStorageDelta(client, {
        binderId: attachment.binder_id,
        storageKey: attachment.storage_key,
        fileSize: attachment.file_size,
        attachmentId: attachment.id,
        sign: 1,
      });

      return attachment;
    });
  }

  /**
   * §2·§3 실패 경로 공용 — attachment를 'rejected'로 표시하고 GCS 객체를 정리한다.
   * Worker MIME/악성코드 검증 실패와 동일 패턴(media.md §4-4 Step 1·2: status='rejected' + 객체 삭제).
   */
  async _rejectAndCleanup(attachmentId, storageKey) {
    await pool.query(
      `UPDATE attachments SET status = 'rejected', updated_at = now()
       WHERE id = $1 AND status = 'pending'`,
      [attachmentId]
    );
    try {
      await storage.bucket(getMediaBucket()).file(storageKey).delete({ ignoreNotFound: true });
    } catch {
      // GCS 삭제 실패는 로그만 남기고 계속 진행 — deleteAttachment(§8-1)와 동일 정책.
    }
  }

  async getSignedUrl(attachmentId, userId) {
    const result = await pool.query(
      `SELECT id, storage_key, content_type, status, context_type, context_id, binder_id FROM attachments WHERE id = $1`,
      [attachmentId]
    );
    const attachment = result.rows[0];
    if (!attachment) throw new NotFoundError('첨부 파일을 찾을 수 없습니다');
    await this.authorizeAttachmentAccess(attachment, userId);
    if (attachment.status === 'hidden') throw new ForbiddenError('잠긴 파일입니다. Boost로 복원하세요.');
    if (attachment.status === 'rejected') throw new ForbiddenError('접근할 수 없는 파일입니다');

    const ttl = getTTL(attachment.content_type);
    const bucket = storage.bucket(getMediaBucket());
    const file = bucket.file(attachment.storage_key);

    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + ttl * 1000,
    });

    return { url, expires_in: ttl };
  }

  /**
   * getSignedUrl의 context_type 다형 분기 — SECTION_MESSAGE만 검증하던 것을 EVENT·TASK·POST·CAST로 확장.
   * presign의 동일 분기와 짝이다(§4 helper로 함께 닫힘). 새 추상화가 아니라 기존 if/else에 case 추가.
   */
  async authorizeAttachmentAccess(attachment, userId) {
    const { context_type, context_id, binder_id } = attachment;

    if (context_type === 'SECTION_MESSAGE') {
      const sectionId = await SectionDAO.findSectionIdByMessage(pool, context_id);
      if (!sectionId || !(await SectionDAO.hasAccess(pool, sectionId, userId))) {
        throw new ForbiddenError('섹션 첨부 접근 권한이 없습니다', 'SECTION_ACCESS_DENIED');
      }
      return;
    }

    if (context_type === 'CAST') {
      // 결정 5: 바인더 멤버십 OR 캘린더 is_public — castService.getCast와 동일 게이트.
      const cast = await CastDAO.findById(pool, context_id);
      if (!cast) throw new NotFoundError('캐스트를 찾을 수 없습니다');
      await requireBinderMemberByCalendarId(pool, cast.calendar_id, userId, { allowPublicRead: true });
      return;
    }

    // EVENT · TASK · POST 등 나머지 binder 소속 컨텍스트 — 업로드 시점에 저장된 binder_id로 검증한다.
    await requireBinderMember(pool, binder_id, userId);
  }

  async deleteAttachment(attachmentId, userId) {
    // F-S9 — 첨부 행 soft delete와 binder_storage_usage 차감을 같은 트랜잭션에서 원자 갱신한다.
    // 네트워크 I/O(GCS 삭제)는 트랜잭션 밖에서 한다(DB 트랜잭션 안에서 외부 호출을 기다리지 않는다).
    const attachment = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE attachments
         SET deleted_at = now(), updated_at = now()
         WHERE id = $1 AND uploader_id = $2 AND deleted_at IS NULL
         RETURNING id, binder_id, storage_key, file_size`,
        [attachmentId, userId]
      );
      const att = result.rows[0];
      if (!att) throw new NotFoundError('첨부 파일을 찾을 수 없거나 권한이 없습니다');

      // 같은 binder_id에 같은 storage_key의 다른 활성 행이 남아 있으면(복제 승계) 0 — 마지막이면 차감.
      await AttachmentDAO.applyStorageDelta(client, {
        binderId: att.binder_id,
        storageKey: att.storage_key,
        fileSize: att.file_size,
        attachmentId: att.id,
        sign: -1,
      });

      return att;
    });

    // ⚠️ storage_key를 다른 활성 행이 공유하고 있으면 여기서 물리 객체를 지우는 순간 그 행의
    // 파일도 함께 사라진다(F-S6 결정 61이 이 호출 자체를 하드 삭제 시점으로 옮길 때까지 미해결).
    // F-S6이 아직 착수되지 않아 현재는 복제 자체가 없으므로 이 경합은 아직 발생하지 않는다 —
    // F-S6 착수 시 AC-S6-3(이 네트워크 호출 제거)이 먼저 반영되어야 안전하다.
    try {
      const bucket = storage.bucket(getMediaBucket());
      await bucket.file(attachment.storage_key).delete({ ignoreNotFound: true });
    } catch {
      // GCS 삭제 실패는 로그만 남기고 200 반환 (DB 레코드는 이미 soft-delete)
    }
  }

  /**
   * Restore all hidden attachments for a binder after Boost purchase.
   * Called by webhook after payment confirmation.
   */
  async restoreBinderAttachments(binderId) {
    const result = await pool.query(
      `SELECT id, storage_key, storage_class FROM attachments
       WHERE binder_id = $1 AND status = 'hidden' AND deleted_at IS NULL`,
      [binderId]
    );
    const rows = result.rows;
    if (rows.length === 0) return 0;

    const bucket = storage.bucket(getMediaBucket());

    await Promise.allSettled(
      rows.map(async (att) => {
        const file = bucket.file(att.storage_key);
        if (att.storage_class === 'archive') {
          // GCS Archive restore requires a rewrite to Standard
          await file.copy(file, { storageClass: 'STANDARD' });
        } else if (att.storage_class !== 'standard') {
          await file.copy(file, { storageClass: 'STANDARD' });
        }
      })
    );

    const ids = rows.map((r) => r.id);
    await pool.query(
      `UPDATE attachments
       SET status = 'ready', storage_class = 'standard', hidden_at = NULL, updated_at = now()
       WHERE id = ANY($1)`,
      [ids]
    );

    return ids.length;
  }
}

module.exports = { MediaService: new MediaService() };
