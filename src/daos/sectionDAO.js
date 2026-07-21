class SectionDAO {
  // ============================================
  // Section 테이블
  // ============================================

  async findById(conn, sectionId) {
    const query = `
      SELECT id, binder_id, title, access_scope, required_grade, is_default,
             created_at, updated_at, deleted_at
      FROM sections
      WHERE id = $1 AND deleted_at IS NULL
    `;
    const result = await conn.query(query, [sectionId]);
    return result.rows[0] || null;
  }

  async findByBinderId(conn, binderId) {
    const query = `
      SELECT id, binder_id, title, access_scope, required_grade, is_default,
             created_at, updated_at
      FROM sections
      WHERE binder_id = $1 AND deleted_at IS NULL
      ORDER BY is_default DESC, created_at ASC
    `;
    const result = await conn.query(query, [binderId]);
    return result.rows;
  }

  async create(conn, { id, binder_id, title, access_scope, required_grade }) {
    const query = `
      INSERT INTO sections (id, binder_id, title, access_scope, required_grade, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, now(), now())
      RETURNING id, binder_id, title, access_scope, required_grade, is_default, created_at, updated_at
    `;
    const result = await conn.query(query, [
      id, binder_id, title, access_scope || 0, required_grade ?? 3,
    ]);
    return result.rows[0];
  }

  async update(conn, sectionId, { title, access_scope, required_grade }) {
    const query = `
      UPDATE sections
      SET title = COALESCE($1, title),
          access_scope = COALESCE($2, access_scope),
          required_grade = COALESCE($3, required_grade),
          updated_at = now()
      WHERE id = $4 AND deleted_at IS NULL
      RETURNING id, binder_id, title, access_scope, required_grade, is_default, created_at, updated_at
    `;
    const result = await conn.query(query, [title, access_scope, required_grade, sectionId]);
    return result.rows[0];
  }

  async softDelete(conn, sectionId) {
    const query = `
      UPDATE sections
      SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL AND is_default = FALSE
    `;
    const result = await conn.query(query, [sectionId]);
    return result.rowCount > 0;
  }

}

module.exports = { SectionDAO: new SectionDAO() };
