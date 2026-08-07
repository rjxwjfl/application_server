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

  // RLY-20260806-159 — 이미 활성 멤버인 user_id로 다시 addMember를 호출하면
  // uq_group_members_active(group_id,user_id) WHERE deleted_at IS NULL 충돌로 raw
  // Postgres 23505가 그대로 올라가 asyncHandler→errorHandler에서 미분류 500이 됐다
  // (statusCode 없는 에러는 err.statusCode || err.status || 500 경로로 떨어진다).
  // transport.md §7-1상 5xx는 재시도 대상이라 오프라인 큐가 영원히 재시도만 반복하며
  // 막힌다 — 단순 표시 문제가 아니다.
  //
  // ON CONFLICT (group_id, user_id) WHERE deleted_at IS NULL DO NOTHING(SectionDAO.
  // addMember)를 그대로 베끼지 않은 이유: 이 라우트(POST /groups/:groupId/members)는
  // 단건 응답으로 멤버 행을 그대로 반환해야 하는데(groupRoutes.js:8) DO NOTHING은 충돌
  // 시 RETURNING이 0행이라 data: undefined가 나간다. 대신 messageDAO.addReaction의
  // "중복=성공, 기존 행 반환" 의도를 재사용하되 WHERE 절을 추가했다 — 실측(Postgres
  // 15 컨테이너)해보니 addReaction 쪽 ON CONFLICT (message_id,user_id,emoji)에는 그
  // WHERE절이 없어 partial unique index(uk_message_reactions_active)와 매칭되지
  // 않고 "there is no unique or exclusion constraint matching the ON CONFLICT
  // specification"으로 그 자체가 던진다 — 그 형태를 그대로 옮기면 같은 결함을
  // 재생산하므로 옮기지 않았다(반응 코드는 이번 태스크 대상 아님, 별도 보고).
  //
  // deleted_at을 SET에 안 넣은 이유: 이 ON CONFLICT는 WHERE deleted_at IS NULL
  // 인덱스에만 매칭되므로 충돌이 잡히는 행은 항상 이미 활성(deleted_at IS NULL)이다 —
  // 다시 NULL로 덮어써도 항상 no-op이라 굳이 안 넣었다(실측 3-way 확인: 신규 삽입/
  // 활성 중복/삭제 후 재추가 모두 기대대로 동작).
  async addMember(conn, { id, groupId, userId }) {
    const { rows } = await conn.query(
      `INSERT INTO group_members (id, group_id, user_id) VALUES ($1, $2, $3)
       ON CONFLICT (group_id, user_id) WHERE deleted_at IS NULL DO UPDATE
       SET updated_at = now()
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
