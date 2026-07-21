class ActivityFeedDAO {
  async insert(conn, { binder_id, actor_id, action_type, target_type, target_id, metadata }) {
    const query = `
      INSERT INTO activity_feeds (binder_id, actor_id, action_type, target_type, target_id, metadata)
      VALUES ($1, $2, $3, $4, $5, $6)
    `;
    await conn.query(query, [
      binder_id,
      actor_id || null,
      action_type,
      target_type,
      target_id,
      metadata ? JSON.stringify(metadata) : null,
    ]);
  }

  async getByBinder(conn, binderId, { cursor_id, cursor_at, limit = 30 } = {}) {
    let query;
    let params;

    if (cursor_id && cursor_at) {
      query = `
        SELECT id, binder_id, actor_id, action_type, target_type, target_id, metadata, created_at
        FROM activity_feeds
        WHERE binder_id = $1 AND (created_at, id) < ($2, $3)
        ORDER BY created_at DESC, id DESC
        LIMIT $4
      `;
      params = [binderId, cursor_at, cursor_id, limit];
    } else {
      query = `
        SELECT id, binder_id, actor_id, action_type, target_type, target_id, metadata, created_at
        FROM activity_feeds
        WHERE binder_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2
      `;
      params = [binderId, limit];
    }

    const result = await conn.query(query, params);
    return result.rows;
  }

  async getCursor(conn, userId, binderId) {
    const query = `
      SELECT last_read_feed_id, last_read_feed_at, updated_at
      FROM activity_feed_cursors
      WHERE user_id = $1 AND binder_id = $2
    `;
    const result = await conn.query(query, [userId, binderId]);
    return result.rows[0] || null;
  }

  async upsertCursor(conn, userId, binderId, feedId, feedAt) {
    const query = `
      INSERT INTO activity_feed_cursors (user_id, binder_id, last_read_feed_id, last_read_feed_at, updated_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (user_id, binder_id) DO UPDATE
      SET last_read_feed_id = GREATEST(activity_feed_cursors.last_read_feed_id, $3),
          last_read_feed_at = GREATEST(activity_feed_cursors.last_read_feed_at, $4),
          updated_at = now()
    `;
    await conn.query(query, [userId, binderId, feedId, feedAt]);
  }

  async getUnreadCount(conn, userId, binderId) {
    const query = `
      SELECT COUNT(*) AS count
      FROM activity_feeds af
      LEFT JOIN activity_feed_cursors afc
        ON afc.user_id = $1 AND afc.binder_id = $2
      WHERE af.binder_id = $2
        AND (afc.last_read_feed_id IS NULL OR (af.created_at, af.id) > (afc.last_read_feed_at, afc.last_read_feed_id))
    `;
    const result = await conn.query(query, [userId, binderId]);
    return parseInt(result.rows[0].count, 10);
  }
}

module.exports = { ActivityFeedDAO: new ActivityFeedDAO() };
