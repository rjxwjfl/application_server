class PostDAO {
  // ============================================
  // posts
  // ============================================

  async findById(conn, id) {
    const result = await conn.query(
      `SELECT p.*, ui.display_name AS author_name, ui.thumbnail_url AS author_thumbnail
       FROM posts p
       LEFT JOIN user_infos ui ON p.author_id = ui.user_id
       WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [id]
    );
    return result.rows[0] || null;
  }

  async findByBinderId(conn, binderId, { cursor_at, limit = 20 } = {}) {
    const params = [binderId, limit];
    let where = 'p.binder_id = $1 AND p.deleted_at IS NULL';
    if (cursor_at) {
      where += ' AND p.created_at < $3';
      params.push(cursor_at);
    }
    const result = await conn.query(
      `SELECT p.*, ui.display_name AS author_name, ui.thumbnail_url AS author_thumbnail
       FROM posts p
       LEFT JOIN user_infos ui ON p.author_id = ui.user_id
       WHERE ${where} ORDER BY p.created_at DESC LIMIT $2`,
      params
    );
    return result.rows;
  }

  async create(conn, data) {
    const result = await conn.query(
      `INSERT INTO posts
         (id, binder_id, author_id, post_type, is_public, title, body_markdown,
          thumbnail_url, cover_image_url, special_day_id, created_at, updated_at)
       VALUES ($1,$2,$3,COALESCE($4,0),COALESCE($5,false),$6,$7,$8,$9,$10,
               COALESCE($11,now()),COALESCE($12,now()))
       RETURNING *`,
      [
        data.id, data.binder_id, data.author_id, data.post_type, data.is_public,
        data.title, data.body_markdown, data.thumbnail_url, data.cover_image_url,
        data.special_day_id, data.created_at, data.updated_at,
      ]
    );
    return result.rows[0];
  }

  async update(conn, id, data) {
    const result = await conn.query(
      `UPDATE posts
       SET title          = CASE WHEN $1 THEN $2 ELSE title END,
           body_markdown  = COALESCE($3, body_markdown),
           is_public      = COALESCE($4, is_public),
           special_day_id = CASE WHEN $5 THEN $6 ELSE special_day_id END,
           updated_at = now()
       WHERE id = $7 AND deleted_at IS NULL
       RETURNING *`,
      [
        Object.prototype.hasOwnProperty.call(data, 'title'), data.title,
        data.body_markdown, data.is_public,
        Object.prototype.hasOwnProperty.call(data, 'special_day_id'), data.special_day_id,
        id,
      ]
    );
    return result.rows[0];
  }

  async softDelete(conn, id) {
    await conn.query(
      `UPDATE posts SET deleted_at = now(), updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
  }

  // ============================================
  // post_comments
  // ============================================

  async findCommentById(conn, id) {
    const result = await conn.query(
      `SELECT * FROM post_comments WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    return result.rows[0] || null;
  }

  async findCommentsByPostId(conn, postId, { cursor_at, limit = 30 } = {}) {
    const params = [postId, limit];
    let where = 'pc.post_id = $1 AND pc.deleted_at IS NULL';
    if (cursor_at) {
      where += ' AND pc.created_at < $3';
      params.push(cursor_at);
    }
    const result = await conn.query(
      `SELECT pc.*, ui.display_name, ui.thumbnail_url AS author_thumbnail
       FROM post_comments pc
       LEFT JOIN user_infos ui ON pc.user_id = ui.user_id
       WHERE ${where} ORDER BY pc.created_at ASC LIMIT $2`,
      params
    );
    return result.rows;
  }

  async createComment(conn, data) {
    const result = await conn.query(
      `INSERT INTO post_comments (id, post_id, user_id, parent_id, content, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,now()),COALESCE($7,now()))
       RETURNING *`,
      [data.id, data.post_id, data.user_id, data.parent_id || null, data.content, data.created_at, data.updated_at]
    );
    return result.rows[0];
  }

  async updateComment(conn, id, { content }) {
    const result = await conn.query(
      `UPDATE post_comments
       SET content = COALESCE($1, content), updated_at = now()
       WHERE id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [content, id]
    );
    return result.rows[0];
  }

  async softDeleteComment(conn, id) {
    await conn.query(
      `UPDATE post_comments SET deleted_at = now(), updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
  }

  async pinPost(conn, id, is_pinned) {
    const result = await conn.query(
      `UPDATE posts
       SET is_pinned = $1, updated_at = now()
       WHERE id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [is_pinned, id]
    );
    return result.rows[0];
  }

  // ============================================
  // post_likes
  // ============================================

  async findLike(conn, postId, userId) {
    const result = await conn.query(
      `SELECT * FROM post_likes WHERE post_id = $1 AND user_id = $2`,
      [postId, userId]
    );
    return result.rows[0] || null;
  }

  async getLikeCount(conn, postId) {
    const result = await conn.query(
      `SELECT COUNT(*)::int AS count FROM post_likes WHERE post_id = $1`,
      [postId]
    );
    return result.rows[0].count;
  }

  // post_likes에는 id·deleted_at 컬럼이 없다(design_intent.md §post_likes, PK는
  // (post_id, user_id) 자연키 — 단순 토글, soft delete 대상 아님).
  async createLike(conn, data) {
    const result = await conn.query(
      `INSERT INTO post_likes (post_id, user_id, created_at)
       VALUES ($1,$2,COALESCE($3,now()))
       RETURNING *`,
      [data.post_id, data.user_id, data.created_at]
    );
    return result.rows[0] || null;
  }

  // hard delete — SC-post.md 액션D: "liked=false → post_likes DELETE WHERE post_id AND user_id".
  async deleteLike(conn, postId, userId) {
    await conn.query(
      `DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2`,
      [postId, userId]
    );
  }

  // ============================================
  // search
  // ============================================

  async searchByBinder(conn, binderId, { q, limit = 20 } = {}) {
    const result = await conn.query(
      `SELECT p.id, p.title, p.body_markdown, p.created_at,
              ui.display_name AS author_name
       FROM posts p
       LEFT JOIN user_infos ui ON p.author_id = ui.user_id
       WHERE p.binder_id = $1 AND p.deleted_at IS NULL
         AND (p.title ILIKE $2 OR p.body_markdown ILIKE $2)
       ORDER BY p.created_at DESC LIMIT $3`,
      [binderId, `%${q}%`, limit]
    );
    return result.rows;
  }
}

module.exports = { PostDAO: new PostDAO() };
