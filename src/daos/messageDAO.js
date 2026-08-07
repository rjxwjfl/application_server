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

  async addReaction(conn, { id, message_id, user_id, emoji }) {
    const query = `
      INSERT INTO message_reactions (id, message_id, user_id, emoji, created_at, updated_at)
      VALUES ($1, $2, $3, $4, now(), now())
      ON CONFLICT (message_id, user_id, emoji) DO UPDATE
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
      ON CONFLICT (message_id, user_id) DO UPDATE SET deleted_at = NULL, updated_at = now()
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
