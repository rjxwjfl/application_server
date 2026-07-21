class CalendarDAO {
  // ============================================
  // Calendars 테이블
  // ============================================

  async findById(conn, calendarId) {
    const query = `
      SELECT id, binder_id, title, description, color, is_public,
             created_at, updated_at, deleted_at
      FROM calendars
      WHERE id = $1 AND deleted_at IS NULL
    `;
    const result = await conn.query(query, [calendarId]);
    return result.rows[0] || null;
  }

  async findByBinderId(conn, binderId) {
    const query = `
      SELECT id, binder_id, title, description, color, is_public,
             created_at, updated_at, deleted_at
      FROM calendars
      WHERE binder_id = $1 AND deleted_at IS NULL
      ORDER BY created_at ASC
    `;
    const result = await conn.query(query, [binderId]);
    return result.rows;
  }

  async create(conn, data) {
    const query = `
      INSERT INTO calendars (id, binder_id, title, description, color, is_public, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()), COALESCE($8, now()))
      RETURNING *
    `;
    const result = await conn.query(query, [
      data.id,
      data.binder_id,
      data.title,
      data.description || null,
      data.color || 0,
      data.is_public || false,
      data.created_at,
      data.updated_at
    ]);
    return result.rows[0];
  }

  async update(conn, calendarId, updateData) {
    const { title, description, color, is_public } = updateData;
    const query = `
      UPDATE calendars
      SET title = COALESCE($1, title),
          description = COALESCE($2, description),
          color = COALESCE($3, color),
          is_public = COALESCE($4, is_public),
          updated_at = now()
      WHERE id = $5 AND deleted_at IS NULL
      RETURNING *
    `;
    const result = await conn.query(query, [title, description, color, is_public, calendarId]);
    return result.rows[0];
  }

  async softDelete(conn, calendarId) {
    const query = `
      UPDATE calendars
      SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
    `;
    await conn.query(query, [calendarId]);
  }

  // ============================================
  // Calendar Subscriptions 테이블
  // ============================================

  async subscribe(conn, userId, calId) {
    const query = `
      INSERT INTO calendar_subscriptions (user_id, calendar_id, created_at, updated_at)
      VALUES ($1, $2, now(), now())
      ON CONFLICT (user_id, calendar_id) DO UPDATE
      SET deleted_at = NULL, updated_at = now()
      RETURNING user_id, calendar_id, created_at, updated_at
    `;
    const result = await conn.query(query, [userId, calId]);
    return result.rows[0];
  }

  async unsubscribe(conn, userId, calId) {
    const query = `
      UPDATE calendar_subscriptions
      SET deleted_at = now(), updated_at = now()
      WHERE user_id = $1 AND calendar_id = $2 AND deleted_at IS NULL
    `;
    await conn.query(query, [userId, calId]);
  }

  async getSubscriptionsByUserId(conn, userId) {
    const query = `
      SELECT c.id, c.binder_id, c.title, c.description, c.color, c.is_public,
             c.created_at, c.updated_at,
             cs.created_at AS subscribed_at
      FROM calendar_subscriptions cs
      JOIN calendars c ON cs.calendar_id = c.id
      WHERE cs.user_id = $1 AND cs.deleted_at IS NULL AND c.deleted_at IS NULL
      ORDER BY cs.created_at ASC
    `;
    const result = await conn.query(query, [userId]);
    return result.rows;
  }

  async getSubscribersByCalId(conn, calId) {
    const query = `
      SELECT cs.user_id, cs.created_at AS subscribed_at,
             ui.display_name, ui.image_url, ui.thumbnail_url
      FROM calendar_subscriptions cs
      JOIN users u ON cs.user_id = u.id
      LEFT JOIN user_infos ui ON cs.user_id = ui.user_id
      WHERE cs.calendar_id = $1 AND cs.deleted_at IS NULL AND u.deleted_at IS NULL
      ORDER BY cs.created_at ASC
    `;
    const result = await conn.query(query, [calId]);
    return result.rows;
  }

  async getCalendarSubscriptions(conn, calId) {
    return this.getSubscribersByCalId(conn, calId);
  }

  async getShiftStats(conn, calId, period) {
    // period: 'YYYY-MM'
    const [year, month] = period.split('-').map(Number);
    const { rows } = await conn.query(
      `SELECT ep.user_id, ui.display_name,
              COUNT(ei.id) FILTER (WHERE ep.state = 3) AS confirmed_count,
              COUNT(ei.id) AS total_count
       FROM event_instances ei
       JOIN events e ON e.id = ei.event_id
       JOIN event_participants ep ON ep.instance_id = ei.id
       LEFT JOIN user_infos ui ON ep.user_id = ui.user_id
       WHERE e.calendar_id = $1
         AND EXTRACT(YEAR FROM ei.start_date) = $2
         AND EXTRACT(MONTH FROM ei.start_date) = $3
         AND ei.deleted_at IS NULL AND e.deleted_at IS NULL
       GROUP BY ep.user_id, ui.display_name
       ORDER BY confirmed_count DESC`,
      [calId, year, month]
    );
    return rows;
  }
}

module.exports = { CalendarDAO: new CalendarDAO() };
