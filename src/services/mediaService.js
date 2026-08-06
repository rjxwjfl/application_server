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
   * context_id: UUID of the context entity (avatar/cover: the entity being pictured — see entity_type)
   * binder_id: UUID — required for non-avatar/cover contexts
   * entity_type: avatar/cover 전용 — 'avatar'는 'user'|'binder', 'cover'는 'binder'|'cast'.
   *   media.md §4-1(entity_type 필드)이 문서화한 값이나 코드에 미배선 상태였다(RLY-20260806-052
   *   조사 보고). avatar는 클라 유일 실사용 경로(user)와의 하위호환을 위해 생략 시 'user'로 기본값.
   *   cover는 binder/cast 중 무엇을 가리키는지 구분할 방법이 없어 생략을 허용하지 않는다.
   */
  async presign(data, context) {
    const { filename, content_type, file_size, context_type, context_id, binder_id, entity_type } = data;
    const id = generateUUID();

    if (context_type === 'SECTION_MESSAGE') {
      const sectionId = await SectionDAO.findSectionIdByMessage(pool, context_id);
      if (!sectionId || !(await SectionDAO.hasAccess(pool, sectionId, context.sender_id))) {
        throw new ForbiddenError('섹션 첨부 접근 권한이 없습니다', 'SECTION_ACCESS_DENIED');
      }
    } else if (context_type === 'avatar') {
      // RLY-20260806-052 — 이전엔 avatar/cover가 이 if/else 사슬에서 통째로 빠져 있어
      // 인가 검사가 전혀 없었다(임의 유저가 남의 user_id/binder_id/cast_id로 presign 가능).
      await this._authorizeAvatarPresign(context_id, entity_type, context);
    } else if (context_type === 'cover') {
      await this._authorizeCoverPresign(context_id, entity_type, context);
    } else {
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

  /**
   * RLY-20260806-052 — avatar presign 인가. entity_type 생략 시 'user'(클라 유일 실사용 경로,
   * storage_repository.dart:83-88 — contextType:'avatar', entityType 미전송)로 취급한다.
   */
  async _authorizeAvatarPresign(contextId, entityType, context) {
    if (!contextId) throw new BadRequestError('context_id required for avatar contexts');
    const type = entityType || 'user';

    if (type === 'user') {
      if (contextId !== context.sender_id) {
        throw new ForbiddenError('본인 프로필 사진만 업로드할 수 있습니다', 'AVATAR_FORBIDDEN');
      }
      return;
    }
    if (type === 'binder') {
      // binderService.updateBinder와 동일 기준 — master(role 0)만(binderService.js:227).
      // 실제로 이 storage_key를 소비하는 유일한 필드는 binders.image_url(PATCH /binders/:id)이며
      // 그 엔드포인트가 이미 master 전용이다 — presign 단계 인가를 그 기준에 맞춘다.
      await requireBinderMember(pool, contextId, context.sender_id, { minRole: 0 });
      return;
    }
    throw new BadRequestError('지원하지 않는 entity_type입니다', 'UNSUPPORTED_ENTITY_TYPE');
  }

  /**
   * RLY-20260806-052 — cover presign 인가. avatar와 달리 entity_type을 생략할 수 없다 —
   * context_id 하나만으로는 binder_id인지 cast_id인지 구분할 방법이 없다(둘 다 UUID).
   */
  async _authorizeCoverPresign(contextId, entityType, context) {
    if (!contextId) throw new BadRequestError('context_id required for cover contexts');
    if (entityType === 'binder') {
      // 위 avatar/binder와 동일 기준(master만) — binders 테이블엔 avatar·cover 구분 컬럼이
      // 없고 image_url 하나뿐이라 실질적으로 avatar/binder와 같은 문지기를 공유한다.
      await requireBinderMember(pool, contextId, context.sender_id, { minRole: 0 });
      return;
    }
    if (entityType === 'cast') {
      // castService.update(:73-80)와 동일한 판정을 그대로 재사용한다 — 작성자 본인이거나
      // master/manager(role<=1)여야 한다. 새 헬퍼를 만들지 않고 기존 패턴을 인라인 복제한다.
      const cast = await CastDAO.findById(pool, contextId);
      if (!cast) throw new NotFoundError('캐스트를 찾을 수 없습니다');
      const { member } = await requireBinderMemberByCalendarId(pool, cast.calendar_id, context.sender_id);
      if (member.role > 1 && cast.author_id !== context.sender_id) {
        throw new ForbiddenError('권한이 없습니다');
      }
      return;
    }
    throw new BadRequestError('cover 업로드에는 entity_type(binder|cast)이 필요합니다', 'ENTITY_TYPE_REQUIRED');
  }

  /**
   * RLY-20260806-052 — PATCH 계열 엔드포인트(users/:id, binders/:binderId, casts/:castId)가
   * 클라 선언 image_url·thumbnail_url·cover_image_url을 검증 없이 그대로 DB에 쓰던 결함의 수리.
   *
   * avatar/cover는 attachments 행이 없어(media.md §4-1, 설계상 의도) 행 참조로 검증할 수 없다 —
   * 대신 storage_key 자체가 이미 신뢰의 근거다: presign이 `{prefix}/{entityId}/{uuid}.ext` 형태로
   * 결정적으로 키를 생성하고(mediaService.presign:96), 그 키를 발급받으려면 위 _authorize*Presign이
   * 이미 이 entityId에 대한 쓰기 권한을 확인했다. 따라서 "제출된 값이 이 entityId 접두사와 정확히
   * 일치하는 storage_key인가 + GCS에 실제로 그 객체가 존재하는가"만 확인하면 별도 상태 저장 없이
   * (attachments 행도, 새 테이블도 없이) 위조 URL을 배제할 수 있다 — 가장 단순한 방법(팀리드 지시).
   *
   * ⚠️ 이 메서드는 URL 위조·타인 참조만 막는다. MIME 위변조 검사·EXIF 파기는 하지 않는다
   * (①이 보류돼 avatar/cover엔 Worker 파이프라인이 없다 — 보고서 참조).
   *
   * @param {string|null|undefined} value - 미제공(undefined)이면 기존 값 유지(DAO의 COALESCE와
   *   동일 의미) — 검증하지 않고 통과시킨다. null은 기존 COALESCE 동작(무시 — 지우지 않음)을
   *   그대로 둔다 — 이 메서드가 그 동작을 바꾸지 않는다(별도 결함, 이번 Task 범위 아님).
   * @param {object} params
   * @param {string} params.prefix - 'avatars' | 'covers'
   * @param {string} params.entityId - 이 값을 갱신하는 대상 엔티티의 실제 id(user/binder/cast)
   */
  async assertOwnedMediaReference(value, { prefix, entityId }) {
    if (value === undefined || value === null) return;
    if (typeof value !== 'string') {
      throw new BadRequestError('허용되지 않은 이미지 참조입니다', 'INVALID_IMAGE_REFERENCE');
    }

    const wantPrefix = `${prefix}/${entityId}/`;
    const rest = value.startsWith(wantPrefix) ? value.slice(wantPrefix.length) : null;
    const isOwnedKey = !!rest && rest.length > 0 && !rest.includes('/') && !rest.includes('..');
    if (!isOwnedKey) {
      throw new BadRequestError('허용되지 않은 이미지 참조입니다', 'INVALID_IMAGE_REFERENCE');
    }

    const bucket = storage.bucket(getMediaBucket());
    const [exists] = await bucket.file(value).exists();
    if (!exists) {
      throw new BadRequestError('업로드된 파일을 찾을 수 없습니다', 'IMAGE_REFERENCE_NOT_FOUND');
    }
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
    //    RLY-20260806-047 — status는 'ready'가 아니라 'processing'이다(media.md §4-3 step3·§9
    //    상태 전이표: confirm → 'processing', Worker 완료 → 'ready'). Worker(mediaWorkerJobs.js)가
    //    이 'processing' 행을 claim해 media.md §4-4 파이프라인을 돌린 뒤 'ready'로 전환한다 — 예전
    //    코드는 이 단계를 건너뛰고 검사 없이 바로 'ready'로 직행했다(결함, 이번 Task의 핵심).
    return withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE attachments
         SET status = 'processing', file_size = $3, updated_at = now()
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
    // 결정 61(F-S6 §3) — GCS 객체 삭제는 여기서 하지 않는다. DB만 만진다.
    // 이유 둘: (1) 30일 복원 유예는 실물 파일이 남아 있어야 의미가 있다 — soft delete 직후 즉시
    // 하드 삭제하면 DB 행만 유예 기간을 흉내내고 파일은 이미 없다. (2) storage_key를 다른 활성
    // 행이 공유할 수 있어(첨부 복제, F-S6 §2) 이 시점의 단일 행 판단만으로는 물리 객체를 안전하게
    // 지워도 되는지 알 수 없다 — 판정은 cleanupJobs가 하드 삭제 시점에 가드(같은 storage_key를
    // 가리키는 다른 활성 행이 없음)를 걸고 수행한다.
    await withTransaction(async (client) => {
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
