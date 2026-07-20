class CastDAO {
  // ============================================
  // casts
  // ============================================

  async findById(conn, id) {
    const result = await conn.query(
      `SELECT * FROM casts WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    return result.rows[0] || null;
  }

  async findByCalId(conn, calId, { cursor_at, limit = 20 } = {}) {
    const params = [calId, limit];
    let where = 'calendar_id = $1 AND deleted_at IS NULL';
    if (cursor_at) {
      where += ' AND created_at < $3';
      params.push(cursor_at);
    }
    const result = await conn.query(
      `SELECT * FROM casts WHERE ${where} ORDER BY created_at DESC LIMIT $2`,
      params
    );
    return result.rows;
  }

  async create(conn, data) {
    const result = await conn.query(
      `INSERT INTO casts
         (id, calendar_id, author_id, title, summary, body_markdown, thumbnail_url,
          cover_image_url, start_time, end_time, locations, forked_from, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13,now()),COALESCE($14,now()))
       RETURNING *`,
      [
        data.id, data.calendar_id, data.author_id, data.title,
        data.summary || null, data.body_markdown || null,
        data.thumbnail_url || null, data.cover_image_url || null,
        data.start_time || null, data.end_time || null,
        data.locations ? JSON.stringify(data.locations) : null,
        data.forked_from || null,
        data.created_at, data.updated_at,
      ]
    );
    return result.rows[0];
  }

  async update(conn, id, data) {
    const result = await conn.query(
      `UPDATE casts
       SET title           = COALESCE($1, title),
           summary         = COALESCE($2, summary),
           body_markdown   = COALESCE($3, body_markdown),
           thumbnail_url   = COALESCE($4, thumbnail_url),
           cover_image_url = COALESCE($5, cover_image_url),
           start_time      = COALESCE($6, start_time),
           end_time        = COALESCE($7, end_time),
           locations       = COALESCE($8, locations),
           updated_at      = now()
       WHERE id = $9 AND deleted_at IS NULL
       RETURNING *`,
      [
        data.title, data.summary, data.body_markdown,
        data.thumbnail_url, data.cover_image_url,
        data.start_time, data.end_time,
        data.locations ? JSON.stringify(data.locations) : null,
        id,
      ]
    );
    return result.rows[0];
  }

  async softDelete(conn, id) {
    await conn.query(
      `UPDATE casts SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
  }

  // ============================================
  // cast_comments
  // ============================================

  async findCommentById(conn, id) {
    const result = await conn.query(
      `SELECT * FROM cast_comments WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    return result.rows[0] || null;
  }

  async findCommentsByCastId(conn, castId, { cursor_at, limit = 30 } = {}) {
    const params = [castId, limit];
    let where = 'cast_id = $1 AND deleted_at IS NULL';
    if (cursor_at) {
      where += ' AND created_at < $3';
      params.push(cursor_at);
    }
    const result = await conn.query(
      `SELECT cc.*, ui.display_name, ui.thumbnail_url AS author_thumbnail
       FROM cast_comments cc
       LEFT JOIN user_infos ui ON cc.user_id = ui.user_id
       WHERE ${where}
       ORDER BY cc.created_at ASC LIMIT $2`,
      params
    );
    return result.rows;
  }

  async createComment(conn, data) {
    const result = await conn.query(
      `INSERT INTO cast_comments (id, cast_id, user_id, parent_id, content, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,now()),COALESCE($7,now()))
       RETURNING *`,
      [data.id, data.cast_id, data.user_id, data.parent_id || null, data.content, data.created_at, data.updated_at]
    );
    return result.rows[0];
  }

  async updateComment(conn, id, content) {
    const result = await conn.query(
      `UPDATE cast_comments SET content = $1, updated_at = now()
       WHERE id = $2 AND deleted_at IS NULL RETURNING *`,
      [content, id]
    );
    return result.rows[0];
  }

  async deleteComment(conn, id) {
    await conn.query(
      `UPDATE cast_comments SET deleted_at = now(), updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
  }
}

module.exports = { CastDAO: new CastDAO() };
