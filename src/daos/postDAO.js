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

  async findByDrawerId(conn, drawerId, { cursor_at, limit = 20 } = {}) {
    const params = [drawerId, limit];
    let where = 'p.drawer_id = $1 AND p.deleted_at IS NULL';
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
         (id, drawer_id, author_id, content, media_urls, is_public, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,false),COALESCE($7,now()),COALESCE($8,now()))
       RETURNING *`,
      [
        data.id, data.drawer_id, data.author_id, data.content,
        data.media_urls ? JSON.stringify(data.media_urls) : null,
        data.is_public, data.created_at, data.updated_at,
      ]
    );
    return result.rows[0];
  }

  async update(conn, id, data) {
    const result = await conn.query(
      `UPDATE posts
       SET content    = COALESCE($1, content),
           media_urls = COALESCE($2, media_urls),
           is_public  = COALESCE($3, is_public),
           updated_at = now()
       WHERE id = $4 AND deleted_at IS NULL
       RETURNING *`,
      [data.content, data.media_urls ? JSON.stringify(data.media_urls) : null, data.is_public, id]
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
      `SELECT * FROM post_likes WHERE post_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [postId, userId]
    );
    return result.rows[0] || null;
  }

  async getLikeCount(conn, postId) {
    const result = await conn.query(
      `SELECT COUNT(*)::int AS count FROM post_likes WHERE post_id = $1 AND deleted_at IS NULL`,
      [postId]
    );
    return result.rows[0].count;
  }

  async createLike(conn, data) {
    const result = await conn.query(
      `INSERT INTO post_likes (id, post_id, user_id, created_at)
       VALUES ($1,$2,$3,COALESCE($4,now()))
       RETURNING *`,
      [data.id, data.post_id, data.user_id, data.created_at]
    );
    return result.rows[0] || null;
  }

  async softDeleteLike(conn, postId, userId) {
    await conn.query(
      `UPDATE post_likes SET deleted_at = now()
       WHERE post_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [postId, userId]
    );
  }

  // ============================================
  // search
  // ============================================

  async searchByDrawer(conn, drawerId, { q, limit = 20 } = {}) {
    const result = await conn.query(
      `SELECT p.id, p.content, p.media_urls, p.created_at,
              ui.display_name AS author_name
       FROM posts p
       LEFT JOIN user_infos ui ON p.author_id = ui.user_id
       WHERE p.drawer_id = $1 AND p.deleted_at IS NULL
         AND p.content ILIKE $2
       ORDER BY p.created_at DESC LIMIT $3`,
      [drawerId, `%${q}%`, limit]
    );
    return result.rows;
  }
}

module.exports = { PostDAO: new PostDAO() };
