class ActivityFeedDAO {
  async insert(conn, { drawer_id, actor_id, action_type, target_type, target_id, metadata }) {
    const query = `
      INSERT INTO activity_feeds (drawer_id, actor_id, action_type, target_type, target_id, metadata)
      VALUES ($1, $2, $3, $4, $5, $6)
    `;
    await conn.query(query, [
      drawer_id,
      actor_id || null,
      action_type,
      target_type,
      target_id,
      metadata ? JSON.stringify(metadata) : null,
    ]);
  }

  async getByDrawer(conn, drawerId, { cursor_id, cursor_at, limit = 30 } = {}) {
    let query;
    let params;

    if (cursor_id && cursor_at) {
      query = `
        SELECT id, drawer_id, actor_id, action_type, target_type, target_id, metadata, created_at
        FROM activity_feeds
        WHERE drawer_id = $1 AND (created_at, id) < ($2, $3)
        ORDER BY created_at DESC, id DESC
        LIMIT $4
      `;
      params = [drawerId, cursor_at, cursor_id, limit];
    } else {
      query = `
        SELECT id, drawer_id, actor_id, action_type, target_type, target_id, metadata, created_at
        FROM activity_feeds
        WHERE drawer_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2
      `;
      params = [drawerId, limit];
    }

    const result = await conn.query(query, params);
    return result.rows;
  }

  async getCursor(conn, userId, drawerId) {
    const query = `
      SELECT last_read_feed_id, last_read_feed_at, updated_at
      FROM activity_feed_cursors
      WHERE user_id = $1 AND drawer_id = $2
    `;
    const result = await conn.query(query, [userId, drawerId]);
    return result.rows[0] || null;
  }

  async upsertCursor(conn, userId, drawerId, feedId, feedAt) {
    const query = `
      INSERT INTO activity_feed_cursors (user_id, drawer_id, last_read_feed_id, last_read_feed_at, updated_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (user_id, drawer_id) DO UPDATE
      SET last_read_feed_id = GREATEST(activity_feed_cursors.last_read_feed_id, $3),
          last_read_feed_at = GREATEST(activity_feed_cursors.last_read_feed_at, $4),
          updated_at = now()
    `;
    await conn.query(query, [userId, drawerId, feedId, feedAt]);
  }

  async getUnreadCount(conn, userId, drawerId) {
    const query = `
      SELECT COUNT(*) AS count
      FROM activity_feeds af
      LEFT JOIN activity_feed_cursors afc
        ON afc.user_id = $1 AND afc.drawer_id = $2
      WHERE af.drawer_id = $2
        AND (afc.last_read_feed_id IS NULL OR (af.created_at, af.id) > (afc.last_read_feed_at, afc.last_read_feed_id))
    `;
    const result = await conn.query(query, [userId, drawerId]);
    return parseInt(result.rows[0].count, 10);
  }
}

module.exports = { ActivityFeedDAO: new ActivityFeedDAO() };
