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
  async create(conn, drawerData) {
    const { id, name, description, image_url, thumbnail_url } = drawerData;
    const query = `
      INSERT INTO drawers (id, name, description, image_url, thumbnail_url, member_count, created_at, updated_at, last_activity_at)
      VALUES ($1, $2, $3, $4, $5, 1, now(), now(), now())
      RETURNING id, name, description, image_url, thumbnail_url, member_count,
                last_activity_at, created_at, updated_at, deleted_at
    `;
    const result = await conn.query(query, [
      id,
      name,
      description || null,
      image_url || null,
      thumbnail_url || null,
    ]);
    return result.rows[0];
  }

  /**
   * Drawer 정보 + 설정 통합 수정
   */
  async update(conn, drawerId, updateData) {
    const { name, description, image_url, thumbnail_url } = updateData;
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
      image_url,
      thumbnail_url,
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
      RETURNING drawer_id, is_public, is_searchable, require_approval, updated_at
    `;
    const result = await conn.query(query, [drawerId]);
    return result.rows[0];
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
    const { is_public, is_searchable, require_approval } = settingsData;
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
      is_public,
      is_searchable,
      require_approval,
      drawerId,
    ]);
    return result.rows[0];
  }

  // ============================================
  // DrawerMembers 테이블
  // ============================================

  async getMember(conn, drawerId, userId) {
    const query = `
      SELECT drawer_id, user_id, role, notification_level, nickname_in_drawer, joined_at, deleted_at
      FROM drawer_members
      WHERE drawer_id = $1 AND user_id = $2
    `;
    const result = await conn.query(query, [drawerId, userId]);
    return result.rows[0] || null;
  }

  async getMembers(conn, drawerId) {
    const query = `
      SELECT dm.drawer_id, dm.user_id, dm.role, dm.notification_level,
             dm.nickname_in_drawer, dm.joined_at,
             ui.display_name, ui.user_code, ui.image_url, u.email
      FROM drawer_members dm
      JOIN users u ON dm.user_id = u.id
      LEFT JOIN user_infos ui ON dm.user_id = ui.user_id
      WHERE dm.drawer_id = $1 AND dm.deleted_at IS NULL
      ORDER BY dm.joined_at ASC
    `;
    const result = await conn.query(query, [drawerId]);
    return result.rows;
  }

  async getMyDrawers(conn, userId) {
    const query = `
      SELECT d.id, d.name, d.description, d.image_url, d.thumbnail_url,
             d.member_count, d.last_activity_at, d.created_at,
             dm.role, dm.notification_level, dm.joined_at
      FROM drawer_members dm
      JOIN drawers d ON dm.drawer_id = d.id
      WHERE dm.user_id = $1 AND dm.deleted_at IS NULL AND d.deleted_at IS NULL
      ORDER BY d.last_activity_at DESC
    `;
    const result = await conn.query(query, [userId]);
    return result.rows;
  }

  async addMember(conn, drawerId, userId, role = 3) {
    const query = `
      INSERT INTO drawer_members (drawer_id, user_id, role, joined_at, created_at, updated_at)
      VALUES ($1, $2, $3, now(), now(), now())
      ON CONFLICT (drawer_id, user_id) DO UPDATE
      SET deleted_at = NULL, updated_at = now(), role = COALESCE(EXCLUDED.role, drawer_members.role)
      RETURNING drawer_id, user_id, role, nickname_in_drawer, notification_level,
                joined_at, created_at, updated_at, deleted_at
    `;
    const result = await conn.query(query, [drawerId, userId, role]);
    return result.rows[0];
  }

  async updateMemberRole(conn, drawerId, userId, role) {
    const query = `
      UPDATE drawer_members
      SET role = $1, updated_at = now()
      WHERE drawer_id = $2 AND user_id = $3 AND deleted_at IS NULL
      RETURNING drawer_id, user_id, role
    `;
    const result = await conn.query(query, [role, drawerId, userId]);
    return result.rows[0];
  }

  async removeMember(conn, drawerId, userId) {
    const query = `
      UPDATE drawer_members
      SET deleted_at = now(), updated_at = now()
      WHERE drawer_id = $1 AND user_id = $2 AND deleted_at IS NULL
    `;
    await conn.query(query, [drawerId, userId]);
  }

  // ============================================
  // DrawerInvitations 테이블
  // ============================================

  async createInvitation(conn, id, drawerId, inviterId, inviteCode, expiresAt, maxUses = 1) {
    const query = `
      INSERT INTO drawer_invitations (id, drawer_id, inviter_id, invite_code, max_uses, expires_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, now())
      RETURNING id, drawer_id, invite_code AS invitation_code, max_uses, expires_at
    `;
    const result = await conn.query(query, [
      id,
      drawerId,
      inviterId,
      inviteCode,
      maxUses,
      expiresAt,
    ]);
    return result.rows[0];
  }

  async findInvitationByCode(conn, inviteCode) {
    const query = `
      SELECT di.id, di.drawer_id, di.inviter_id, di.invite_code, di.max_uses,
             di.uses_count, di.expires_at, di.created_at,
             d.name as drawer_name, d.description, d.image_url, d.thumbnail_url,
             ui.display_name as inviter_name
      FROM drawer_invitations di
      JOIN drawers d ON di.drawer_id = d.id
      JOIN users u ON di.inviter_id = u.id
      LEFT JOIN user_infos ui ON di.inviter_id = ui.user_id
      WHERE di.invite_code = $1
        AND (di.max_uses IS NULL OR di.uses_count < di.max_uses)
        AND di.expires_at > now()
    `;
    const result = await conn.query(query, [inviteCode]);
    return result.rows[0] || null;
  }

  async incrementInvitationUsage(conn, inviteCode) {
    const query = `
      UPDATE drawer_invitations
      SET uses_count = uses_count + 1
      WHERE invite_code = $1
    `;
    await conn.query(query, [inviteCode]);
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

  async getPendingMembers(conn, drawerId) {
    const { rows } = await conn.query(
      `SELECT dm.user_id, dm.created_at,
              ui.display_name, ui.user_code, ui.image_url
       FROM drawer_members dm
       LEFT JOIN user_infos ui ON dm.user_id = ui.user_id
       WHERE dm.drawer_id = $1 AND dm.role = -1 AND dm.deleted_at IS NULL`,
      [drawerId]
    );
    return rows;
  }

  async removePendingRequest(conn, drawerId, userId) {
    await conn.query(
      `UPDATE drawer_members
       SET deleted_at = now(), updated_at = now()
       WHERE drawer_id = $1 AND user_id = $2 AND role = -1`,
      [drawerId, userId]
    );
  }

  async updateNickname(conn, drawerId, userId, nickname) {
    await conn.query(
      `UPDATE drawer_members
       SET nickname_in_drawer = $1, updated_at = now()
       WHERE drawer_id = $2 AND user_id = $3 AND deleted_at IS NULL`,
      [nickname, drawerId, userId]
    );
  }

  async updateMemberPreferences(conn, drawerId, userId, data) {
    const { notification_level } = data;
    await conn.query(
      `UPDATE drawer_members
       SET notification_level = COALESCE($1, notification_level), updated_at = now()
       WHERE drawer_id = $2 AND user_id = $3 AND deleted_at IS NULL`,
      [notification_level, drawerId, userId]
    );
  }
}

module.exports = {
  DrawerDAO: new DrawerDAO(),
};
