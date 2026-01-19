class DrawerDAO {
  /**
   * Drawer ID로 조회
   * @param {object} conn - DB Connection (Pool or Client)
   */
  async findById(conn, drawerId) {
    const query = `
      SELECT id, name, description, image_url, thumbnail_url, member_count,
             last_activity_at, created_at, updated_at, deleted_at
      FROM drawers
      WHERE id = $1 AND deleted_at IS NULL
    `;
    const result = await conn.query(query, [drawerId]);
    return result.rows[0] || null;
  }

  /**
   * Drawer 이름으로 검색
   */
  async searchByName(conn, keyword, limit = 20, offset = 0) {
    const query = `
      SELECT id, name, description, image_url, thumbnail_url, member_count,
             last_activity_at, created_at, updated_at
      FROM drawers
      WHERE (name ILIKE $1 OR description ILIKE $1)
        AND deleted_at IS NULL
        AND (SELECT is_public FROM drawer_settings WHERE drawer_id = drawers.id)
      ORDER BY last_activity_at DESC
      LIMIT $2 OFFSET $3
    `;
    const result = await conn.query(query, [`%${keyword}%`, limit, offset]);
    return result.rows;
  }

  /**
   * Drawer 생성 (INSERT)
   */
  async create(conn, drawerId, drawerData) {
    const { name, description, imageUrl, thumbnailUrl } = drawerData;
    const query = `
      INSERT INTO drawers (id, name, description, image_url, thumbnail_url, member_count, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, 1, now(), now())
      RETURNING id, name, description, image_url, thumbnail_url, member_count, created_at
    `;
    const result = await conn.query(query, [
      drawerId,
      name,
      description || null,
      imageUrl || null,
      thumbnailUrl || null,
    ]);
    return result.rows[0];
  }

  /**
   * Drawer 정보 수정
   */
  async updateInfo(conn, drawerId, updateData) {
    const { name, description, imageUrl, thumbnailUrl } = updateData;
    const query = `
      UPDATE drawers
      SET name = COALESCE($1, name),
          description = COALESCE($2, description),
          image_url = COALESCE($3, image_url),
          thumbnail_url = COALESCE($4, thumbnail_url),
          updated_at = now()
      WHERE id = $5 AND deleted_at IS NULL
      RETURNING id, name, description, image_url, thumbnail_url
    `;
    const result = await conn.query(query, [
      name,
      description,
      imageUrl,
      thumbnailUrl,
      drawerId,
    ]);
    return result.rows[0];
  }

  /**
   * Drawer 삭제 (Soft Delete)
   */
  async softDelete(conn, drawerId) {
    const query = `
      UPDATE drawers
      SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
    `;
    await conn.query(query, [drawerId]);
  }

  // ============================================
  // DrawerSettings 테이블
  // ============================================

  async createSettings(conn, drawerId) {
    const query = `
      INSERT INTO drawer_settings (drawer_id, is_public, is_searchable, require_approval, updated_at)
      VALUES ($1, false, false, false, now())
    `;
    await conn.query(query, [drawerId]);
  }

  async getSettings(conn, drawerId) {
    const query = `
      SELECT drawer_id, is_public, is_searchable, require_approval, updated_at
      FROM drawer_settings
      WHERE drawer_id = $1
    `;
    const result = await conn.query(query, [drawerId]);
    return result.rows[0] || null;
  }

  async updateSettings(conn, drawerId, settingsData) {
    const { isPublic, isSearchable, requireApproval } = settingsData;
    const query = `
      UPDATE drawer_settings
      SET is_public = COALESCE($1, is_public),
          is_searchable = COALESCE($2, is_searchable),
          require_approval = COALESCE($3, require_approval),
          updated_at = now()
      WHERE drawer_id = $4
      RETURNING drawer_id, is_public, is_searchable, require_approval
    `;
    const result = await conn.query(query, [
      isPublic,
      isSearchable,
      requireApproval,
      drawerId,
    ]);
    return result.rows[0];
  }

  // ============================================
  // DrawerUsers 테이블
  // ============================================

  async getMember(conn, drawerId, userId) {
    const query = `
      SELECT drawer_id, user_id, role, notification_level, nickname_in_drawer, joined_at, deleted_at
      FROM drawer_users
      WHERE drawer_id = $1 AND user_id = $2
    `;
    const result = await conn.query(query, [drawerId, userId]);
    return result.rows[0] || null;
  }

  async getMembers(conn, drawerId) {
    const query = `
      SELECT du.drawer_id, du.user_id, du.role, du.notification_level,
             du.nickname_in_drawer, du.joined_at,
             u.display_name, u.user_code, u.image_url, u.email
      FROM drawer_users du
      JOIN users u ON du.user_id = u.id
      WHERE du.drawer_id = $1 AND du.deleted_at IS NULL
      ORDER BY du.joined_at ASC
    `;
    const result = await conn.query(query, [drawerId]);
    return result.rows;
  }

  async getMyDrawers(conn, userId) {
    const query = `
      SELECT d.id, d.name, d.description, d.image_url, d.thumbnail_url,
             d.member_count, d.last_activity_at, d.created_at,
             du.role, du.notification_level, du.joined_at
      FROM drawer_users du
      JOIN drawers d ON du.drawer_id = d.id
      WHERE du.user_id = $1 AND du.deleted_at IS NULL AND d.deleted_at IS NULL
      ORDER BY d.last_activity_at DESC
    `;
    const result = await conn.query(query, [userId]);
    return result.rows;
  }

  async addMember(conn, drawerId, userId, role = 3) {
    const query = `
      INSERT INTO drawer_users (drawer_id, user_id, role, joined_at, created_at, updated_at)
      VALUES ($1, $2, $3, now(), now(), now())
      ON CONFLICT (drawer_id, user_id) DO UPDATE
      SET deleted_at = NULL, updated_at = now(), role = COALESCE(EXCLUDED.role, drawer_users.role)
      RETURNING drawer_id, user_id, role
    `;
    const result = await conn.query(query, [drawerId, userId, role]);
    return result.rows[0];
  }

  async updateMemberRole(conn, drawerId, userId, role) {
    const query = `
      UPDATE drawer_users
      SET role = $1, updated_at = now()
      WHERE drawer_id = $2 AND user_id = $3 AND deleted_at IS NULL
      RETURNING drawer_id, user_id, role
    `;
    const result = await conn.query(query, [role, drawerId, userId]);
    return result.rows[0];
  }

  async removeMember(conn, drawerId, userId) {
    const query = `
      UPDATE drawer_users
      SET deleted_at = now(), updated_at = now()
      WHERE drawer_id = $1 AND user_id = $2 AND deleted_at IS NULL
    `;
    await conn.query(query, [drawerId, userId]);
  }

  // ============================================
  // DrawerInvitations 테이블
  // ============================================

  async createInvitation(conn, id, drawerId, inviterId, token, expiresAt, maxUses = 1) {
    const query = `
      INSERT INTO drawer_invitations (id, drawer_id, inviter_id, token, max_uses, expires_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, now())
      RETURNING id, drawer_id, token, max_uses, expires_at
    `;
    const result = await conn.query(query, [
      id,
      drawerId,
      inviterId,
      token,
      maxUses,
      expiresAt,
    ]);
    return result.rows[0];
  }

  async findInvitationByToken(conn, token) {
    const query = `
      SELECT di.id, di.drawer_id, di.inviter_id, di.token, di.max_uses,
             di.uses_count, di.expires_at, di.created_at,
             d.name as drawer_name, d.description, d.image_url, d.thumbnail_url,
             u.display_name as inviter_name
      FROM drawer_invitations di
      JOIN drawers d ON di.drawer_id = d.id
      JOIN users u ON di.inviter_id = u.id
      WHERE di.token = $1
        AND (di.max_uses IS NULL OR di.uses_count < di.max_uses)
        AND di.expires_at > now()
    `;
    const result = await conn.query(query, [token]);
    return result.rows[0] || null;
  }

  async incrementInvitationUsage(conn, token) {
    const query = `
      UPDATE drawer_invitations
      SET uses_count = uses_count + 1
      WHERE token = $1
    `;
    await conn.query(query, [token]);
  }

  // ============================================
  // DrawerJoinRequests 테이블
  // ============================================

  async createJoinRequest(conn, id, drawerId, userId) {
    const query = `
      INSERT INTO drawer_join_requests (id, drawer_id, user_id, status, created_at, updated_at)
      VALUES ($1, $2, $3, 0, now(), now())
      RETURNING id, drawer_id, user_id, status
    `;
    const result = await conn.query(query, [id, drawerId, userId]);
    return result.rows[0];
  }

  async getJoinRequests(conn, drawerId, status = 0) {
    const query = `
      SELECT djr.id, djr.drawer_id, djr.user_id, djr.status, djr.created_at,
             u.display_name, u.user_code, u.image_url, u.email
      FROM drawer_join_requests djr
      JOIN users u ON djr.user_id = u.id
      WHERE djr.drawer_id = $1 AND djr.status = $2
      ORDER BY djr.created_at ASC
    `;
    const result = await conn.query(query, [drawerId, status]);
    return result.rows;
  }

  async getJoinRequestById(conn, requestId) {
      const query = `SELECT id, drawer_id, user_id, status FROM drawer_join_requests WHERE id = $1`;
      const result = await conn.query(query, [requestId]);
      return result.rows[0] || null;
  }

  async updateJoinRequestStatus(conn, requestId, status) {
    const query = `
      UPDATE drawer_join_requests
      SET status = $1, updated_at = now()
      WHERE id = $2
    `;
    await conn.query(query, [status, requestId]);
  }

  // ============================================
  // 유틸리티 메서드
  // ============================================

  async incrementMemberCount(conn, drawerId) {
    const query = `
      UPDATE drawers
      SET member_count = member_count + 1, updated_at = now()
      WHERE id = $1
    `;
    await conn.query(query, [drawerId]);
  }

  async decrementMemberCount(conn, drawerId) {
    const query = `
      UPDATE drawers
      SET member_count = GREATEST(member_count - 1, 0), updated_at = now()
      WHERE id = $1
    `;
    await conn.query(query, [drawerId]);
  }

  async updateLastActivity(conn, drawerId) {
    const query = `
      UPDATE drawers
      SET last_activity_at = now(), updated_at = now()
      WHERE id = $1
    `;
    await conn.query(query, [drawerId]);
  }
}

module.exports = {
  DrawerDAO: new DrawerDAO(),
};