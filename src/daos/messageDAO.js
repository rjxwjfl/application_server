class MessageDAO {
  // ============================================
  // Series Messages 테이블
  // ============================================

  async findById(conn, messageId) {
    const query = `
      SELECT id, series_id, user_id, parent_id, content,
             mention_everyone, is_pinned, created_at, updated_at, deleted_at
      FROM series_messages
      WHERE id = $1 AND deleted_at IS NULL
    `;
    const result = await conn.query(query, [messageId]);
    return result.rows[0] || null;
  }

  async getBySeriesId(conn, seriesId, { cursor_at, cursor_id, limit = 50 } = {}) {
    let query;
    let params;

    if (cursor_at && cursor_id) {
      query = `
        SELECT id, series_id, user_id, parent_id, content,
               mention_everyone, is_pinned, created_at, updated_at
        FROM series_messages
        WHERE series_id = $1 AND deleted_at IS NULL
          AND (created_at, id) < ($2, $3)
        ORDER BY created_at DESC, id DESC
        LIMIT $4
      `;
      params = [seriesId, cursor_at, cursor_id, limit];
    } else {
      query = `
        SELECT id, series_id, user_id, parent_id, content,
               mention_everyone, is_pinned, created_at, updated_at
        FROM series_messages
        WHERE series_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT $2
      `;
      params = [seriesId, limit];
    }

    const result = await conn.query(query, params);
    return result.rows;
  }

  async create(conn, { id, series_id, user_id, parent_id, content, mention_everyone }) {
    const query = `
      INSERT INTO series_messages (id, series_id, user_id, parent_id, content, mention_everyone, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, now(), now())
      RETURNING id, series_id, user_id, parent_id, content, mention_everyone, is_pinned, created_at, updated_at
    `;
    const result = await conn.query(query, [
      id, series_id, user_id, parent_id || null, content, mention_everyone || false,
    ]);
    return result.rows[0];
  }

  async update(conn, messageId, { content }) {
    const query = `
      UPDATE series_messages
      SET content = COALESCE($1, content), updated_at = now()
      WHERE id = $2 AND deleted_at IS NULL
      RETURNING id, series_id, user_id, parent_id, content, mention_everyone, is_pinned, created_at, updated_at
    `;
    const result = await conn.query(query, [content, messageId]);
    return result.rows[0];
  }

  async softDelete(conn, messageId) {
    const query = `
      UPDATE series_messages
      SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
    `;
    await conn.query(query, [messageId]);
  }

  async togglePin(conn, messageId) {
    const query = `
      UPDATE series_messages
      SET is_pinned = NOT is_pinned, updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, is_pinned
    `;
    const result = await conn.query(query, [messageId]);
    return result.rows[0];
  }

  // ============================================
  // Attachments (attachments 테이블 — context_type='SERIES_MESSAGE')
  // ============================================

  async insertAttachments(conn, messageId, drawerId, uploaderId, attachments) {
    if (!attachments || attachments.length === 0) return [];

    const values = [];
    const params = [];
    let idx = 1;

    for (const a of attachments) {
      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      params.push(
        a.id, drawerId, 'SERIES_MESSAGE', messageId,
        a.storage_key, a.filename || null, a.file_size || null, a.content_type || null,
        uploaderId, 'standard',
      );
    }

    const query = `
      INSERT INTO attachments
        (id, drawer_id, context_type, context_id, storage_key, filename, file_size, content_type, uploader_id, storage_class, status)
      VALUES ${values.join(', ')}
      RETURNING id, context_id AS message_id, filename, file_size, content_type, storage_key, status
    `;
    const result = await conn.query(query, params);
    return result.rows;
  }

  async getAttachmentsByMessageId(conn, messageId) {
    const query = `
      SELECT id, context_id AS message_id, filename, file_size, content_type, storage_key, status
      FROM attachments
      WHERE context_type = 'SERIES_MESSAGE' AND context_id = $1 AND deleted_at IS NULL
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
      WHERE context_type = 'SERIES_MESSAGE' AND context_id = ANY($1) AND deleted_at IS NULL
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

  async findPinned(conn, seriesId) {
    const query = `
      SELECT id, series_id, user_id, parent_id, content,
             mention_everyone, is_pinned, created_at, updated_at
      FROM series_messages
      WHERE series_id = $1 AND is_pinned = TRUE AND deleted_at IS NULL
      ORDER BY updated_at DESC
    `;
    const result = await conn.query(query, [seriesId]);
    return result.rows;
  }

  // ============================================
  // Series Message Cursors 테이블 (읽음 위치)
  // ============================================

  async upsertCursor(conn, seriesId, userId, { last_read_message_id, last_read_message_at }) {
    const query = `
      INSERT INTO series_message_cursors (series_id, user_id, last_read_message_id, last_read_message_at, updated_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (series_id, user_id) DO UPDATE
      SET last_read_message_id = $3,
          last_read_message_at = $4,
          updated_at = now()
    `;
    await conn.query(query, [seriesId, userId, last_read_message_id, last_read_message_at]);
  }
}

module.exports = { MessageDAO: new MessageDAO() };
