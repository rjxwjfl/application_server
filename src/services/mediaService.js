const { Storage } = require('@google-cloud/storage');
const { generateUUID } = require('../utils/uuid');
const pool = require('../../config/db');
const withTransaction = require('../core/withTransaction');
const {
  NotFoundError, ForbiddenError, BadRequestError, PaymentRequiredError,
  UnprocessableEntityError, ServiceUnavailableError, UnsupportedMediaTypeError,
  PayloadTooLargeError,
} = require('../core/errors');
const { SectionDAO } = require('../daos/sectionDAO');
const { CastDAO } = require('../daos/castDAO');
const { AttachmentDAO, TIER_STORAGE_LIMIT_BYTES } = require('../daos/attachmentDAO');
const { requireBinderMember, requireBinderMemberByCalendarId } = require('../core/authz');
const { ALLOWED_IMAGE_MIME_TYPES } = require('../utils/mediaPipeline');

// RLY-20260806-072 — media.md §3-1(단일 파일 최대 크기) 이미지 행. 조사 결과 파일 1건당
// 상한이 서버 어디에도 없었다(바인더 총량 한도(F-S9)만 있었다).
// RLY-20260806-075 — User 판정(2026-08-07)으로 오디오·비디오도 같이 건다. image·audio·video는
// content_type prefix만으로 모호함 없이 분류된다. document·other는 여전히 보류다 — 둘 다
// `application/*` 등으로 겹칠 수 있어(예: application/pdf vs application/zip) prefix로 못
// 가르고, 그 구분 목록 자체가 문서 어디에도 없다. 게다가 이미지 외 content_type은 아직 MIME
// 허용 목록조차 없어(presign의 §3-3-1 검사가 `image/`로 시작할 때만 대조) 크기만 막는 건
// 반쪽 방어다 — "판단이 안 서면 넣지 않는다"(team-lead 지시, mediaPipeline.js 주석과 동일
// 원칙). 허용 목록이 갖춰질 때 document·other를 한 번에 판정한다(User 판정).
const IMAGE_FILE_SIZE_LIMIT_BYTES = [20, 50, 100].map((mb) => mb * 1024 * 1024); // Free/Lite/Plus
const AUDIO_FILE_SIZE_LIMIT_BYTES = [20, 100, 300].map((mb) => mb * 1024 * 1024); // Free/Lite/Plus
const VIDEO_FILE_SIZE_LIMIT_BYTES = [200, 1024, 5120].map((mb) => mb * 1024 * 1024); // Free/Lite/Plus (1GB·5GB)
const TIER_NAMES = ['free', 'lite', 'plus'];

// RLY-20260806-084 — media.md §3-3-1(엔티티 이미지 3종 — 검사 경로 통합). 아바타·커버가
// attachments 행 없이 별도 GCS 경로로 빠지던 구 설계(무검사 통과 결함 실측 확인, 2026-08-06)를
// 폐기하고 첨부와 동일한 presign → confirm → Worker 경로에 태운다. tier 무관 플랫 상한
// (media.md §3-3·§4-1 서버 Step4) — 첨부 6종의 tier별 상한(위 IMAGE_FILE_SIZE_LIMIT_BYTES 등)과
// 다른 값이므로 섞지 않는다.
const ENTITY_IMAGE_CONTEXT_TYPES = new Set(['USER_AVATAR', 'BINDER_AVATAR', 'CAST_COVER']);
const AVATAR_FILE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024; // USER_AVATAR · BINDER_AVATAR — 10MB flat
const CAST_COVER_FILE_SIZE_LIMIT_BYTES = 20 * 1024 * 1024; // CAST_COVER — 20MB flat

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

// media.md §4-1 서버 Step6 — 엔티티 이미지 3종 전용 키. 업로드마다 {attachment_id}로 새 키를
// 쓴다(구 `original.{ext}` 덮어쓰기 폐기 — 검사 실패 시 이전 사진이 이미 사라지는 문제 방지,
// media.md:274 근거).
function buildEntityImageStorageKey(prefix, entityId, attachmentId, filename) {
  const ext = filename ? filename.split('.').pop() : '';
  return `${prefix}/${entityId}/${attachmentId}${ext ? '.' + ext : ''}`;
}

class MediaService {
  /**
   * context_type: 9종 — 첨부 6종(SECTION_MESSAGE·EVENT·TASK·POST·CAST·SPECIAL_DAY) +
   *   엔티티 이미지 3종(USER_AVATAR·BINDER_AVATAR·CAST_COVER).
   * context_id: 컨텍스트 PK. 엔티티 이미지 3종은 대상 엔티티 PK(user_id|binder_id|cast_id)가
   *   필수다(첨부 6종은 pre-upload 단계에 null 허용).
   * binder_id: 저장 사용량 집계 + GCS 키 네이밍용. USER_AVATAR만 null(귀속 바인더 없음).
   *
   * RLY-20260806-084 — media.md §3-3-1·§4-1(2026-08-07 확정)로 구 `context_type: 'avatar'|'cover'`
   * + `entity_type` 2단 판별자 계약을 대체한다. `context_type` 하나가 이미 엔티티 종류를
   * 결정하므로 두 번째 판별자가 불필요했다(구 값의 조합 중 절반은 애초에 무의미했다).
   */
  async presign(data, context) {
    const { filename, content_type, file_size, context_type, context_id, binder_id, display_order } = data;
    const id = generateUUID();
    const isEntityImage = ENTITY_IMAGE_CONTEXT_TYPES.has(context_type);

    // RLY-20260806-056 — media.md:106,127이 서술하는 "MIME 타입 허용 목록 확인"이 코드엔
    // 없었다(presign이 content_type을 어떤 목록과도 대조하지 않고 그대로 DB·GCS 폼에 썼다).
    // api.md:2395가 이미 문서화한 415 UNSUPPORTED_MEDIA_TYPE 계약을 여기서 처음 배선한다.
    // 이미지가 아닌 content_type(오디오·비디오·문서·기타)은 이번 Task 범위 밖이라 손대지
    // 않는다(team-lead 지시) — 첨부 6종은 image/ 로 선언한 경우만 대조한다.
    //
    // RLY-20260806-084 — 엔티티 이미지 3종은 §3-3상 항상 이미지 전용이므로, 선언된 content_type이
    // 'image/'로 시작하는지와 무관하게 무조건 허용 목록과 대조한다. "image/ 로 시작할 때만
    // 대조"로 구현하면 application/octet-stream 선언이 검사를 통째로 우회한다 — 2026-08-06
    // 클라가 GIF를 application/octet-stream으로 선언해 아바타 무검사 통과가 실제로 확인된 경로
    // (media.md §4-1 서버 Step3 경고).
    if (isEntityImage) {
      if (!content_type || !ALLOWED_IMAGE_MIME_TYPES.has(content_type.toLowerCase())) {
        throw new UnsupportedMediaTypeError('지원하지 않는 이미지 형식입니다');
      }
    } else if (content_type && content_type.toLowerCase().startsWith('image/')
      && !ALLOWED_IMAGE_MIME_TYPES.has(content_type.toLowerCase())) {
      throw new UnsupportedMediaTypeError('지원하지 않는 이미지 형식입니다');
    }

    // media.md §4-1 서버 Step2/4 — 엔티티 이미지 3종은 저장 용량 집계 대상이 아니라(§3-3-1)
    // 플랫 상한(아래)이 유일한 상한이며, file_size가 confirm의 ±10% 편차 검사에도 쓰이므로
    // 누락을 허용하지 않는다.
    if (isEntityImage && (file_size === undefined || file_size === null)) {
      throw new BadRequestError('file_size is required for entity image uploads');
    }

    // entityBinderId — 엔티티 이미지 3종의 attachments.binder_id 컬럼에 넣을 값(§4-1 서버 Step7:
    // USER_AVATAR는 null · BINDER_AVATAR는 context_id와 동일 · CAST_COVER는 그 캐스트가 속한
    // 바인더 id). 인가 단계에서 함께 정해진다(CAST_COVER는 인가 조회에서 이미 얻는 값이라
    // 별도 쿼리를 추가하지 않는다).
    let entityBinderId = null;

    if (context_type === 'SECTION_MESSAGE') {
      const sectionId = await SectionDAO.findSectionIdByMessage(pool, context_id);
      if (!sectionId || !(await SectionDAO.hasAccess(pool, sectionId, context.sender_id))) {
        throw new ForbiddenError('섹션 첨부 접근 권한이 없습니다', 'SECTION_ACCESS_DENIED');
      }
    } else if (context_type === 'USER_AVATAR') {
      // RLY-20260806-052 — 이전엔 avatar/cover가 이 if/else 사슬에서 통째로 빠져 있어
      // 인가 검사가 전혀 없었다(임의 유저가 남의 user_id/binder_id/cast_id로 presign 가능).
      await this._authorizeUserAvatarPresign(context_id, context);
    } else if (context_type === 'BINDER_AVATAR') {
      await this._authorizeBinderAvatarPresign(context_id, context);
      entityBinderId = context_id;
    } else if (context_type === 'CAST_COVER') {
      entityBinderId = await this._authorizeCastCoverPresign(context_id, context);
    } else {
      // EVENT · TASK · POST · CAST · SPECIAL_DAY 등 binder 소속 첨부 업로드 — getSignedUrl과
      // 같은 갭이었다. 업로드(쓰기)이므로 공개 캘린더라도 비멤버는 허용하지 않는다(공개 읽기
      // 예외는 조회 전용).
      if (!binder_id) throw new BadRequestError('binder_id required for attachment contexts');
      await requireBinderMember(pool, binder_id, context.sender_id);
    }

    // 엔티티 이미지 3종의 플랫 상한(media.md §3-3·§4-1 서버 Step4) — tier 무관, 첨부 6종의
    // tier별 상한(아래)과 별개 수치다. 총량 한도(binder_storage_usage) 검사에는 들어가지 않는다
    // (§3-3-1) — 아래 !isEntityImage 블록 전체를 건너뛴다.
    if (isEntityImage) {
      const declaredSize = Number(file_size) || 0;
      const flatLimitBytes = context_type === 'CAST_COVER'
        ? CAST_COVER_FILE_SIZE_LIMIT_BYTES
        : AVATAR_FILE_SIZE_LIMIT_BYTES;
      if (declaredSize > flatLimitBytes) {
        const limitMb = Math.round(flatLimitBytes / (1024 * 1024));
        throw new PayloadTooLargeError(`이미지 파일은 ${limitMb}MB를 초과할 수 없습니다`);
      }
    }

    // F-S9 — 한도 집행 지점. 엔티티 이미지 3종은 binder_storage_usage 대상이 아니다(§3-3-1).
    // SECTION_MESSAGE도 binder_id로 집계되므로 같이 검사한다(결정 33·SC-billing.md 액션 E).
    if (!isEntityImage) {
      const [bytesUsed, tier] = await Promise.all([
        AttachmentDAO.getBytesUsed(pool, binder_id),
        AttachmentDAO.getTier(pool, binder_id),
      ]);
      const declaredSize = Number(file_size) || 0;

      // RLY-20260806-072 — media.md §4-1 step4(파일 1건당 상한, §3-1). 이미지만 배선한다
      // (위 상수 정의 주석 참조). 이 상한을 넘는 파일은 presign 단계에서 거부해 GCS에 절대
      // 업로드되지 않게 한다(주석대로 presign 실패 = 업로드 URL 미발급 = 고아 객체 없음).
      if (content_type && content_type.toLowerCase().startsWith('image/')) {
        const imageLimitBytes = IMAGE_FILE_SIZE_LIMIT_BYTES[tier] ?? IMAGE_FILE_SIZE_LIMIT_BYTES[0];
        if (declaredSize > imageLimitBytes) {
          const limitMb = Math.round(imageLimitBytes / (1024 * 1024));
          throw new PayloadTooLargeError(
            `이미지 파일은 ${limitMb}MB를 초과할 수 없습니다 (${TIER_NAMES[tier] ?? 'free'} tier)`
          );
        }
      }

      // RLY-20260806-075 — media.md §3-1 오디오 행. User 판정(2026-08-07)으로 이미지 옆에
      // 그대로 추가한다(공통 함수로 묶지 않는다 — team-lead 지시, 방금 병합된 이미지 분기의
      // 회귀를 건드리지 않기 위해).
      if (content_type && content_type.toLowerCase().startsWith('audio/')) {
        const audioLimitBytes = AUDIO_FILE_SIZE_LIMIT_BYTES[tier] ?? AUDIO_FILE_SIZE_LIMIT_BYTES[0];
        if (declaredSize > audioLimitBytes) {
          const limitMb = Math.round(audioLimitBytes / (1024 * 1024));
          throw new PayloadTooLargeError(
            `오디오 파일은 ${limitMb}MB를 초과할 수 없습니다 (${TIER_NAMES[tier] ?? 'free'} tier)`
          );
        }
      }

      // RLY-20260806-075 — media.md §3-1 비디오 행. 위 오디오와 동일 이유로 나란히 둔다.
      if (content_type && content_type.toLowerCase().startsWith('video/')) {
        const videoLimitBytes = VIDEO_FILE_SIZE_LIMIT_BYTES[tier] ?? VIDEO_FILE_SIZE_LIMIT_BYTES[0];
        if (declaredSize > videoLimitBytes) {
          const limitMb = Math.round(videoLimitBytes / (1024 * 1024));
          throw new PayloadTooLargeError(
            `비디오 파일은 ${limitMb}MB를 초과할 수 없습니다 (${TIER_NAMES[tier] ?? 'free'} tier)`
          );
        }
      }

      // F-S9 — 바인더 총 저장 한도(집계). 파일 1건당 상한과 별개 검사(§4-1 step5).
      const limitBytes = TIER_STORAGE_LIMIT_BYTES[tier] ?? TIER_STORAGE_LIMIT_BYTES[0];
      if (bytesUsed + declaredSize > limitBytes) {
        throw new PaymentRequiredError(
          '바인더 저장 공간이 부족합니다. Binder Boost로 용량을 늘려보세요.',
          'BOOST_STORAGE_LIMIT'
        );
      }
    }

    let storage_key;
    if (context_type === 'USER_AVATAR') {
      storage_key = buildEntityImageStorageKey('avatars/users', context_id, id, filename);
    } else if (context_type === 'BINDER_AVATAR') {
      storage_key = buildEntityImageStorageKey('avatars/binders', context_id, id, filename);
    } else if (context_type === 'CAST_COVER') {
      storage_key = buildEntityImageStorageKey('covers/casts', context_id, id, filename);
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

    // RLY-20260806-084 — media.md §3-3-1: 엔티티 이미지 3종도 attachments 행을 만든다(구
    // "DB 레코드 없음" 설계 폐기). 상태 없이는 재시도(attempt_count)·점유(claim_token)·거부
    // 종결(status='rejected')이 성립하지 않아 Worker의 MIME 위변조 검사·EXIF 파기·파생 생성에
    // 도달 자체를 못 했다(2026-08-06 무검사 통과 실측). insertBinderId는 §4-1 서버 Step7 규칙대로
    // 타입별로 다르다(위 entityBinderId 계산 참조).
    const insertBinderId = isEntityImage ? entityBinderId : binder_id;
    // RLY-20260806-108 — media.md:188·225(§4-1 서버 Step7)가 presign 요청의 display_order를
    // 받아 저장한다고 규정하지만 이 INSERT에 컬럼 자체가 없었다(전부 스키마 DEFAULT 0으로
    // 남는 쓰기 공백). 컬럼만 추가한다 — presign의 나머지 로직은 건드리지 않는다(S2 회귀 보호).
    // ⚠️ 클라(`PresignRequest`, lib/data/dto/media/presign_request.dart)는 이 필드를 아직 안
    // 보낸다(읽기만 확인) — 서버가 받아도 지금은 항상 undefined→0으로 저장된다. 클라 쪽 배선은
    // 별도 Task로 보고한다(이번 보고서 참조).
    await pool.query(
      `INSERT INTO attachments
         (id, binder_id, context_type, context_id, storage_key, filename,
          file_size, content_type, status, storage_class, uploader_id,
          display_order, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending','standard',$9,$10,now(),now())`,
      [id, insertBinderId, context_type, context_id || null,
       storage_key, filename || null, file_size || null,
       content_type || null, context.sender_id, display_order ?? 0]
    );

    return { id, upload_url: uploadUrl, storage_key };
  }

  /**
   * RLY-20260806-052/084 — USER_AVATAR presign 인가. media.md §4-1-1: 본인만.
   */
  async _authorizeUserAvatarPresign(contextId, context) {
    if (!contextId) throw new BadRequestError('context_id required for avatar contexts');
    if (contextId !== context.sender_id) {
      throw new ForbiddenError('본인 프로필 사진만 업로드할 수 있습니다', 'AVATAR_FORBIDDEN');
    }
  }

  /**
   * RLY-20260806-052/084 — BINDER_AVATAR presign 인가. media.md §4-1-1: 그 바인더의
   * master(role 0) — binderService.updateBinder(PATCH /binders/:id)와 동일 기준. 실제로 이
   * storage_key를 소비하는 유일한 필드는 binders.image_url이며 그 엔드포인트가 이미 master
   * 전용이다 — presign 단계 인가를 그 기준에 맞춘다.
   */
  async _authorizeBinderAvatarPresign(contextId, context) {
    if (!contextId) throw new BadRequestError('context_id required for binder avatar contexts');
    await requireBinderMember(pool, contextId, context.sender_id, { minRole: 0 });
  }

  /**
   * RLY-20260806-052/084 — CAST_COVER presign 인가. media.md §4-1-1: 그 캐스트의 작성자 본인
   * 또는 master·manager(role ≤ 1) — castService.update와 동일 판정(작성자는 role과 무관하게
   * 허용, 그 외는 role<=1). requireBinderMemberByCalendarId가 반환하는 calendar.binder_id를
   * attachments.binder_id 계산에 재사용한다(별도 조회를 추가하지 않는다).
   *
   * @returns {string} 이 캐스트가 속한 바인더 id — presign의 entityBinderId(§4-1 서버 Step7)로 쓰인다.
   */
  async _authorizeCastCoverPresign(contextId, context) {
    if (!contextId) throw new BadRequestError('context_id required for cast cover contexts');
    const cast = await CastDAO.findById(pool, contextId);
    if (!cast) throw new NotFoundError('캐스트를 찾을 수 없습니다');
    const { calendar, member } = await requireBinderMemberByCalendarId(pool, cast.calendar_id, context.sender_id);
    if (member.role > 1 && cast.author_id !== context.sender_id) {
      throw new ForbiddenError('권한이 없습니다');
    }
    return calendar.binder_id;
  }

  /**
   * RLY-20260806-084 — media.md §4-4 Step5 note / api.md:146-150: image_url·thumbnail_url·
   * cover_image_url은 서버 전용 필드다("포인터는 검사를 통과한 순간에만, 서버가 옮긴다"). 클라가
   * null이 아닌 값을 보내면 400으로 거부한다. 남는 용도는 "사진 제거"뿐이라 두 필드 모두 null은
   * 허용하고, undefined(필드 자체 미포함)는 기존 값 유지(DAO COALESCE와 동일 의미)로 통과시킨다.
   *
   * assertOwnedMediaReference(RLY-20260806-052)를 대체한다 — 그 헬퍼는 "클라가 보낸 storage_key가
   * 자기 소유 형식인가 + GCS에 실재하는가"를 검증했지만, 이제 서버가 검사 통과 시점에만
   * 엔티티 포인터를 옮기므로(media.md §4-4 Step5) 클라가 이 필드에 값을 실어 보내는 경로 자체가
   * 사라진다 — 형식 검증보다 값 자체를 안 받는 쪽이 더 강한 방어다.
   *
   * @param {object} fields - { image_url? , thumbnail_url? , cover_image_url? } 등 필드명→값.
   */
  assertServerOnlyImageFields(fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null) {
        throw new BadRequestError(
          `${key}은(는) 서버가 채우는 필드입니다. 사진은 presign 업로드로만 반영됩니다`,
          'SERVER_ONLY_IMAGE_FIELD'
        );
      }
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
      //
      // RLY-20260806-084 — media.md §3-3-1: 엔티티 이미지 3종은 이 집계 대상이 아니다. binder_id
      // 없는 USER_AVATAR는 applyStorageDelta의 null 가드로 자동 제외되지만, BINDER_AVATAR·
      // CAST_COVER는 binder_id가 채워져 있어(§4-1 서버 Step7) 그 가드만으로는 걸러지지 않는다 —
      // context_type으로 명시 제외한다(빠뜨리면 실제 소비 안 한 바이트가 바인더 한도를 깎아먹는다).
      if (!ENTITY_IMAGE_CONTEXT_TYPES.has(attachment.context_type)) {
        await AttachmentDAO.applyStorageDelta(client, {
          binderId: attachment.binder_id,
          storageKey: attachment.storage_key,
          fileSize: attachment.file_size,
          attachmentId: attachment.id,
          sign: 1,
        });
      }

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

    // RLY-20260806-096(S5) — USER_AVATAR는 binder_id가 null이라(§4-1 서버 Step7, 귀속 바인더
    // 없음) 이 함수 끝의 기본 분기(requireBinderMember)로 떨어지면 본인을 포함해 누구에게도
    // 항상 403이었다 — presign(_authorizeUserAvatarPresign)은 "본인만"으로 쓰기를 허용하는데
    // 읽기(이 함수)는 그 누구도 못 읽는 비대칭이 있었다. 표시 자체는 CDN 공개 URL(image_url·
    // thumbnail_url, media.md §5 "Signed URL 불필요")로 이미 되므로 이 엔드포인트(원본 signed
    // URL)를 실제로 쓰는 클라 기능은 없어 보이지만, "아무도 못 읽는" 상태를 문서 근거 없이
    // 그대로 방치하면 다음 사람이 왜 그런지 몰라 다시 조사해야 한다 — 존재하는 write 대칭
    // (본인만)을 그대로 read에 적용해 닫는다. 인가를 느슨하게 만들지 않는다 — 본인만 통과.
    if (context_type === 'USER_AVATAR') {
      if (context_id !== userId) {
        throw new ForbiddenError('본인 프로필 사진만 접근할 수 있습니다', 'AVATAR_FORBIDDEN');
      }
      return;
    }
    // BINDER_AVATAR·CAST_COVER는 binder_id가 채워져 있어(§4-1 서버 Step7 — BINDER_AVATAR는
    // context_id와 동일, CAST_COVER는 그 캐스트가 속한 바인더) 아래 기본 분기로 이미 올바르게
    // 걸린다(그 바인더 멤버면 통과) — 별도 분기가 필요 없다. 새로 추가하지 않는다.

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
      // RLY-20260806-093(S4) — media.md §2-3: 엔티티 이미지 3종(USER_AVATAR·BINDER_AVATAR·
      // CAST_COVER)은 정체성 데이터라 삭제 대상이 아니다. `DELETE /binders/:binderId/attachments/
      // :attachmentId`(파일함 개별 삭제, binderService 소관)는 attachmentDAO.findById에서 이미
      // 막았지만, 이 함수가 처리하는 `DELETE /attachments/:attachmentId`(일반 경로)는 attachment_id
      // 를 아는 누구나(본인 업로드 한정) 호출할 수 있는 별개 경로라 여기도 동일하게 막는다
      // (defense-in-depth — 두 경로 중 하나만 막으면 다른 경로로 우회된다).
      const result = await client.query(
        `UPDATE attachments
         SET deleted_at = now(), updated_at = now()
         WHERE id = $1 AND uploader_id = $2 AND deleted_at IS NULL
           AND context_type NOT IN ('USER_AVATAR','BINDER_AVATAR','CAST_COVER')
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
