class BinderDAO {
  /**
   * Binder ID로 조회
   * @param {object} conn - DB Connection (Pool or Client)
   */
  async findById(conn, binderId) {
    const query = `
      SELECT id, name, description, image_url, thumbnail_url, member_count,
             last_activity_at, created_at, updated_at, deleted_at
      FROM binders
      WHERE id = $1 AND deleted_at IS NULL
    `;
    const result = await conn.query(query, [binderId]);
    return result.rows[0] || null;
  }

  /**
   * Binder 이름으로 검색
   */
  async searchByName(conn, keyword, limit = 20, offset = 0) {
    const query = `
      SELECT id, name, description, image_url, thumbnail_url, member_count,
             last_activity_at, created_at, updated_at
      FROM binders
      WHERE (name ILIKE $1 OR description ILIKE $1)
        AND deleted_at IS NULL
        AND (SELECT is_public FROM binder_settings WHERE binder_id = binders.id)
      ORDER BY last_activity_at DESC
      LIMIT $2 OFFSET $3
    `;
    const result = await conn.query(query, [`%${keyword}%`, limit, offset]);
    return result.rows;
  }

  /**
   * Binder 생성 (INSERT)
   */
  async create(conn, binderData) {
    const { id, name, description, image_url, thumbnail_url } = binderData;
    const query = `
      INSERT INTO binders (id, name, description, image_url, thumbnail_url, member_count, created_at, updated_at, last_activity_at)
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
   * Binder 정보 + 설정 통합 수정
   */
  async update(conn, binderId, updateData) {
    const { name, description, image_url, thumbnail_url } = updateData;
    const query = `
      UPDATE binders
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
      binderId,
    ]);
    return result.rows[0];
  }

  /**
   * Binder 삭제 (Soft Delete)
   */
  async softDelete(conn, binderId) {
    const query = `
      UPDATE binders
      SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
    `;
    await conn.query(query, [binderId]);
  }

  // ============================================
  // BinderSettings 테이블
  // ============================================

  async createSettings(conn, binderId) {
    const query = `
      INSERT INTO binder_settings (binder_id, is_public, is_searchable, require_approval, updated_at)
      VALUES ($1, false, false, false, now())
      RETURNING binder_id, is_public, is_searchable, require_approval, updated_at
    `;
    const result = await conn.query(query, [binderId]);
    return result.rows[0];
  }

  async getSettings(conn, binderId) {
    const query = `
      SELECT binder_id, is_public, is_searchable, require_approval, updated_at
      FROM binder_settings
      WHERE binder_id = $1
    `;
    const result = await conn.query(query, [binderId]);
    return result.rows[0] || null;
  }

  async updateSettings(conn, binderId, settingsData) {
    const { is_public, is_searchable, require_approval } = settingsData;
    const query = `
      UPDATE binder_settings
      SET is_public = COALESCE($1, is_public),
          is_searchable = COALESCE($2, is_searchable),
          require_approval = COALESCE($3, require_approval),
          updated_at = now()
      WHERE binder_id = $4
      RETURNING binder_id, is_public, is_searchable, require_approval
    `;
    const result = await conn.query(query, [
      is_public,
      is_searchable,
      require_approval,
      binderId,
    ]);
    return result.rows[0];
  }

  // ============================================
  // BinderMembers 테이블
  // ============================================

  async getMember(conn, binderId, userId) {
    const query = `
      SELECT binder_id, user_id, role, notification_level, nickname_in_binder, joined_at, deleted_at
      FROM binder_members
      WHERE binder_id = $1 AND user_id = $2
    `;
    const result = await conn.query(query, [binderId, userId]);
    return result.rows[0] || null;
  }

  async getMembersForUpdate(conn, binderId, userIds) {
    const query = `
      SELECT binder_id, user_id, role, deleted_at
      FROM binder_members
      WHERE binder_id = $1 AND user_id = ANY($2::uuid[])
      ORDER BY user_id
      FOR UPDATE
    `;
    const result = await conn.query(query, [binderId, userIds]);
    return result.rows;
  }

  async getMembers(conn, binderId) {
    const query = `
      SELECT dm.binder_id, dm.user_id, dm.role, dm.notification_level,
             dm.nickname_in_binder, dm.joined_at,
             ui.display_name, ui.user_code, ui.image_url, u.email
      FROM binder_members dm
      JOIN users u ON dm.user_id = u.id
      LEFT JOIN user_infos ui ON dm.user_id = ui.user_id
      WHERE dm.binder_id = $1 AND dm.deleted_at IS NULL
      ORDER BY dm.joined_at ASC
    `;
    const result = await conn.query(query, [binderId]);
    return result.rows;
  }

  async getMyBinders(conn, userId) {
    const query = `
      SELECT d.id, d.name, d.description, d.image_url, d.thumbnail_url,
             d.member_count, d.last_activity_at, d.created_at,
             dm.role, dm.notification_level, dm.joined_at
      FROM binder_members dm
      JOIN binders d ON dm.binder_id = d.id
      WHERE dm.user_id = $1 AND dm.deleted_at IS NULL AND d.deleted_at IS NULL
      ORDER BY d.last_activity_at DESC
    `;
    const result = await conn.query(query, [userId]);
    return result.rows;
  }

  async addMember(conn, binderId, userId, role = 3) {
    const query = `
      INSERT INTO binder_members (binder_id, user_id, role, joined_at, created_at, updated_at)
      VALUES ($1, $2, $3, now(), now(), now())
      ON CONFLICT (binder_id, user_id) DO UPDATE
      SET deleted_at = NULL, updated_at = now(), role = COALESCE(EXCLUDED.role, binder_members.role)
      RETURNING binder_id, user_id, role, nickname_in_binder, notification_level,
                joined_at, created_at, updated_at, deleted_at
    `;
    const result = await conn.query(query, [binderId, userId, role]);
    return result.rows[0];
  }

  async updateMemberRole(conn, binderId, userId, role) {
    const query = `
      UPDATE binder_members
      SET role = $1, updated_at = now()
      WHERE binder_id = $2 AND user_id = $3 AND deleted_at IS NULL
      RETURNING binder_id, user_id, role
    `;
    const result = await conn.query(query, [role, binderId, userId]);
    return result.rows[0];
  }

  async removeMember(conn, binderId, userId) {
    const query = `
      UPDATE binder_members
      SET deleted_at = now(), updated_at = now()
      WHERE binder_id = $1 AND user_id = $2 AND deleted_at IS NULL
    `;
    await conn.query(query, [binderId, userId]);
    await conn.query(
      `UPDATE group_members gm SET deleted_at = now(), updated_at = now()
       FROM groups g WHERE gm.group_id = g.id AND g.binder_id = $1 AND gm.user_id = $2 AND gm.deleted_at IS NULL`,
      [binderId, userId]
    );
    await conn.query(
      `UPDATE section_members sm SET deleted_at = now(), updated_at = now()
       FROM sections s WHERE sm.section_id = s.id AND s.binder_id = $1
         AND sm.user_id = $2 AND sm.deleted_at IS NULL`,
      [binderId, userId]
    );
    await conn.query(
      `UPDATE sections s SET deleted_at = now(), updated_at = now()
       WHERE s.binder_id = $1 AND s.access_scope = 1 AND s.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM section_members sm
           WHERE sm.section_id = s.id AND sm.deleted_at IS NULL)`,
      [binderId]
    );
  }

  // ============================================
  // BinderInvitations 테이블
  // ============================================

  async createInvitation(conn, id, binderId, inviterId, inviteCode, expiresAt, maxUses = 1) {
    const query = `
      INSERT INTO binder_invitations (id, binder_id, inviter_id, invite_code, max_uses, expires_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, now())
      RETURNING id, binder_id, invite_code AS invitation_code, max_uses, expires_at
    `;
    const result = await conn.query(query, [
      id,
      binderId,
      inviterId,
      inviteCode,
      maxUses,
      expiresAt,
    ]);
    return result.rows[0];
  }

  async findInvitationByCode(conn, inviteCode) {
    const query = `
      SELECT di.id, di.binder_id, di.inviter_id, di.invite_code, di.max_uses,
             di.uses_count, di.expires_at, di.created_at,
             d.name as binder_name, d.description, d.image_url, d.thumbnail_url,
             ui.display_name as inviter_name
      FROM binder_invitations di
      JOIN binders d ON di.binder_id = d.id
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
      UPDATE binder_invitations
      SET uses_count = uses_count + 1
      WHERE invite_code = $1
    `;
    await conn.query(query, [inviteCode]);
  }

  // ============================================
  // 유틸리티 메서드
  // ============================================

  async incrementMemberCount(conn, binderId) {
    const query = `
      UPDATE binders
      SET member_count = member_count + 1, updated_at = now()
      WHERE id = $1
    `;
    await conn.query(query, [binderId]);
  }

  async decrementMemberCount(conn, binderId) {
    const query = `
      UPDATE binders
      SET member_count = GREATEST(member_count - 1, 0), updated_at = now()
      WHERE id = $1
    `;
    await conn.query(query, [binderId]);
  }

  async updateLastActivity(conn, binderId) {
    const query = `
      UPDATE binders
      SET last_activity_at = now(), updated_at = now()
      WHERE id = $1
    `;
    await conn.query(query, [binderId]);
  }

  async getPendingMembers(conn, binderId) {
    const { rows } = await conn.query(
      `SELECT dm.user_id, dm.created_at,
              ui.display_name, ui.user_code, ui.image_url
       FROM binder_members dm
       LEFT JOIN user_infos ui ON dm.user_id = ui.user_id
       WHERE dm.binder_id = $1 AND dm.role = -1 AND dm.deleted_at IS NULL`,
      [binderId]
    );
    return rows;
  }

  async removePendingRequest(conn, binderId, userId) {
    await conn.query(
      `UPDATE binder_members
       SET deleted_at = now(), updated_at = now()
       WHERE binder_id = $1 AND user_id = $2 AND role = -1`,
      [binderId, userId]
    );
  }

  async updateNickname(conn, binderId, userId, nickname) {
    await conn.query(
      `UPDATE binder_members
       SET nickname_in_binder = $1, updated_at = now()
       WHERE binder_id = $2 AND user_id = $3 AND deleted_at IS NULL`,
      [nickname, binderId, userId]
    );
  }

  async updateMemberPreferences(conn, binderId, userId, data) {
    const { notification_level } = data;
    await conn.query(
      `UPDATE binder_members
       SET notification_level = COALESCE($1, notification_level), updated_at = now()
       WHERE binder_id = $2 AND user_id = $3 AND deleted_at IS NULL`,
      [notification_level, binderId, userId]
    );
  }
}

module.exports = {
  BinderDAO: new BinderDAO(),
};
