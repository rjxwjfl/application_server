class AttachmentDAO {
  async create(conn, data) {
    const result = await conn.query(
      `INSERT INTO attachments
         (id, drawer_id, context_type, context_id, storage_key, filename,
          file_size, content_type, status, storage_class, uploader_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
               COALESCE($9,'pending'), COALESCE($10,'standard'),
               $11, COALESCE($12,now()), COALESCE($13,now()))
       RETURNING *`,
      [
        data.id, data.drawer_id, data.context_type, data.context_id,
        data.storage_key, data.filename, data.file_size, data.content_type,
        data.status, data.storage_class, data.uploader_id,
        data.created_at, data.updated_at,
      ]
    );
    return result.rows[0];
  }

  async findById(conn, id) {
    const result = await conn.query(
      `SELECT * FROM attachments WHERE id = $1 AND deleted_at IS NULL`,
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

  async findByDrawer(conn, drawerId, { context_type, q, cursor_at, limit = 30 } = {}) {
    const params = [drawerId, limit];
    const conditions = [
      'a.drawer_id = $1',
      'a.deleted_at IS NULL',
      "a.status IN ('ready', 'hidden')",
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

  async findExpiredFreeAttachments(conn) {
    const result = await conn.query(
      `SELECT a.id, a.storage_key, a.drawer_id
       FROM attachments a
       LEFT JOIN drawer_boosts db
         ON a.drawer_id = db.drawer_id
         AND db.status = 'active'
         AND db.current_period_end > NOW()
       WHERE a.status = 'ready'
         AND a.deleted_at IS NULL
         AND db.drawer_id IS NULL
         AND a.created_at < NOW() - INTERVAL '365 days'`
    );
    return result.rows;
  }

  async findByStorageClassForTransition(conn, storageClass, hiddenInterval) {
    const result = await conn.query(
      `SELECT id, storage_key FROM attachments
       WHERE status = 'hidden'
         AND deleted_at IS NULL
         AND storage_class = $1
         AND hidden_at < NOW() - INTERVAL '${hiddenInterval}'`,
      [storageClass]
    );
    return result.rows;
  }

  async findBySeries(conn, seriesId, { q, cursor_at, limit = 30 } = {}) {
    const params = [seriesId, limit];
    const conditions = [
      'sm.series_id = $1',
      'sm.deleted_at IS NULL',
      "a.context_type = 'SERIES_MESSAGE'",
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
       JOIN series_messages sm ON sm.id = a.context_id
       LEFT JOIN user_infos ui ON a.uploader_id = ui.user_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.created_at DESC LIMIT $2`,
      params
    );
    return result.rows;
  }

  async softDelete(conn, id) {
    await conn.query(
      `UPDATE attachments SET deleted_at = now(), updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
  }
}

module.exports = { AttachmentDAO: new AttachmentDAO() };
