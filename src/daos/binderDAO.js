const { SectionDAO } = require('./sectionDAO');
const { ConflictError } = require('../core/errors');

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

  // role >= 0 필터 — RLY-20260806-018 당시 role = -1 은 승인 대기 sentinel이었다. RLY-20260806-024
  // 로 대기 상태가 binder_join_requests로 이전되면서 binder_members에는 이제 음수 role이 전혀
  // 쓰이지 않는다(chk_bm_role CHECK로 DB 레벨에서도 차단). 그래도 이 필터는 지우지 않는다 —
  // role에 CHECK가 없던 시절 이 13곳이 유일한 방어선이었고, 회귀 커버리지(RLY-20260806-023)가
  // 지금 이 필터들을 검증 대상으로 잡고 있다. 방어적 이중 잠금으로 유지한다.
  async getMember(conn, binderId, userId) {
    const query = `
      SELECT binder_id, user_id, role, notification_level, nickname_in_binder, joined_at, deleted_at
      FROM binder_members
      WHERE binder_id = $1 AND user_id = $2 AND role >= 0
    `;
    const result = await conn.query(query, [binderId, userId]);
    return result.rows[0] || null;
  }

  async getMembersForUpdate(conn, binderId, userIds) {
    const query = `
      SELECT binder_id, user_id, role, deleted_at
      FROM binder_members
      WHERE binder_id = $1 AND user_id = ANY($2::uuid[]) AND role >= 0
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
      WHERE dm.binder_id = $1 AND dm.deleted_at IS NULL AND dm.role >= 0
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
      WHERE dm.user_id = $1 AND dm.deleted_at IS NULL AND dm.role >= 0 AND d.deleted_at IS NULL
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
    await SectionDAO.softDeleteEmptyPrivateSections(conn, binderId);
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

  // ============================================
  // BinderJoinRequests 테이블 (RLY-20260806-024 — schema.md:234-256, api.md:446-513)
  // ============================================

  // idx_bjr_blocked 사용 — 차단 이력 존재 여부. 차단 이력은 영구 보존되므로 있으면 항상 true.
  async hasActiveBlock(conn, binderId, requesterId) {
    const { rows } = await conn.query(
      `SELECT id FROM binder_join_requests
       WHERE binder_id = $1 AND requester_id = $2 AND status = 'BLOCKED'
       LIMIT 1`,
      [binderId, requesterId]
    );
    return rows.length > 0;
  }

  // uq_bjr_pending(동일 binder·requester 동시 복수 PENDING 금지)에 걸리면 23505로 떨어진다 —
  // 사전 SELECT 없이 이 인덱스 자체를 동시성 가드로 쓰고 여기서 409로 번역한다.
  async createJoinRequest(conn, id, binderId, requesterId) {
    try {
      const { rows } = await conn.query(
        `INSERT INTO binder_join_requests (id, binder_id, requester_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'PENDING', now(), now())
         RETURNING id, binder_id, requester_id, status, decided_by, decided_at, expires_at, created_at, updated_at`,
        [id, binderId, requesterId]
      );
      return rows[0];
    } catch (err) {
      if (err.code === '23505' && err.constraint === 'uq_bjr_pending') {
        throw new ConflictError('이미 승인 대기 중인 신청이 있습니다', 'ALREADY_REQUESTED');
      }
      throw err;
    }
  }

  // 관리자용 목록 조회. status 미지정 시 전체. 만료된 PENDING(expires_at < now())은 실제 만료
  // 처리(배치)가 없어 status가 그대로 'PENDING'이지만, api.md·design_intent.md가 요구하는
  // "조회 시점 판정"에 따라 목록에서는 제외한다 — status 자체를 바꾸지 않으므로 재신청 시
  // uq_bjr_pending과는 별개다(재신청 회귀는 이 gap을 감안해 작성됨, 구현보고서 참조).
  async getJoinRequests(conn, binderId, status, limit, offset) {
    const params = [binderId];
    let where = 'bjr.binder_id = $1';
    if (status) {
      params.push(status);
      where += ` AND bjr.status = $${params.length}`;
    }
    where += " AND (bjr.status != 'PENDING' OR bjr.expires_at > now())";

    const countResult = await conn.query(
      `SELECT COUNT(*) AS count FROM binder_join_requests bjr WHERE ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const listParams = [...params, limit, offset];
    const { rows } = await conn.query(
      `SELECT bjr.id, bjr.requester_id, bjr.status, bjr.created_at, bjr.expires_at,
              bjr.decided_by, bjr.decided_at, ui.display_name
       FROM binder_join_requests bjr
       LEFT JOIN user_infos ui ON ui.user_id = bjr.requester_id
       WHERE ${where}
       ORDER BY bjr.created_at DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );
    return { rows, total };
  }

  // approve/reject/block 공용 — FOR UPDATE로 동시 처리(이중 승인 등)를 막는다.
  async getJoinRequestForUpdate(conn, binderId, requestId) {
    const { rows } = await conn.query(
      `SELECT id, binder_id, requester_id, status, expires_at
       FROM binder_join_requests
       WHERE id = $1 AND binder_id = $2
       FOR UPDATE`,
      [requestId, binderId]
    );
    return rows[0] || null;
  }

  async decideJoinRequest(conn, requestId, status, deciderId) {
    const { rows } = await conn.query(
      `UPDATE binder_join_requests
       SET status = $1, decided_by = $2, decided_at = now(), updated_at = now()
       WHERE id = $3
       RETURNING id, binder_id, requester_id, status, decided_by, decided_at, expires_at, created_at, updated_at`,
      [status, deciderId, requestId]
    );
    return rows[0];
  }
}

module.exports = {
  BinderDAO: new BinderDAO(),
};
