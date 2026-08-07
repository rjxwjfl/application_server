const { ForbiddenError } = require('../core/errors');

class MessageDAO {
  // ============================================
  // Section Messages 테이블
  // ============================================

  async findById(conn, messageId) {
    const query = `
      SELECT id, section_id, user_id, parent_id, content,
             mention_everyone, is_pinned, created_at, updated_at, deleted_at
      FROM section_messages
      WHERE id = $1 AND deleted_at IS NULL
    `;
    const result = await conn.query(query, [messageId]);
    return result.rows[0] || null;
  }

  async getBySectionId(conn, sectionId, { cursor_at, cursor_id, limit = 50 } = {}) {
    let query;
    let params;

    if (cursor_at && cursor_id) {
      query = `
        SELECT id, section_id, user_id, parent_id, content,
               mention_everyone, is_pinned, created_at, updated_at
        FROM section_messages
        WHERE section_id = $1 AND deleted_at IS NULL
          AND (created_at, id) < ($2, $3)
        ORDER BY created_at DESC, id DESC
        LIMIT $4
      `;
      params = [sectionId, cursor_at, cursor_id, limit];
    } else {
      query = `
        SELECT id, section_id, user_id, parent_id, content,
               mention_everyone, is_pinned, created_at, updated_at
        FROM section_messages
        WHERE section_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT $2
      `;
      params = [sectionId, limit];
    }

    const result = await conn.query(query, params);
    return result.rows;
  }

  async create(conn, { id, section_id, user_id, parent_id, content, mention_everyone }) {
    const query = `
      INSERT INTO section_messages (id, section_id, user_id, parent_id, content, mention_everyone, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, now(), now())
      RETURNING id, section_id, user_id, parent_id, content, mention_everyone, is_pinned, created_at, updated_at
    `;
    const result = await conn.query(query, [
      id, section_id, user_id, parent_id || null, content, mention_everyone || false,
    ]);
    return result.rows[0];
  }

  async update(conn, messageId, { content }) {
    const query = `
      UPDATE section_messages
      SET content = COALESCE($1, content), updated_at = now()
      WHERE id = $2 AND deleted_at IS NULL
      RETURNING id, section_id, user_id, parent_id, content, mention_everyone, is_pinned, created_at, updated_at
    `;
    const result = await conn.query(query, [content, messageId]);
    return result.rows[0];
  }

  async softDelete(conn, messageId) {
    const query = `
      UPDATE section_messages
      SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
    `;
    await conn.query(query, [messageId]);
  }

  // RLY-20260806-094 — is_pinned만 NOT으로 토글하고 pinned_at·pinned_by_user_id는 전혀
  // 쓰지 않았다(항상 NULL). SC-messaging.md:1531·1538 — 핀 시 pinned_at=now()·
  // pinned_by_user_id=actor, 해제 시 둘 다 NULL로 되돌린다(마지막 기록 보존 아님). SET
  // 절의 `is_pinned` 참조는 같은 UPDATE 안에서 항상 갱신 전 값이라(Postgres 규약) 토글
  // 방향 판정에 그대로 쓸 수 있다.
  async togglePin(conn, messageId, userId) {
    const query = `
      UPDATE section_messages
      SET is_pinned = NOT is_pinned,
          pinned_at = CASE WHEN is_pinned THEN NULL ELSE now() END,
          pinned_by_user_id = CASE WHEN is_pinned THEN NULL ELSE $2 END,
          updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, is_pinned, pinned_at, pinned_by_user_id
    `;
    const result = await conn.query(query, [messageId, userId]);
    return result.rows[0];
  }

  // RLY-20260806-103 — 핀 한도(섹션당 5개, SC-messaging.md §20-1 Q2·§16-12) 사전 체크용.
  // 호출부(messageService.togglePin)가 "지금부터 핀을 거는 액션"일 때만 이 카운트를 쓴다 —
  // 해제는 한도 검증 대상이 아니다.
  async countPinned(conn, sectionId) {
    const { rows } = await conn.query(
      `SELECT COUNT(*)::int AS count FROM section_messages
       WHERE section_id = $1 AND is_pinned = TRUE AND deleted_at IS NULL`,
      [sectionId]
    );
    return rows[0].count;
  }

  // ============================================
  // Attachments (attachments 테이블 — context_type='SECTION_MESSAGE')
  // ============================================

  // F-S9b(정정 — Architect 판정 "가") — 섹션 메시지 첨부는 presign/confirm으로 이미
  // attachments 행이 만들어져 있다(media.md:334 — 클라가 message_id를 미리 생성해 presign의
  // context_id로 넘긴다). 메시지 생성은 그 행을 "링크"만 한다 — 새 첨부를 만드는 게 아니다.
  // 과금(402 한도 검사·applyStorageDelta)은 presign/confirm 시점에 이미 끝나 있으므로 여기서
  // 다시 하면 이중 계상이다 — 이 함수는 UPDATE만 하고 저장 용량 회계에 관여하지 않는다.
  //
  // 소유·소속 검증을 WHERE 절에 직접 건다(원자적 — 별도 SELECT 왕복·TOCTOU 없음): 그 binder
  // 소속이고, 호출자 본인이 업로드했고, status가 'ready' 또는 'processing'인 행만 링크
  // 대상이다(media.md:306,321 — confirm 직후~Worker 파생물 생성 전인 'processing'도 정상
  // 중간 상태. 거부 대상은 업로드 자체가 안 끝난 'pending'뿐). 아무 id나 넘겨서 남의 첨부·
  // 다른 바인더의 첨부·아직 업로드 안 끝난(pending) 첨부를 자기 메시지에 붙이는 것을 막는다.
  // 요청한 id 수와 실제로 링크된 행 수가 다르면(권한 없음·존재하지 않음·상태 불일치) 전체를
  // 거부한다 — 일부만 조용히 누락시키지 않는다.
  //
  // 멱등: context_id가 이미 이 messageId인 행도 WHERE 조건을 통과해 그대로 재확정된다
  // (media.md:334 "이미 동일 context_id로 연결된 첨부를 멱등 재확인" — 재전송 안전).
  // context_id가 NULL인 행(사전 링크 없이 presign된 구형 클라 호환)은 여기서 처음 채워진다.
  // 이미 "다른" context_id로 확정된 행(다른 메시지에 이미 링크됨)은 대상에서 제외된다.
  async linkAttachments(conn, messageId, binderId, uploaderId, attachments) {
    if (!attachments || attachments.length === 0) return [];

    const ids = [...new Set(attachments.map((a) => (typeof a === 'string' ? a : a.id)).filter(Boolean))];
    if (ids.length === 0) return [];

    const result = await conn.query(
      `UPDATE attachments
       SET context_id = $2, updated_at = now()
       WHERE id = ANY($1)
         AND context_type = 'SECTION_MESSAGE'
         AND binder_id = $3
         AND uploader_id = $4
         AND status IN ('ready', 'processing')
         AND deleted_at IS NULL
         AND (context_id IS NULL OR context_id = $2)
       RETURNING id, context_id AS message_id, filename, file_size, content_type, storage_key, status`,
      [ids, messageId, binderId, uploaderId]
    );

    if (result.rows.length !== ids.length) {
      throw new ForbiddenError('첨부 파일에 접근할 권한이 없습니다', 'SECTION_ACCESS_DENIED');
    }

    return result.rows;
  }

  async getAttachmentsByMessageId(conn, messageId) {
    const query = `
      SELECT id, context_id AS message_id, filename, file_size, content_type, storage_key, status
      FROM attachments
      WHERE context_type = 'SECTION_MESSAGE' AND context_id = $1 AND deleted_at IS NULL
      ORDER BY created_at ASC
    `;
    const result = await conn.query(query, [messageId]);
    return result.rows;
  }

  async getAttachmentsByMessageIds(conn, messageIds) {
    if (!messageIds || messageIds.length === 0) return [];
    const query = `
      SELECT id, context_id AS message_id, filename, file_size, content_type, storage_key, status
      FROM attachments
      WHERE context_type = 'SECTION_MESSAGE' AND context_id = ANY($1) AND deleted_at IS NULL
      ORDER BY created_at ASC
    `;
    const result = await conn.query(query, [messageIds]);
    return result.rows;
  }

  // ============================================
  // Message Embeds 테이블
  // ============================================

  // RLY-20260806-100 — target_type·target_id·embed_data가 INSERT 컬럼 목록에 없어(087이
  // 판정) F7 링크 카드(캘린더/cast/feed 항목)가 항상 NULL로 저장됐다. link/image/video(기존
  // 임베드)는 target_type이 없으므로 그대로 NULL — 셋 다 있어야 하는 게 아니라 카드 종류일
  // 때만 채워진다(SC-messaging.md §20-2 L2). embed_data는 JSONB — 다른 JSONB 컬럼(eventDao.js
  // locations)과 동일하게 JSON.stringify로 넘긴다. target_id 접근 검증은 호출부
  // (messageService.createMessage)에서 INSERT 전에 수행한다 — 이 DAO는 검증된 값만 받는다.
  async insertEmbeds(conn, messageId, embeds) {
    if (!embeds || embeds.length === 0) return [];

    const values = [];
    const params = [];
    let idx = 1;

    for (const e of embeds) {
      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      params.push(
        e.id, messageId, e.type || 'link', e.url,
        e.title || null, e.description || null, e.site_name || null, e.image_url || null,
        e.target_type || null, e.target_id || null, e.embed_data ? JSON.stringify(e.embed_data) : null,
      );
    }

    const query = `
      INSERT INTO message_embeds (id, message_id, type, url, title, description, site_name, image_url, target_type, target_id, embed_data)
      VALUES ${values.join(', ')}
      RETURNING id, message_id, type, url, title, description, site_name, image_url, target_type, target_id, embed_data
    `;
    const result = await conn.query(query, params);
    return result.rows;
  }

  async getEmbedsByMessageIds(conn, messageIds) {
    if (!messageIds || messageIds.length === 0) return [];
    const query = `
      SELECT id, message_id, type, url, title, description, site_name, image_url, target_type, target_id, embed_data
      FROM message_embeds
      WHERE message_id = ANY($1) AND deleted_at IS NULL
    `;
    const result = await conn.query(query, [messageIds]);
    return result.rows;
  }

  // ============================================
  // Message Reactions 테이블
  // ============================================

  // RLY-20260806-163 — uk_message_reactions_active(message_id,user_id,emoji)는 파샬 유니크
  // (WHERE deleted_at IS NULL)인데 이 ON CONFLICT 절엔 그 predicate가 없었다. Postgres는
  // 파샬 유니크 인덱스를 ON CONFLICT 추론 대상으로 잡으려면 동일한 predicate의 WHERE절이
  // 반드시 있어야 한다 — 없으면 그 자체가 "there is no unique or exclusion constraint
  // matching the ON CONFLICT specification"으로 던진다(실측: Postgres 15 컨테이너, 검증
  // 후 즉시 제거). 즉 이미 활성 반응이 있는 상태에서 같은 사용자가 같은 이모지로 다시
  // 반응을 추가하면(오프라인 큐 재전송, 더블탭 등) 그 즉시 예외 → asyncHandler를 거쳐
  // 500. transport.md §7-1상 5xx는 재시도 대상이라 "다시 시도해도 절대 성공할 수 없는"
  // 요청을 오프라인 큐가 영원히 재시도하며 막힌다.
  //
  // 의도는 그대로 "중복=성공, 기존 행 반환"(DO UPDATE) — WHERE절만 추가해 파샬
  // 인덱스와 매칭시켰다. ⚠️ 단 `SET deleted_at = NULL`은 이 경로에서 실제로 소프트
  // 삭제된 행을 되살리는 게 아니다 — 파샬 인덱스 predicate상 이 ON CONFLICT는 이미
  // deleted_at IS NULL인(즉 항상 활성인) 행에만 매칭되므로 no-op이다(159의 GroupDAO
  // 수정과 동일 사실, 실측 확인). removeReaction 후 재추가는 소프트 삭제된 행이
  // 더는 파샬 인덱스에 안 걸려 충돌 자체가 안 나고, 매번 새 물리 행(새 id)이
  // 만들어진다 — 옛 행은 소프트 삭제 상태로 남는다(반응은 section_members처럼
  // "복원" CTE가 없어 원래도 재사용하지 않았다, 이번에 새로 생긴 차이가 아니다).
  async addReaction(conn, { id, message_id, user_id, emoji }) {
    const query = `
      INSERT INTO message_reactions (id, message_id, user_id, emoji, created_at, updated_at)
      VALUES ($1, $2, $3, $4, now(), now())
      ON CONFLICT (message_id, user_id, emoji) WHERE deleted_at IS NULL DO UPDATE
      SET deleted_at = NULL, updated_at = now()
      RETURNING id, message_id, user_id, emoji, created_at
    `;
    const result = await conn.query(query, [id, message_id, user_id, emoji]);
    return result.rows[0];
  }

  async removeReaction(conn, messageId, userId, emoji) {
    const query = `
      UPDATE message_reactions
      SET deleted_at = now(), updated_at = now()
      WHERE message_id = $1 AND user_id = $2 AND emoji = $3 AND deleted_at IS NULL
    `;
    await conn.query(query, [messageId, userId, emoji]);
  }

  async getReactionsByMessageIds(conn, messageIds) {
    if (!messageIds || messageIds.length === 0) return [];
    const query = `
      SELECT id, message_id, user_id, emoji, created_at
      FROM message_reactions
      WHERE message_id = ANY($1) AND deleted_at IS NULL
    `;
    const result = await conn.query(query, [messageIds]);
    return result.rows;
  }

  // ============================================
  // Message Mentions 테이블
  // ============================================

  // RLY-20260806-163 — uk_message_mentions_active(message_id,user_id)도 파샬 유니크
  // (WHERE deleted_at IS NULL)라 addReaction과 동형 결함이 있었다: predicate 없는
  // ON CONFLICT는 그 자체가 던진다(실측: Postgres 15 컨테이너, 검증 후 즉시 제거).
  //
  // ⚠️ 의도는 반응과 다르게 잡았다 — DO UPDATE(중복=성공, 되살리기)가 아니라
  // DO NOTHING이다. insertMentions는 createMessage 트랜잭션 안에서 **메시지 하나당
  // 정확히 한 번, 한 배치로만** 호출된다(다른 호출부 없음, updateMessage도 멘션을
  // 건드리지 않음 — 직접 확인). 반응처럼 "제거 후 재추가"가 일어날 통로 자체가 없어
  // 되살릴 대상이 없다 — 이 ON CONFLICT는 클라가 같은 메시지의 mentions 배열에
  // 같은 user_id를 중복으로 보낸 경우에 대한 방어용일 뿐이라 "성공이되 아무 것도
  // 갱신하지 않는다"가 맞다. 실무 이유도 있다 — DO UPDATE는 **같은 INSERT 문 안에서
  // 동일 키가 3번 이상 반복되면** "ON CONFLICT DO UPDATE command cannot affect row
  // a second time"로 별도로 던진다(실측 확인) — mentions는 한 배열을 한 번에
  // 다중 VALUES로 넣는 벌크 삽입이라 이 실패 모드에 그대로 노출된다. DO NOTHING은
  // 같은 문 안의 중복이 몇 개든 안전하다.
  async insertMentions(conn, messageId, userIds) {
    if (!userIds || userIds.length === 0) return [];

    const values = [];
    const params = [];
    let idx = 1;

    for (const uid of userIds) {
      values.push(`($${idx++}, $${idx++}, $${idx++})`);
      params.push(uid.id || uid, messageId, uid.user_id || uid);
    }

    const query = `
      INSERT INTO message_mentions (id, message_id, user_id)
      VALUES ${values.join(', ')}
      ON CONFLICT (message_id, user_id) WHERE deleted_at IS NULL DO NOTHING
      RETURNING id, message_id, user_id
    `;
    const result = await conn.query(query, params);
    return result.rows;
  }

  async getMentionsByMessageIds(conn, messageIds) {
    if (!messageIds || messageIds.length === 0) return [];
    const query = `
      SELECT id, message_id, user_id
      FROM message_mentions
      WHERE message_id = ANY($1) AND deleted_at IS NULL
    `;
    const result = await conn.query(query, [messageIds]);
    return result.rows;
  }

  // ============================================
  // 핀 메시지 조회
  // ============================================

  // RLY-20260806-094 — pinned_at·pinned_by_user_id를 이제 togglePin이 채우므로, 이 SELECT도
  // 함께 노출해야 값이 실제로 GET /section/{id}/pinned 응답에 도달한다(안 그러면 쓰기만
  // 고치고 이 REST 응답에서는 여전히 안 보인다). 정렬도 SC-messaging.md §16-13(확정)이
  // "pinned_at DESC(최근 핀이 좌측)"로 못 박아 updated_at 대신 pinned_at으로 바꿨다 —
  // pinned_at이 항상 NULL이던 동안엔 이 정렬 자체가 성립할 수 없어 updated_at으로
  // 대체돼 있었다.
  async findPinned(conn, sectionId) {
    const query = `
      SELECT id, section_id, user_id, parent_id, content,
             mention_everyone, is_pinned, pinned_at, pinned_by_user_id, created_at, updated_at
      FROM section_messages
      WHERE section_id = $1 AND is_pinned = TRUE AND deleted_at IS NULL
      ORDER BY pinned_at DESC
    `;
    const result = await conn.query(query, [sectionId]);
    return result.rows;
  }

  // ============================================
  // Section Message Cursors 테이블 (읽음 위치)
  // ============================================

  async upsertCursor(conn, sectionId, userId, { last_read_message_id, last_read_message_at }) {
    const query = `
      INSERT INTO section_message_cursors (section_id, user_id, last_read_message_id, last_read_message_at, updated_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (section_id, user_id) DO UPDATE
      SET last_read_message_id = $3,
          last_read_message_at = $4,
          updated_at = now()
    `;
    await conn.query(query, [sectionId, userId, last_read_message_id, last_read_message_at]);
  }
}

module.exports = { MessageDAO: new MessageDAO() };
