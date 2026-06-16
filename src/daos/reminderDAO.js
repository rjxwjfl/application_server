class ReminderDAO {
  async create(conn, { id, user_id, target_type, target_id, base_time, trigger_at, trigger_offset }) {
    const query = `
      INSERT INTO reminders (id, user_id, target_type, target_id, base_time, trigger_at, trigger_offset)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, user_id, target_type, target_id, base_time, trigger_at, trigger_offset, is_sent, created_at
    `;
    const result = await conn.query(query, [
      id, user_id, target_type, target_id, base_time, trigger_at, trigger_offset || null,
    ]);
    return result.rows[0];
  }

  async findById(conn, id) {
    const query = `
      SELECT id, user_id, target_type, target_id, base_time, trigger_at, trigger_offset,
             is_sent, created_at, updated_at
      FROM reminders
      WHERE id = $1
    `;
    const result = await conn.query(query, [id]);
    return result.rows[0] || null;
  }

  async findByUser(conn, userId) {
    const query = `
      SELECT id, target_type, target_id, base_time, trigger_at, trigger_offset,
             is_sent, created_at, updated_at
      FROM reminders
      WHERE user_id = $1
      ORDER BY trigger_at ASC
    `;
    const result = await conn.query(query, [userId]);
    return result.rows;
  }

  async findByTarget(conn, targetType, targetId, userId) {
    const query = `
      SELECT id, user_id, target_type, target_id, base_time, trigger_at, trigger_offset,
             is_sent, created_at
      FROM reminders
      WHERE target_type = $1 AND target_id = $2 AND user_id = $3
    `;
    const result = await conn.query(query, [targetType, targetId, userId]);
    return result.rows;
  }

  async findPending(conn, beforeTime, limit = 100) {
    const query = `
      SELECT id, user_id, target_type, target_id, base_time, trigger_at
      FROM reminders
      WHERE trigger_at <= $1 AND is_sent = FALSE
      ORDER BY trigger_at ASC
      LIMIT $2
    `;
    const result = await conn.query(query, [beforeTime, limit]);
    return result.rows;
  }

  // trigger_at <= now() 인 대기 리마인더를 관련 항목 요약과 함께 조회
  async findPendingWithDetails(conn, beforeTime, limit = 100) {
    const query = `
      SELECT r.id, r.user_id, r.target_type, r.target_id, r.trigger_at,
        CASE r.target_type
          WHEN 0 THEN COALESCE(ei.summary, '일정')
          WHEN 1 THEN COALESCE(ti.summary, '할 일')
          ELSE '알림'
        END AS summary,
        CASE r.target_type
          WHEN 0 THEN ei.start_date
          WHEN 1 THEN ti.due_date
        END AS item_time
      FROM reminders r
      LEFT JOIN event_instances ei ON r.target_type = 0 AND r.target_id = ei.id
      LEFT JOIN task_instances  ti ON r.target_type = 1 AND r.target_id = ti.id
      WHERE r.trigger_at <= $1 AND r.is_sent = FALSE
      ORDER BY r.trigger_at ASC
      LIMIT $2
    `;
    const result = await conn.query(query, [beforeTime, limit]);
    return result.rows;
  }

  async markSent(conn, id) {
    await conn.query(
      'UPDATE reminders SET is_sent = TRUE, updated_at = now() WHERE id = $1',
      [id]
    );
  }

  // 발송 후 hard delete (schema.md 2026-06-11)
  async deleteById(conn, id) {
    await conn.query('DELETE FROM reminders WHERE id = $1', [id]);
  }

  async deleteByTarget(conn, targetType, targetId) {
    await conn.query(
      'DELETE FROM reminders WHERE target_type = $1 AND target_id = $2',
      [targetType, targetId]
    );
  }

  async findByUserForSync(conn, userId, since) {
    const query = `
      SELECT id, target_type, target_id, base_time, trigger_at, trigger_offset,
             is_sent, created_at, updated_at
      FROM reminders
      WHERE user_id = $1 AND updated_at > $2
      ORDER BY updated_at ASC
    `;
    const result = await conn.query(query, [userId, since]);
    return result.rows;
  }
}

module.exports = { ReminderDAO: new ReminderDAO() };
