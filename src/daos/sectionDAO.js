class SectionDAO {
  async findById(conn, sectionId, lock = false) {
    const { rows } = await conn.query(
      `SELECT id, binder_id, title, access_scope, is_default, created_at, updated_at, deleted_at
       FROM sections WHERE id = $1 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`, [sectionId]
    );
    return rows[0] || null;
  }

  async findByBinderId(conn, binderId, userId) {
    const { rows } = await conn.query(
      `SELECT s.id, s.binder_id, s.title, s.access_scope, s.is_default, s.created_at, s.updated_at
       FROM sections s
       WHERE s.binder_id = $1 AND s.deleted_at IS NULL
         AND (s.access_scope = 0 OR EXISTS (
           SELECT 1 FROM section_groups sg JOIN group_members gm ON gm.group_id = sg.group_id
           WHERE sg.section_id = s.id AND gm.user_id = $2 AND sg.deleted_at IS NULL AND gm.deleted_at IS NULL
         ) OR EXISTS (
           SELECT 1 FROM binder_members bm WHERE bm.binder_id = s.binder_id AND bm.user_id = $2
             AND bm.role <= 1 AND bm.deleted_at IS NULL
         )) ORDER BY s.is_default DESC, s.created_at`, [binderId, userId]
    );
    return rows;
  }

  async create(conn, { id, binder_id, title, access_scope = 0 }) {
    const { rows } = await conn.query(
      `INSERT INTO sections (id, binder_id, title, access_scope, created_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())
       RETURNING id, binder_id, title, access_scope, is_default, created_at, updated_at`,
      [id, binder_id, title, access_scope]
    );
    return rows[0];
  }

  async update(conn, sectionId, { title, access_scope }) {
    const { rows } = await conn.query(
      `UPDATE sections SET title = COALESCE($1, title), access_scope = COALESCE($2, access_scope), updated_at = now()
       WHERE id = $3 AND deleted_at IS NULL
       RETURNING id, binder_id, title, access_scope, is_default, created_at, updated_at`,
      [title, access_scope, sectionId]
    );
    return rows[0];
  }

  async replaceGroups(conn, sectionId, grants) {
    await conn.query(`UPDATE section_groups SET deleted_at = now(), updated_at = now() WHERE section_id = $1 AND deleted_at IS NULL`, [sectionId]);
    for (const { id, groupId } of grants) {
      const { rowCount } = await conn.query(
        `INSERT INTO section_groups (id, section_id, group_id)
         SELECT $1, s.id, g.id FROM sections s JOIN groups g ON g.binder_id = s.binder_id
         WHERE s.id = $2 AND g.id = $3 AND g.deleted_at IS NULL`, [id, sectionId, groupId]
      );
      if (!rowCount) throw new Error('GROUP_BINDER_MISMATCH');
    }
  }

  async addGroup(conn, id, sectionId, groupId) {
    const { rows } = await conn.query(
      `INSERT INTO section_groups (id, section_id, group_id)
       SELECT $1, s.id, g.id FROM sections s JOIN groups g ON g.binder_id = s.binder_id
       WHERE s.id = $2 AND g.id = $3 AND g.deleted_at IS NULL RETURNING *`, [id, sectionId, groupId]
    );
    return rows[0];
  }

  async removeGroup(conn, sectionId, groupId) {
    const { rowCount } = await conn.query(
      `UPDATE section_groups SET deleted_at = now(), updated_at = now()
       WHERE section_id = $1 AND group_id = $2 AND deleted_at IS NULL`, [sectionId, groupId]
    );
    return rowCount > 0;
  }

  async countGroups(conn, sectionId) {
    const { rows } = await conn.query(`SELECT COUNT(*)::int count FROM section_groups WHERE section_id = $1 AND deleted_at IS NULL`, [sectionId]);
    return rows[0].count;
  }

  async isLastGrantGroup(conn, groupId) {
    const { rowCount } = await conn.query(
      `SELECT 1 FROM section_groups sg JOIN sections s ON s.id = sg.section_id
       WHERE sg.group_id = $1 AND sg.deleted_at IS NULL AND s.deleted_at IS NULL AND s.access_scope = 1
         AND 1 = (SELECT COUNT(*) FROM section_groups x WHERE x.section_id = s.id AND x.deleted_at IS NULL)
       LIMIT 1`, [groupId]
    );
    return rowCount > 0;
  }

  async hasAccess(conn, sectionId, userId) {
    const { rowCount } = await conn.query(
      `SELECT 1 FROM sections s JOIN binder_members bm ON bm.binder_id = s.binder_id AND bm.user_id = $2 AND bm.deleted_at IS NULL
       WHERE s.id = $1 AND s.deleted_at IS NULL AND (s.access_scope = 0 OR EXISTS (
         SELECT 1 FROM section_groups sg
         JOIN groups g ON g.id = sg.group_id AND g.deleted_at IS NULL
         JOIN group_members gm ON gm.group_id = sg.group_id
         WHERE sg.section_id = s.id AND gm.user_id = $2 AND sg.deleted_at IS NULL AND gm.deleted_at IS NULL))`,
      [sectionId, userId]
    );
    return rowCount > 0;
  }

  async findSectionIdByMessage(conn, messageId) {
    const { rows } = await conn.query(
      `SELECT section_id FROM section_messages WHERE id = $1 AND deleted_at IS NULL`, [messageId]
    );
    return rows[0]?.section_id || null;
  }

  async softDelete(conn, sectionId) {
    const { rowCount } = await conn.query(`UPDATE sections SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL AND is_default = FALSE`, [sectionId]);
    return rowCount > 0;
  }
}

module.exports = { SectionDAO: new SectionDAO() };
