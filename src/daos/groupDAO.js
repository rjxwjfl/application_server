class GroupDAO {
  async findById(conn, groupId, lock = false) {
    const { rows } = await conn.query(
      `SELECT id, binder_id, name, color, created_by, created_at, updated_at, deleted_at
       FROM groups WHERE id = $1 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
      [groupId]
    );
    return rows[0] || null;
  }

  async createGroup(conn, { id, binderId, name, color, createdBy }) {
    const { rows } = await conn.query(
      `INSERT INTO groups (id, binder_id, name, color, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, binder_id, name, color, created_by, created_at, updated_at`,
      [id, binderId, name, color ?? null, createdBy]
    );
    return rows[0];
  }

  async getGroups(conn, binderId) {
    const { rows } = await conn.query(
      `SELECT g.id, g.binder_id, g.name, g.color, g.created_by, g.created_at, g.updated_at,
              COUNT(DISTINCT gm.user_id)::int AS member_count
       FROM groups g
       LEFT JOIN group_members gm ON gm.group_id = g.id AND gm.deleted_at IS NULL
       WHERE g.binder_id = $1 AND g.deleted_at IS NULL
       GROUP BY g.id ORDER BY g.created_at`,
      [binderId]
    );
    return rows;
  }

  async updateGroup(conn, groupId, { name, color }) {
    const { rows } = await conn.query(
      `UPDATE groups SET name = COALESCE($1, name), color = CASE WHEN $2::boolean THEN $3 ELSE color END,
       updated_at = now() WHERE id = $4 AND deleted_at IS NULL RETURNING *`,
      [name, Object.prototype.hasOwnProperty.call(arguments[2], 'color'), color, groupId]
    );
    return rows[0] || null;
  }

  async deleteGroup(conn, groupId) {
    await conn.query(
      `UPDATE group_members SET deleted_at = now(), updated_at = now()
       WHERE group_id = $1 AND deleted_at IS NULL`, [groupId]
    );
    const { rowCount } = await conn.query(
      `UPDATE groups SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL`, [groupId]
    );
    return rowCount > 0;
  }

  async addMember(conn, { id, groupId, userId }) {
    const { rows } = await conn.query(
      `INSERT INTO group_members (id, group_id, user_id) VALUES ($1, $2, $3)
       RETURNING id, group_id, user_id, created_at, updated_at`, [id, groupId, userId]
    );
    return rows[0];
  }

  async removeMember(conn, groupId, userId) {
    const { rowCount } = await conn.query(
      `UPDATE group_members SET deleted_at = now(), updated_at = now()
       WHERE group_id = $1 AND user_id = $2 AND deleted_at IS NULL`, [groupId, userId]
    );
    return rowCount > 0;
  }

  async getMembers(conn, groupId) {
    const { rows } = await conn.query(
      `SELECT gm.id, gm.group_id, gm.user_id, gm.created_at, gm.updated_at
       FROM group_members gm WHERE gm.group_id = $1 AND gm.deleted_at IS NULL ORDER BY gm.created_at`, [groupId]
    );
    return rows;
  }
}

module.exports = { GroupDAO: new GroupDAO() };
