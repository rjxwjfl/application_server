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
      `SELECT s.id, s.binder_id, s.title, s.access_scope, s.is_default,
              s.created_at, s.updated_at,
              CASE WHEN s.access_scope = 1 THEN
                (SELECT COUNT(*)::int FROM section_members sm
                 WHERE sm.section_id = s.id AND sm.deleted_at IS NULL)
              ELSE NULL END AS member_count,
              CASE WHEN s.access_scope = 0 OR EXISTS (
                SELECT 1 FROM section_members sm
                WHERE sm.section_id = s.id AND sm.user_id = $2 AND sm.deleted_at IS NULL
              ) THEN TRUE ELSE FALSE END AS "canAccessContent"
       FROM sections s
       WHERE s.binder_id = $1 AND s.deleted_at IS NULL
         AND (s.access_scope = 0 OR EXISTS (
           SELECT 1 FROM section_members sm
           WHERE sm.section_id = s.id AND sm.user_id = $2 AND sm.deleted_at IS NULL
         ) OR EXISTS (
           -- role BETWEEN 0 AND 1(master·manager) — role=-1(RLY-20260806-018 join-request pending
           -- sentinel)이 "<= 1" 비교를 통과해 대기 신청자가 전 섹션을 보게 되는 것을 막는다.
           SELECT 1 FROM binder_members bm WHERE bm.binder_id = s.binder_id AND bm.user_id = $2
             AND bm.role BETWEEN 0 AND 1 AND bm.deleted_at IS NULL
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

  async update(conn, sectionId, { title }) {
    const { rows } = await conn.query(
      `UPDATE sections SET title = COALESCE($1, title), updated_at = now()
       WHERE id = $2 AND deleted_at IS NULL
       RETURNING id, binder_id, title, access_scope, is_default, created_at, updated_at`,
      [title, sectionId]
    );
    return rows[0] || null;
  }

  async hasAccess(conn, sectionId, userId) {
    const { rowCount } = await conn.query(
      // role >= 0 — join-request pending(role=-1) 행은 binder_members에 존재해도 이 JOIN에서
      // 제외한다(RLY-20260806-018). 그렇지 않으면 access_scope=0(전체공개) 섹션은 대기 신청자도
      // "바인더 멤버"로 오인되어 접근이 열린다.
      `SELECT 1 FROM sections s
       JOIN binder_members bm ON bm.binder_id = s.binder_id AND bm.user_id = $2
         AND bm.deleted_at IS NULL AND bm.role >= 0
       WHERE s.id = $1 AND s.deleted_at IS NULL AND (s.access_scope = 0 OR EXISTS (
         SELECT 1 FROM section_members sm
         WHERE sm.section_id = s.id AND sm.user_id = $2 AND sm.deleted_at IS NULL))`,
      [sectionId, userId]
    );
    return rowCount > 0;
  }

  async addMember(conn, sectionId, userId, id) {
    const { rows } = await conn.query(
      `WITH restored AS (
         UPDATE section_members SET deleted_at = NULL, updated_at = now()
         WHERE id = (SELECT id FROM section_members
           WHERE section_id = $1 AND user_id = $2 AND deleted_at IS NOT NULL
           ORDER BY updated_at DESC LIMIT 1 FOR UPDATE)
         RETURNING user_id
       ), inserted AS (
         INSERT INTO section_members (id, section_id, user_id)
         SELECT $3, $1, $2 WHERE NOT EXISTS (SELECT 1 FROM restored)
           AND NOT EXISTS (SELECT 1 FROM section_members
             WHERE section_id = $1 AND user_id = $2 AND deleted_at IS NULL)
         ON CONFLICT (section_id, user_id) WHERE deleted_at IS NULL DO NOTHING
         RETURNING user_id
       ) SELECT user_id FROM restored UNION ALL SELECT user_id FROM inserted`,
      [sectionId, userId, id]
    );
    return rows.length > 0;
  }

  async removeMember(conn, sectionId, userId) {
    const { rowCount } = await conn.query(
      `UPDATE section_members SET deleted_at = now(), updated_at = now()
       WHERE section_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [sectionId, userId]
    );
    return rowCount > 0;
  }

  async countMembers(conn, sectionId) {
    const { rows } = await conn.query(
      `SELECT COUNT(*)::int AS count FROM section_members
       WHERE section_id = $1 AND deleted_at IS NULL`, [sectionId]
    );
    return rows[0].count;
  }

  async softDeleteEmptyPrivateSections(conn, binderId) {
    const { rows } = await conn.query(
      `SELECT s.id FROM sections s
       WHERE s.binder_id = $1 AND s.access_scope = 1
         AND s.deleted_at IS NULL AND s.is_default = FALSE
         AND NOT EXISTS (SELECT 1 FROM section_members sm
           WHERE sm.section_id = s.id AND sm.deleted_at IS NULL)
       FOR UPDATE`,
      [binderId]
    );
    for (const { id } of rows) await this.softDelete(conn, id);
    return rows.map(({ id }) => id);
  }

  async findSectionIdByMessage(conn, messageId) {
    const { rows } = await conn.query(`SELECT section_id FROM section_messages WHERE id = $1 AND deleted_at IS NULL`, [messageId]);
    return rows[0]?.section_id || null;
  }

  async softDelete(conn, sectionId) {
    await conn.query(
      `UPDATE attachments a SET deleted_at = now(), updated_at = now(), status = 'deleted'
       WHERE a.context_type = 'SECTION_MESSAGE' AND a.deleted_at IS NULL AND EXISTS (
         SELECT 1 FROM section_messages m WHERE m.id = a.context_id AND m.section_id = $1)`, [sectionId]
    );
    for (const table of ['message_embeds', 'message_reactions', 'message_mentions']) {
      await conn.query(
        `UPDATE ${table} child SET deleted_at = now(), updated_at = now()
         WHERE child.deleted_at IS NULL AND EXISTS (
           SELECT 1 FROM section_messages m WHERE m.id = child.message_id AND m.section_id = $1)`, [sectionId]
      );
    }
    await conn.query(`UPDATE section_messages SET deleted_at = now(), updated_at = now() WHERE section_id = $1 AND deleted_at IS NULL`, [sectionId]);
    await conn.query(`UPDATE event_sections SET deleted_at = now(), updated_at = now() WHERE section_id = $1 AND deleted_at IS NULL`, [sectionId]);
    await conn.query(`UPDATE task_sections SET deleted_at = now(), updated_at = now() WHERE section_id = $1 AND deleted_at IS NULL`, [sectionId]);
    await conn.query(
      `UPDATE section_members SET deleted_at = now(), updated_at = now()
       WHERE section_id = $1 AND deleted_at IS NULL`, [sectionId]
    );
    const { rowCount } = await conn.query(
      `UPDATE sections SET deleted_at = now(), updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL AND is_default = FALSE`, [sectionId]
    );
    return rowCount > 0;
  }
}

module.exports = { SectionDAO: new SectionDAO() };
