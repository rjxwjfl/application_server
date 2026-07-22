class SectionDAO {
  async findById(conn, sectionId, lock = false) {
    const { rows } = await conn.query(
      `SELECT id, binder_id, title, access_scope, group_id, is_default, created_at, updated_at, deleted_at
       FROM sections WHERE id = $1 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`, [sectionId]
    );
    return rows[0] || null;
  }

  async findByBinderId(conn, binderId, userId) {
    const { rows } = await conn.query(
      `SELECT s.id, s.binder_id, s.title, s.access_scope, s.group_id, s.is_default,
              s.created_at, s.updated_at,
              (SELECT COUNT(*)::int FROM group_members gm WHERE gm.group_id = s.group_id AND gm.deleted_at IS NULL) AS valid_member_count
       FROM sections s
       WHERE s.binder_id = $1 AND s.deleted_at IS NULL
         AND (s.access_scope = 0 OR (s.access_scope = 1 AND s.group_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM group_members gm WHERE gm.group_id = s.group_id AND gm.user_id = $2 AND gm.deleted_at IS NULL
         )) OR EXISTS (
           SELECT 1 FROM binder_members bm WHERE bm.binder_id = s.binder_id AND bm.user_id = $2
             AND bm.role <= 1 AND bm.deleted_at IS NULL
         )) ORDER BY s.is_default DESC, s.created_at`, [binderId, userId]
    );
    return rows;
  }

  async create(conn, { id, binder_id, title, access_scope = 0, group_id = null }) {
    const { rows } = await conn.query(
      `INSERT INTO sections (id, binder_id, title, access_scope, group_id, created_at, updated_at)
       SELECT $1, $2, $3, $4, g.id, now(), now() FROM (SELECT $5::uuid AS id) input
       LEFT JOIN groups g ON g.id = input.id AND g.binder_id = $2 AND g.deleted_at IS NULL
       WHERE $5::uuid IS NULL OR g.id IS NOT NULL
       RETURNING id, binder_id, title, access_scope, group_id, is_default, created_at, updated_at`,
      [id, binder_id, title, access_scope, group_id]
    );
    return rows[0] || null;
  }

  async update(conn, sectionId, { title, access_scope, group_id }, hasGroupId) {
    const { rows } = await conn.query(
      `UPDATE sections s SET title = COALESCE($1, s.title), access_scope = COALESCE($2, s.access_scope),
         group_id = CASE WHEN $3::boolean THEN $4 ELSE s.group_id END, updated_at = now()
       WHERE s.id = $5 AND s.deleted_at IS NULL AND ($4::uuid IS NULL OR EXISTS (
         SELECT 1 FROM groups g WHERE g.id = $4 AND g.binder_id = s.binder_id AND g.deleted_at IS NULL))
       RETURNING id, binder_id, title, access_scope, group_id, is_default, created_at, updated_at`,
      [title, access_scope, hasGroupId, group_id, sectionId]
    );
    return rows[0] || null;
  }

  async hasAccess(conn, sectionId, userId) {
    const { rowCount } = await conn.query(
      `SELECT 1 FROM sections s JOIN binder_members bm ON bm.binder_id = s.binder_id AND bm.user_id = $2 AND bm.deleted_at IS NULL
       WHERE s.id = $1 AND s.deleted_at IS NULL AND (s.access_scope = 0 OR
         (s.access_scope = 1 AND s.group_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM group_members gm WHERE gm.group_id = s.group_id AND gm.user_id = $2 AND gm.deleted_at IS NULL)))`,
      [sectionId, userId]
    );
    return rowCount > 0;
  }

  async findSectionIdByMessage(conn, messageId) {
    const { rows } = await conn.query(`SELECT section_id FROM section_messages WHERE id = $1 AND deleted_at IS NULL`, [messageId]);
    return rows[0]?.section_id || null;
  }

  async softDelete(conn, sectionId) {
    const { rowCount } = await conn.query(`UPDATE sections SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL AND is_default = FALSE`, [sectionId]);
    return rowCount > 0;
  }
}

module.exports = { SectionDAO: new SectionDAO() };
