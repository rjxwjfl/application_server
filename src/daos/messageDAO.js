const { AttachmentDAO } = require('./attachmentDAO');

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

  async togglePin(conn, messageId) {
    const query = `
      UPDATE section_messages
      SET is_pinned = NOT is_pinned, updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, is_pinned
    `;
    const result = await conn.query(query, [messageId]);
    return result.rows[0];
  }

  // ============================================
  // Attachments (attachments 테이블 — context_type='SECTION_MESSAGE')
  // ============================================

  // F-S9b — 이 경로는 presign/confirm을 거치지 않고 attachments에 직접 INSERT하는 유일한
  // 우회 지점이었다(mediaService.presign의 402 한도 검사·confirm의 applyStorageDelta 둘 다
  // 건너뜀 — 한도 검사는 messageService.createMessage가 트랜잭션 진입 전에 한다).
  // 여기서는 attachmentDAO.applyStorageDelta 배선만 담당한다. 벌크 다중행 INSERT 대신 한 행씩
  // 삽입 직후 델타를 반영하는 이유: 배열 안에서 같은 storage_key를 공유하는 첨부가 있을 때,
  // 벌크로 먼저 다 넣으면 배치 내 형제 행들이 서로를 "이미 존재하는 다른 활성 행"으로 보고
  // applyStorageDelta의 경계 판정(attachmentDAO.js:199-239)이 전원 스킵된다 — 즉 회계가
  // 통째로 빠진다. 한 행씩 넣고 그 행만 델타를 반영하면, 배치 내 최초 등장만 과금되고
  // 이후 같은 키의 형제는 정확히 0으로 스킵된다(같은 물리 파일을 두 번 과금하지 않음).
  async insertAttachments(conn, messageId, binderId, uploaderId, attachments) {
    if (!attachments || attachments.length === 0) return [];

    const inserted = [];
    for (const a of attachments) {
      const result = await conn.query(
        `INSERT INTO attachments
           (id, binder_id, context_type, context_id, storage_key, filename, file_size, content_type, uploader_id, status, storage_class)
         VALUES ($1, $2, 'SECTION_MESSAGE', $3, $4, $5, $6, $7, $8, 'ready', 'standard')
         RETURNING id, context_id AS message_id, filename, file_size, content_type, storage_key, status`,
        [a.id, binderId, messageId, a.storage_key, a.filename || null, a.file_size || null, a.content_type || null, uploaderId]
      );
      inserted.push(result.rows[0]);

      await AttachmentDAO.applyStorageDelta(conn, {
        binderId,
        storageKey: a.storage_key,
        fileSize: a.file_size,
        attachmentId: a.id,
        sign: 1,
      });
    }
    return inserted;
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

  async insertEmbeds(conn, messageId, embeds) {
    if (!embeds || embeds.length === 0) return [];

    const values = [];
    const params = [];
    let idx = 1;

    for (const e of embeds) {
      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      params.push(
        e.id, messageId, e.type || 'link', e.url,
        e.title || null, e.description || null, e.site_name || null, e.image_url || null,
      );
    }

    const query = `
      INSERT INTO message_embeds (id, message_id, type, url, title, description, site_name, image_url)
      VALUES ${values.join(', ')}
      RETURNING id, message_id, type, url, title, description, site_name, image_url
    `;
    const result = await conn.query(query, params);
    return result.rows;
  }

  async getEmbedsByMessageIds(conn, messageIds) {
    if (!messageIds || messageIds.length === 0) return [];
    const query = `
      SELECT id, message_id, type, url, title, description, site_name, image_url
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

  async findPinned(conn, sectionId) {
    const query = `
      SELECT id, section_id, user_id, parent_id, content,
             mention_everyone, is_pinned, created_at, updated_at
      FROM section_messages
      WHERE section_id = $1 AND is_pinned = TRUE AND deleted_at IS NULL
      ORDER BY updated_at DESC
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
