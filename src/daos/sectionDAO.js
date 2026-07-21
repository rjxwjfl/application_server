class SeriesDAO {
  // ============================================
  // Series 테이블
  // ============================================

  async findById(conn, seriesId) {
    const query = `
      SELECT id, drawer_id, title, access_scope, required_grade, is_default,
             created_at, updated_at, deleted_at
      FROM series
      WHERE id = $1 AND deleted_at IS NULL
    `;
    const result = await conn.query(query, [seriesId]);
    return result.rows[0] || null;
  }

  async findByDrawerId(conn, drawerId) {
    const query = `
      SELECT id, drawer_id, title, access_scope, required_grade, is_default,
             created_at, updated_at
      FROM series
      WHERE drawer_id = $1 AND deleted_at IS NULL
      ORDER BY is_default DESC, created_at ASC
    `;
    const result = await conn.query(query, [drawerId]);
    return result.rows;
  }

  async create(conn, { id, drawer_id, title, access_scope, required_grade }) {
    const query = `
      INSERT INTO series (id, drawer_id, title, access_scope, required_grade, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, now(), now())
      RETURNING id, drawer_id, title, access_scope, required_grade, is_default, created_at, updated_at
    `;
    const result = await conn.query(query, [
      id, drawer_id, title, access_scope || 0, required_grade ?? 3,
    ]);
    return result.rows[0];
  }

  async update(conn, seriesId, { title, access_scope, required_grade }) {
    const query = `
      UPDATE series
      SET title = COALESCE($1, title),
          access_scope = COALESCE($2, access_scope),
          required_grade = COALESCE($3, required_grade),
          updated_at = now()
      WHERE id = $4 AND deleted_at IS NULL
      RETURNING id, drawer_id, title, access_scope, required_grade, is_default, created_at, updated_at
    `;
    const result = await conn.query(query, [title, access_scope, required_grade, seriesId]);
    return result.rows[0];
  }

  async softDelete(conn, seriesId) {
    const query = `
      UPDATE series
      SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL AND is_default = FALSE
    `;
    const result = await conn.query(query, [seriesId]);
    return result.rowCount > 0;
  }

}

module.exports = { SeriesDAO: new SeriesDAO() };
