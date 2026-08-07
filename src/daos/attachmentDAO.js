// F-S9 — tier(SMALLINT 0=free 1=lite 2=plus, config/schema.sql:186) → 저장 한도(bytes).
// SC-billing.md:26-28 확정값(Free 5GB · Boost Lite 50GB · Boost Plus 200GB). 1GB = 1024^3
// (server/api.md:2266 storage_limit_bytes 예시값 1073741824과 정합).
const TIER_STORAGE_LIMIT_BYTES = [
  5 * 1024 ** 3,
  50 * 1024 ** 3,
  200 * 1024 ** 3,
];

class AttachmentDAO {
  async create(conn, data) {
    const result = await conn.query(
      `INSERT INTO attachments
         (id, binder_id, context_type, context_id, storage_key, filename,
          file_size, content_type, status, storage_class, uploader_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
               COALESCE($9,'pending'), COALESCE($10,'standard'),
               $11, COALESCE($12,now()), COALESCE($13,now()))
       RETURNING *`,
      [
        data.id, data.binder_id, data.context_type, data.context_id,
        data.storage_key, data.filename, data.file_size, data.content_type,
        data.status, data.storage_class, data.uploader_id,
        data.created_at, data.updated_at,
      ]
    );
    return result.rows[0];
  }

  /**
   * RLY-20260806-093(S4) — 엔티티 이미지 3종(USER_AVATAR·BINDER_AVATAR·CAST_COVER)은 이
   * 메서드로 조회할 수 없다(media.md §2-3 — 정체성 데이터, 숨김/삭제 부적절). 현재 코드베이스의
   * 유일한 호출부가 `binderService.deleteAttachment`(파일함 개별 삭제)의 존재·소유 확인이다 —
   * 여기서 못 찾게 하면 그 함수의 기존 `if (!attachment ...) throw NotFoundError`가 그대로
   * 발동해 "파일함에서 프로필 사진을 지울 수 있던" 결함이 닫힌다(`binderService.js`는 다른
   * Writer가 작업 중이라 직접 건드리지 않았다 — 이 DAO 메서드 안에서만 닫는다). 새 호출부가
   * 필요해지면(예: 관리자 도구) 전용 메서드로 분리한다 — 지금은 유일 호출부라 분리하지 않는다.
   */
  async findById(conn, id) {
    const result = await conn.query(
      `SELECT * FROM attachments
       WHERE id = $1 AND deleted_at IS NULL
         AND context_type NOT IN ('USER_AVATAR','BINDER_AVATAR','CAST_COVER')`,
      [id]
    );
    return result.rows[0] || null;
  }

  async findByContext(conn, contextType, contextId) {
    const result = await conn.query(
      `SELECT * FROM attachments
       WHERE context_type = $1 AND context_id = $2
         AND deleted_at IS NULL
       ORDER BY display_order ASC, created_at ASC`,
      [contextType, contextId]
    );
    return result.rows;
  }

  async findByBinder(conn, binderId, userId, { context_type, q, cursor_at, limit = 30 } = {}) {
    const params = [binderId, limit, userId];
    const conditions = [
      'a.binder_id = $1',
      'a.deleted_at IS NULL',
      "a.status IN ('ready', 'hidden')",
      // RLY-20260806-093(S4) — media.md §2-3: 엔티티 이미지 3종은 파일함 목록 대상이 아니다
      // (정체성 데이터, 첨부처럼 다루면 안 된다). USER_AVATAR는 binder_id가 null이라 위
      // 'a.binder_id = $1' 조건으로 이미 자연히 빠지지만, BINDER_AVATAR·CAST_COVER는
      // binder_id가 그 바인더로 채워져 있어(§4-1 서버 Step7) 이 조건 없이는 새어 나온다 —
      // S1·S2가 이 두 종류의 attachments 행을 만들기 시작한 순간부터 있던 결함이었다.
      "a.context_type NOT IN ('USER_AVATAR','BINDER_AVATAR','CAST_COVER')",
      `(a.context_type <> 'SECTION_MESSAGE' OR EXISTS (
        SELECT 1 FROM section_messages sm
        JOIN sections s ON s.id = sm.section_id
        WHERE sm.id = a.context_id AND s.deleted_at IS NULL
          AND (s.access_scope = 0 OR EXISTS (
            SELECT 1 FROM section_members secm
            WHERE secm.section_id = s.id AND secm.user_id = $3 AND secm.deleted_at IS NULL
          )
      ))`,
    ];

    if (context_type) {
      params.push(context_type);
      conditions.push(`a.context_type = $${params.length}`);
    }
    if (q && q.length >= 2) {
      params.push(`%${q}%`);
      conditions.push(`a.filename ILIKE $${params.length}`);
    }
    if (cursor_at) {
      params.push(cursor_at);
      conditions.push(`a.created_at < $${params.length}`);
    }

    const result = await conn.query(
      `SELECT a.*, ui.display_name AS uploader_name
       FROM attachments a
       LEFT JOIN user_infos ui ON a.uploader_id = ui.user_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.created_at DESC LIMIT $2`,
      params
    );
    return result.rows;
  }

  async markStatus(conn, id, status) {
    const result = await conn.query(
      `UPDATE attachments SET status = $1, updated_at = now()
       WHERE id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [status, id]
    );
    return result.rows[0];
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RLY-20260806-047 — Worker(media.md §4-4) claim/lease. reminderDAO.claimDueBatch·
  // markSent·markFailed·giveUp과 컬럼명·패턴 모두 동일(system.md §10-13 "이 계약은
  // reminder 전용이 아니다" — 재사용, 새 구조 아님).
  // ═══════════════════════════════════════════════════════════════════════

  // "조회 후 갱신"이 아니라 단일 UPDATE 문 안에서 후보 선정(FOR UPDATE SKIP LOCKED)과
  // claim이 함께 일어난다(reminderDAO.claimDueBatch와 동일 이유 — 경합 시 중복 claim 방지).
  async claimProcessingBatch(conn, { claimToken, limit = 50, leaseMinutes = 5, maxAttempts = 5 }) {
    const result = await conn.query(
      `UPDATE attachments
       SET claim_token = $1, claimed_at = now(), attempt_count = attempt_count + 1, updated_at = now()
       WHERE id IN (
         SELECT id FROM attachments
         WHERE status = 'processing'
           AND (claim_token IS NULL OR claimed_at < now() - ($2 || ' minutes')::interval)
           AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           AND attempt_count < $3
         ORDER BY created_at ASC
         LIMIT $4
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, context_type, context_id, binder_id, storage_key, filename,
                 content_type, file_size, attempt_count, created_at`,
      [claimToken, leaseMinutes, maxAttempts, limit]
    );
    // created_at — RLY-20260806-091(S3): 엔티티 이미지 3종의 순서 역전 가드(media.md §4-4
    // Step5-a)가 "이 행보다 created_at이 더 최신인 미삭제 형제 행이 있는가"를 판정하는 데 쓴다.
    return result.rows;
  }

  // Step5 성공 종결 — status='ready' + thumbnail_url(파생 미디어 있는 타입만, 없으면 null 유지).
  // claim_token 일치를 WHERE에 건다 — lease 만료 후 다른 워커가 이미 재claim했으면 이 UPDATE는
  // 0행 매칭으로 조용히 무효화된다(reminderDAO.markSent와 동일 원리).
  // RLY-20260806-108 — durationSecs 파라미터 추가(오디오·비디오 전용, media.md:356·367).
  // 생략(undefined)이면 기존 값을 그대로 둔다(COALESCE) — 이미지·엔티티 이미지 3종의 기존
  // 호출부는 5번째 인자를 넘기지 않으므로 동작 불변.
  async markReady(conn, id, claimToken, thumbnailUrl, durationSecs) {
    const result = await conn.query(
      `UPDATE attachments
       SET status = 'ready', thumbnail_url = COALESCE($3, thumbnail_url),
           duration_secs = COALESCE($4, duration_secs),
           claim_token = NULL, claimed_at = NULL, updated_at = now()
       WHERE id = $1 AND claim_token = $2
       RETURNING id`,
      [id, claimToken, thumbnailUrl || null, durationSecs ?? null]
    );
    return result.rows.length > 0;
  }

  // Step1·2 — 판정이 끝난 거부(MIME 위변조·악성코드). 재시도 대상이 아니다(콘텐츠 자체의
  // 판정이라 다시 시도해도 같은 결과다) — reminderDAO.giveUp과 달리 즉시 종결한다.
  async markRejected(conn, id, claimToken) {
    const result = await conn.query(
      `UPDATE attachments
       SET status = 'rejected', claim_token = NULL, claimed_at = NULL, updated_at = now()
       WHERE id = $1 AND claim_token = $2
       RETURNING storage_key`,
      [id, claimToken]
    );
    return result.rows[0] || null;
  }

  // 일시적 실패(GCS 네트워크 오류 등) — 지수 백오프로 next_attempt_at을 미루고 lease를 놓는다.
  // reminderDAO.markFailed와 동일.
  async markFailed(conn, id, claimToken, nextAttemptAt) {
    const result = await conn.query(
      `UPDATE attachments
       SET claim_token = NULL, claimed_at = NULL, next_attempt_at = $1, updated_at = now()
       WHERE id = $2 AND claim_token = $3
       RETURNING id`,
      [nextAttemptAt, id, claimToken]
    );
    return result.rows.length > 0;
  }

  // 재시도 상한 도달 — reminderDAO.giveUp은 sent_at으로 "완료"를 가장하지만(리마인더는 늦은
  // 발송보다 미발송이 낫다), attachments엔 media.md:186이 정의한 'error'(기술적 실패) 상태가
  // 이미 있다 — 그것을 그대로 쓴다. 거짓으로 'ready' 처리하지 않는다.
  async markError(conn, id, claimToken) {
    const result = await conn.query(
      `UPDATE attachments
       SET status = 'error', claim_token = NULL, claimed_at = NULL, updated_at = now()
       WHERE id = $1 AND claim_token = $2
       RETURNING id`,
      [id, claimToken]
    );
    return result.rows.length > 0;
  }

  async markHidden(conn, ids) {
    if (!ids || ids.length === 0) return 0;
    const result = await conn.query(
      `UPDATE attachments
       SET status = 'hidden', hidden_at = now(), updated_at = now()
       WHERE id = ANY($1) AND status = 'ready'`,
      [ids]
    );
    return result.rowCount;
  }

  async markStorageClass(conn, ids, storageClass) {
    if (!ids || ids.length === 0) return 0;
    const result = await conn.query(
      `UPDATE attachments
       SET storage_class = $1, updated_at = now()
       WHERE id = ANY($2)`,
      [storageClass, ids]
    );
    return result.rowCount;
  }

  /**
   * RLY-20260806-093(S4) — media.md §2-3·§6: 엔티티 이미지 3종은 이 생명주기 cron의 대상이
   * 아니다("정체성 데이터 — 숨김/삭제 부적절"). 이 제외가 빠지면 실제로 발생하는 결과: (1)
   * BINDER_AVATAR·CAST_COVER는 binder_id가 채워져 있어 그 바인더에 활성 Boost가 없으면 이
   * LEFT JOIN 조건(`db.binder_id IS NULL`)을 그대로 통과한다. (2) USER_AVATAR는 binder_id가
   * null이라 `a.binder_id = db.binder_id`가 어떤 행과도 매치하지 않으므로 LEFT JOIN 결과도
   * `db.binder_id IS NULL`이 되어 — **바인더가 아예 없는데도** 같은 조건을 통과해버린다. 즉
   * 세 종류 다 이 필터 없이는 새어 나온다. 이 필터가 빠지면 1년 뒤 프로필 사진이 숨김
   * 처리(hidden)돼 Boost 결제 없이는 볼 수 없게 된다(media.md §6 경고 그대로).
   */
  async findExpiredFreeAttachments(conn) {
    const result = await conn.query(
      `SELECT a.id, a.storage_key, a.binder_id
       FROM attachments a
       LEFT JOIN binder_boosts db
         ON a.binder_id = db.binder_id
         AND db.status = 'active'
         AND db.current_period_end > NOW()
       WHERE a.status = 'ready'
         AND a.deleted_at IS NULL
         AND db.binder_id IS NULL
         AND a.created_at < NOW() - INTERVAL '365 days'
         AND a.context_type NOT IN ('USER_AVATAR','BINDER_AVATAR','CAST_COVER')`
    );
    return result.rows;
  }

  /**
   * RLY-20260806-093(S4) — 위와 같은 이유의 방어(defense-in-depth). `findExpiredFreeAttachments`
   * 가 엔티티 이미지 3종을 애초에 `status='hidden'`으로 만들지 않으므로 이 쿼리(`status='hidden'`
   * 조건)는 이론상 이 3종을 볼 일이 없지만, media.md §6이 "본 절의 모든 cron"이라고 명시적으로
   * 못박은 대로 각 쿼리에 동일 제외를 반복해 둔다(§6 도입부 주석 — 가독성을 위해 문서엔 한 번만
   * 적혀 있지만 코드는 각 쿼리에 반복하는 게 안전하다는 판단, 위 쿼리와 같은 근거).
   */
  async findByStorageClassForTransition(conn, storageClass, hiddenInterval) {
    const result = await conn.query(
      `SELECT id, storage_key FROM attachments
       WHERE status = 'hidden'
         AND deleted_at IS NULL
         AND storage_class = $1
         AND hidden_at < NOW() - INTERVAL '${hiddenInterval}'
         AND context_type NOT IN ('USER_AVATAR','BINDER_AVATAR','CAST_COVER')`,
      [storageClass]
    );
    return result.rows;
  }

  async findBySection(conn, sectionId, { q, cursor_at, limit = 30 } = {}) {
    const params = [sectionId, limit];
    const conditions = [
      'sm.section_id = $1',
      'sm.deleted_at IS NULL',
      "a.context_type = 'SECTION_MESSAGE'",
      'a.deleted_at IS NULL',
      "a.status IN ('ready', 'hidden')",
    ];

    if (q && q.length >= 2) {
      params.push(`%${q}%`);
      conditions.push(`a.filename ILIKE $${params.length}`);
    }
    if (cursor_at) {
      params.push(cursor_at);
      conditions.push(`a.created_at < $${params.length}`);
    }

    const result = await conn.query(
      `SELECT a.*,
              ui.display_name AS uploader_name,
              sm.id AS source_message_id,
              sm.content AS source_message_preview,
              sm.created_at AS source_message_at
       FROM attachments a
       JOIN section_messages sm ON sm.id = a.context_id
       LEFT JOIN user_infos ui ON a.uploader_id = ui.user_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.created_at DESC LIMIT $2`,
      params
    );
    return result.rows;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RLY-20260806-091(S3) — media.md §4-4 Step5, 엔티티 이미지 3종(USER_AVATAR·BINDER_AVATAR·
  // CAST_COVER) 전용 (a)~(d) 시퀀스. mediaWorkerJobs.js가 한 트랜잭션 안에서 순서대로 호출한다.
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * (a) 순서 역전 가드 — 같은 (context_type, context_id)에 이 행보다 created_at이 더 최신인
   * 미삭제 형제 행이 있는지 확인한다. 있으면 "빠른 연속 교체에서 늦게 끝난 옛 업로드가 최신
   * 사진을 덮으려는 것"이므로 포인터를 옮기면 안 된다(media.md §4-4 Step5-a).
   */
  async findNewerActiveSibling(conn, { contextType, contextId, excludeId, afterCreatedAt }) {
    const result = await conn.query(
      `SELECT id FROM attachments
       WHERE context_type = $1 AND context_id = $2 AND id <> $3
         AND deleted_at IS NULL AND created_at > $4
       LIMIT 1`,
      [contextType, contextId, excludeId, afterCreatedAt]
    );
    return result.rows[0] || null;
  }

  /**
   * (a)의 결과 — 이 행은 이미 뒤처졌다. 포인터는 건드리지 않고 이 행만 종결한다.
   *
   * 문서(media.md §4-4 Step5-a)는 "이 행만 deleted_at 처리하고 종료"라고만 쓴다. 다만
   * status를 그대로 'processing'에 두면 claimProcessingBatch(WHERE status='processing' —
   * deleted_at은 안 봄)가 이 행을 계속 재claim해 attempt_count가 소진될 때까지 무의미한
   * 재처리를 반복한다. 새 상태값을 만들지 않고 기존 'ready'(이 파일 자체는 Step1~4를 실제로
   * 통과했다 — 표시가 안 될 뿐이다)로 전환해 claim 대상에서 자연스럽게 빠지게 한다(Writer
   * 판단 — 문서가 status를 명시하지 않아 직접 정한 해석). claimProcessingBatch의 WHERE 절은
   * 첨부 6종과 공유하므로 여기서 건드리지 않았다 — 6종 동작 불변 요건과 충돌하지 않는다.
   */
  async markSuperseded(conn, id, claimToken, thumbnailUrl) {
    const result = await conn.query(
      `UPDATE attachments
       SET status = 'ready', thumbnail_url = COALESCE($3, thumbnail_url),
           claim_token = NULL, claimed_at = NULL, deleted_at = now(), updated_at = now()
       WHERE id = $1 AND claim_token = $2
       RETURNING id`,
      [id, claimToken, thumbnailUrl || null]
    );
    return result.rows.length > 0;
  }

  /**
   * (c) 엔티티 포인터 갱신 — full(1080px)·thumb(720px) 파생 URL을 대상 엔티티 컬럼에 옮긴다.
   * 실재 컬럼: user_infos.image_url/thumbnail_url · binders.image_url/thumbnail_url ·
   * casts.cover_image_url/thumbnail_url(userDAO.js·binderDAO.js·castDAO.js로 확인 —
   * 문서가 한때 적었던 `users.profile_image_url`·`binders.cover_image_url`은 실재하지 않는다).
   * (b)에서 status='ready' 전환이 성공했을 때만 호출된다 — 실패 경로는 이 함수에 도달하지
   * 않으므로 포인터는 자동으로 이전 값 그대로 남는다(별도 롤백 로직 불필요).
   */
  async updateEntityImagePointer(conn, contextType, contextId, fullUrl, thumbUrl) {
    if (contextType === 'USER_AVATAR') {
      await conn.query(
        `UPDATE user_infos SET image_url = $1, thumbnail_url = $2, updated_at = now() WHERE user_id = $3`,
        [fullUrl, thumbUrl, contextId]
      );
    } else if (contextType === 'BINDER_AVATAR') {
      await conn.query(
        `UPDATE binders SET image_url = $1, thumbnail_url = $2, updated_at = now() WHERE id = $3`,
        [fullUrl, thumbUrl, contextId]
      );
    } else if (contextType === 'CAST_COVER') {
      await conn.query(
        `UPDATE casts SET cover_image_url = $1, thumbnail_url = $2, updated_at = now() WHERE id = $3`,
        [fullUrl, thumbUrl, contextId]
      );
    }
  }

  /**
   * (d) 이전 세대 정리 — 같은 (context_type, context_id)의 다른 활성 행을 전부 소프트 삭제한다.
   * 새 정리 메커니즘을 만들지 않는다 — 이후는 첨부와 동일한 규약(30일 뒤 하드 삭제 배치가
   * 마지막 참조 가드를 확인하고 GCS 원본을 지운다, §8-1).
   */
  async markOtherGenerationsDeleted(conn, contextType, contextId, keepId) {
    const result = await conn.query(
      `UPDATE attachments SET deleted_at = now(), updated_at = now()
       WHERE context_type = $1 AND context_id = $2 AND id <> $3 AND deleted_at IS NULL`,
      [contextType, contextId, keepId]
    );
    return result.rowCount;
  }

  async softDelete(conn, id) {
    const result = await conn.query(
      `UPDATE attachments SET deleted_at = now(), updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, binder_id, storage_key, file_size`,
      [id]
    );
    return result.rows[0] || null;
  }

  // ============================================
  // F-S9 — binder_storage_usage 집계 (결정 33 · 결정 56)
  // ============================================

  /**
   * storage_key 단위 최초/마지막 판정으로 binder_storage_usage 를 원자 갱신한다.
   * 결정 56: storage_key 를 여러 attachments 행이 공유할 수 있으므로(복제) "행 하나마다
   * ±file_size" 가 아니라 "이 바인더에서 이 키가 유일한 활성(deleted_at IS NULL) 행인가"만 본다.
   * 판정 쿼리는 결정 56의 하드 삭제 가드(F-S6 C56-2)와 같은 술어를 쓴다 — attachments(storage_key)
   * 인덱스를 공유한다(F-S0 idx_att_storage_key).
   *
   * @param {object} conn - Pool 또는 트랜잭션 client. 호출부가 첨부 행 갱신과 같은 트랜잭션에서 호출해야 한다.
   * @param {object} params
   * @param {string} params.binderId
   * @param {string} params.storageKey
   * @param {number|string} params.fileSize
   * @param {string} params.attachmentId - 판정에서 자기 자신을 제외하기 위한 id (신규/삭제 대상 행 모두 자신 제외로 충분 — 순서 무관)
   * @param {1|-1} params.sign - +1: 등장(confirm·복원) · -1: 소멸(soft delete)
   * @returns {number} 실제로 반영된 delta bytes (0이면 경계가 아니어서 갱신하지 않음)
   */
  async applyStorageDelta(conn, { binderId, storageKey, fileSize, attachmentId, sign }) {
    const size = Number(fileSize) || 0;
    if (!size || !storageKey || !binderId) return 0;

    const guard = await conn.query(
      `SELECT NOT EXISTS (
         SELECT 1 FROM attachments
         WHERE binder_id = $1 AND storage_key = $2
           AND deleted_at IS NULL AND id <> $3
       ) AS is_boundary`,
      [binderId, storageKey, attachmentId]
    );
    if (!guard.rows[0].is_boundary) return 0;

    const delta = sign * size;
    await conn.query(
      `INSERT INTO binder_storage_usage (binder_id, bytes_used, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (binder_id) DO UPDATE
         SET bytes_used = binder_storage_usage.bytes_used + $2,
             updated_at = now()`,
      [binderId, delta]
    );
    return delta;
  }

  async getBytesUsed(conn, binderId) {
    const result = await conn.query(
      `SELECT bytes_used FROM binder_storage_usage WHERE binder_id = $1`,
      [binderId]
    );
    return result.rows[0] ? Number(result.rows[0].bytes_used) : 0;
  }

  /**
   * binder의 tier(SMALLINT 0=free 1=lite 2=plus) — binder_boosts.tier(활성 구독만) 기준,
   * 없으면 Free(0). RLY-20260806-072 — getStorageLimitBytes(바인더 총량 한도)와
   * presign의 파일 1건당 상한(media.md §3-1) 검사가 같은 tier 조회를 공유하도록 분리했다
   * (기존 getStorageLimitBytes의 쿼리를 그대로 옮긴 것 — SQL 텍스트 불변).
   * ⛔ Boost 구매 흐름은 별도 Task(출시 후 오픈) — 여기서는 한도 판정을 위해 tier만 읽는다.
   */
  async getTier(conn, binderId) {
    const result = await conn.query(
      `SELECT COALESCE(bb.tier, 0) AS tier
       FROM binders b
       LEFT JOIN binder_boosts bb ON bb.binder_id = b.id AND bb.status = 'ACTIVE'
       WHERE b.id = $1`,
      [binderId]
    );
    return result.rows[0] ? result.rows[0].tier : 0;
  }

  /**
   * binder의 저장 한도(bytes) — getTier 기준.
   */
  async getStorageLimitBytes(conn, binderId) {
    const tier = await this.getTier(conn, binderId);
    return TIER_STORAGE_LIMIT_BYTES[tier] ?? TIER_STORAGE_LIMIT_BYTES[0];
  }
}

module.exports = { AttachmentDAO: new AttachmentDAO(), TIER_STORAGE_LIMIT_BYTES };
