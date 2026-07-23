class SyncDAO {

  // =========================================================================
  // 권한 획득 유틸리티
  // =========================================================================
  static async getBinderIdsByUserId(pool, userId) {
    const { rows } = await pool.query(
      `SELECT binder_id FROM binder_members WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId]
    );
    return rows.map(r => r.binder_id);
  }

  static async getSubscribedCalIdsByUserId(pool, userId) {
    const { rows } = await pool.query(
      `SELECT calendar_id FROM calendar_subscriptions WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId]
    );
    return rows.map(r => r.calendar_id);
  }

  // =========================================================================
  // Track A: Meta Data 쿼리 (무조건 100% 최신)
  // =========================================================================
  static async getBindersForSync(pool, currDIds, currCIds) {
    const query = `
      SELECT d.* FROM binders d
      WHERE (
        d.id = ANY($1::uuid[])
        OR d.id IN (SELECT binder_id FROM calendars WHERE id = ANY($2::uuid[]))
      )
      AND d.deleted_at IS NULL
    `;
    const { rows } = await pool.query(query, [currDIds, currCIds]);
    return rows;
  }

  static async getBinderMembers(pool, currDIds) {
    if (!currDIds.length) return [];
    const query = `
      SELECT binder_id, user_id, role, nickname_in_binder, joined_at,
             created_at, updated_at, deleted_at
      FROM binder_members
      WHERE binder_id = ANY($1::uuid[]) AND deleted_at IS NULL
    `;
    const { rows } = await pool.query(query, [currDIds]);
    return rows;
  }

  static async getBinderPreferences(pool, userId, currDIds) {
    if (!currDIds.length) return [];
    const query = `
      SELECT binder_id, user_id, role, nickname_in_binder, notification_level
      FROM binder_members
      WHERE user_id = $1 AND binder_id = ANY($2::uuid[]) AND deleted_at IS NULL
    `;
    const { rows } = await pool.query(query, [userId, currDIds]);
    return rows;
  }

  static async getUsersForSync(pool, currDIds, oldTs) {
    if (!currDIds.length) return [];
    const query = `
      SELECT u.id, ui.user_code, ui.display_name, ui.bio,
             ui.image_url, ui.thumbnail_url,
             u.created_at, ui.updated_at, u.deleted_at
      FROM user_infos ui
      JOIN users u ON ui.user_id = u.id
      WHERE ui.user_id IN (
        SELECT DISTINCT dm.user_id FROM binder_members dm
        WHERE dm.binder_id = ANY($1::uuid[]) AND dm.deleted_at IS NULL
      )
      ${oldTs ? 'AND ui.updated_at > $2' : ''}
    `;
    const params = oldTs ? [currDIds, oldTs] : [currDIds];
    const { rows } = await pool.query(query, params);
    return rows;
  }

  static async getBinderSettings(pool, currDIds) {
    if (!currDIds.length) return [];
    const query = `
      SELECT * FROM binder_settings WHERE binder_id = ANY($1::uuid[])
    `;
    const { rows } = await pool.query(query, [currDIds]);
    return rows;
  }

  static async getSection(pool, userId, currDIds, oldTs, previousSectionIds) {
    if (!currDIds.length) return [];
    const query = `
      SELECT s.* FROM sections s
      JOIN binder_members bm ON bm.binder_id = s.binder_id
        AND bm.user_id = $1 AND bm.deleted_at IS NULL
      WHERE s.binder_id = ANY($2::uuid[])
        AND (
          (s.deleted_at IS NULL AND (
            bm.role <= 1
            OR s.access_scope = 0
            OR EXISTS (
              SELECT 1 FROM section_members sm
              WHERE sm.section_id = s.id AND sm.user_id = $1 AND sm.deleted_at IS NULL
            )
          ))
          OR ($3::timestamptz IS NOT NULL
            AND s.id = ANY($4::uuid[])
            AND s.updated_at > $3)
        )
    `;
    const { rows } = await pool.query(query, [userId, currDIds, oldTs, previousSectionIds]);
    return rows;
  }

  static async getGroups(pool, currDIds, oldTs) {
    if (!currDIds.length) return [];
    const { rows } = await pool.query(
      `SELECT * FROM groups WHERE binder_id = ANY($1::uuid[]) ${oldTs ? 'AND updated_at > $2' : ''}`,
      oldTs ? [currDIds, oldTs] : [currDIds]
    );
    return rows;
  }

  static async getOwnGroupMembers(pool, userId, oldTs) {
    const { rows } = await pool.query(
      `SELECT * FROM group_members WHERE user_id = $1 ${oldTs ? 'AND updated_at > $2' : ''}`,
      oldTs ? [userId, oldTs] : [userId]
    );
    return rows;
  }

  static async getCalendarsForSync(pool, currDIds, currCIds) {
    const query = `
      SELECT * FROM calendars
      WHERE (binder_id = ANY($1::uuid[]) OR id = ANY($2::uuid[]))
      AND deleted_at IS NULL
    `;
    const { rows } = await pool.query(query, [currDIds, currCIds]);
    return rows;
  }

  static async getSubscribedCalendarRecords(pool, currCIds) {
    if (!currCIds.length) return [];
    const query = `
      SELECT * FROM calendar_subscriptions WHERE calendar_id = ANY($1::uuid[]) AND deleted_at IS NULL
    `;
    const { rows } = await pool.query(query, [currCIds]);
    return rows;
  }

  // =========================================================================
  // Track B: Calendar Data 쿼리 (Delta + Full + Tombstone)
  // =========================================================================
  static async getEventsDeltaFull(pool, ctx) {
    const query = `
      SELECT e.*, es.section_id FROM events e
      LEFT JOIN event_sections es ON es.event_id = e.id
      JOIN calendars c ON e.calendar_id = c.id
      WHERE (c.binder_id = ANY($1::uuid[]) OR e.calendar_id = ANY($2::uuid[]))
        AND e.updated_at > $3

      UNION ALL

      SELECT e.*, es.section_id FROM events e
      LEFT JOIN event_sections es ON es.event_id = e.id
      JOIN calendars c ON e.calendar_id = c.id
      WHERE (c.binder_id = ANY($4::uuid[]) OR e.calendar_id = ANY($5::uuid[]))
        AND e.deleted_at IS NULL
        AND (e.created_at >= $6 OR e.updated_at >= $6)
    `;
    const { rows } = await pool.query(query, [
      ctx.oldDIds, ctx.oldCIds, ctx.oldTs || new Date(0),
      ctx.newDIds, ctx.newCIds, ctx.calWindowFrom
    ]);
    return rows;
  }

  static async getEventInstancesDeltaFull(pool, ctx) {
    const query = `
      SELECT i.* FROM event_instances i
      JOIN events e ON i.event_id = e.id
      JOIN calendars c ON e.calendar_id = c.id
      WHERE (
        ((c.binder_id = ANY($1::uuid[]) OR e.calendar_id = ANY($2::uuid[])) AND i.updated_at > $3)
        OR
        ((c.binder_id = ANY($4::uuid[]) OR e.calendar_id = ANY($5::uuid[])) AND i.deleted_at IS NULL AND i.start_date >= $6)
      )
    `;
    const { rows } = await pool.query(query, [
      ctx.oldDIds, ctx.oldCIds, ctx.oldTs || new Date(0),
      ctx.newDIds, ctx.newCIds, ctx.calWindowFrom
    ]);
    return rows;
  }

  static async getEventParticipantsDeltaFull(pool, ctx) {
    const query = `
      SELECT ep.* FROM event_participants ep
      JOIN event_instances i ON ep.instance_id = i.id
      JOIN events e ON i.event_id = e.id
      JOIN calendars c ON e.calendar_id = c.id
      WHERE (
        ((c.binder_id = ANY($1::uuid[]) OR e.calendar_id = ANY($2::uuid[])) AND ep.updated_at > $3)
        OR
        ((c.binder_id = ANY($4::uuid[]) OR e.calendar_id = ANY($5::uuid[])) AND ep.deleted_at IS NULL)
      )
    `;
    const { rows } = await pool.query(query, [
      ctx.oldDIds, ctx.oldCIds, ctx.oldTs || new Date(0),
      ctx.newDIds, ctx.newCIds
    ]);
    return rows;
  }

  static async getTasksDeltaFull(pool, ctx) {
    const query = `
      SELECT t.* FROM tasks t
      JOIN calendars c ON t.calendar_id = c.id
      WHERE (
        ((c.binder_id = ANY($1::uuid[]) OR t.calendar_id = ANY($2::uuid[])) AND t.updated_at > $3)
        OR
        ((c.binder_id = ANY($4::uuid[]) OR t.calendar_id = ANY($5::uuid[])) AND t.deleted_at IS NULL AND (t.created_at >= $6 OR t.updated_at >= $6))
      )
    `;
    const { rows } = await pool.query(query, [
      ctx.oldDIds, ctx.oldCIds, ctx.oldTs || new Date(0),
      ctx.newDIds, ctx.newCIds, ctx.calWindowFrom
    ]);
    return rows;
  }

  static async getTaskInstancesDeltaFull(pool, ctx) {
    const query = `
      SELECT ti.* FROM task_instances ti
      JOIN tasks t ON ti.task_id = t.id
      JOIN calendars c ON t.calendar_id = c.id
      WHERE (
        ((c.binder_id = ANY($1::uuid[]) OR t.calendar_id = ANY($2::uuid[])) AND ti.updated_at > $3)
        OR
        ((c.binder_id = ANY($4::uuid[]) OR t.calendar_id = ANY($5::uuid[])) AND ti.deleted_at IS NULL AND ti.due_date >= $6)
      )
    `;
    const { rows } = await pool.query(query, [
      ctx.oldDIds, ctx.oldCIds, ctx.oldTs || new Date(0),
      ctx.newDIds, ctx.newCIds, ctx.calWindowFrom
    ]);
    return rows;
  }

  static async getTaskParticipantsDeltaFull(pool, ctx) {
    const query = `
      SELECT tp.* FROM task_participants tp
      JOIN task_instances ti ON tp.instance_id = ti.id
      JOIN tasks t ON ti.task_id = t.id
      JOIN calendars c ON t.calendar_id = c.id
      WHERE (
        ((c.binder_id = ANY($1::uuid[]) OR t.calendar_id = ANY($2::uuid[])) AND tp.updated_at > $3)
        OR
        ((c.binder_id = ANY($4::uuid[]) OR t.calendar_id = ANY($5::uuid[])) AND tp.deleted_at IS NULL)
      )
    `;
    const { rows } = await pool.query(query, [
      ctx.oldDIds, ctx.oldCIds, ctx.oldTs || new Date(0),
      ctx.newDIds, ctx.newCIds
    ]);
    return rows;
  }

  static async getSpecialDaysDeltaFull(pool, ctx) {
    const query = `
      SELECT sd.* FROM special_days sd
      JOIN calendars c ON sd.calendar_id = c.id
      WHERE (
        ((c.binder_id = ANY($1::uuid[]) OR sd.calendar_id = ANY($2::uuid[])) AND sd.updated_at > $3)
        OR
        ((c.binder_id = ANY($4::uuid[]) OR sd.calendar_id = ANY($5::uuid[])) AND sd.deleted_at IS NULL)
      )
    `;
    const { rows } = await pool.query(query, [
      ctx.oldDIds, ctx.oldCIds, ctx.oldTs || new Date(0),
      ctx.newDIds, ctx.newCIds
    ]);
    return rows;
  }

  // =========================================================================
  // Track C: Messaging Data 쿼리
  // =========================================================================
  static async getMessagesDeltaFull(pool, ctx) {
    const query = `
      SELECT m.* FROM section_messages m
      JOIN sections s ON m.section_id = s.id
      WHERE (s.access_scope = 0 OR EXISTS (
        SELECT 1 FROM section_members sm
        WHERE sm.section_id = s.id AND sm.user_id = $5 AND sm.deleted_at IS NULL
      )) AND (
        (s.binder_id = ANY($1::uuid[]) AND m.updated_at > $2)
        OR
        (s.binder_id = ANY($3::uuid[]) AND m.deleted_at IS NULL AND m.created_at >= $4)
        OR
        (s.id = ANY($6::uuid[]) AND m.deleted_at IS NULL AND m.created_at >= $4)
      )
      ORDER BY m.created_at DESC
    `;
    const { rows } = await pool.query(query, [
      ctx.oldDIds, ctx.oldTs || new Date(0),
      ctx.newDIds, ctx.msgWindowFrom, ctx.userId, ctx.hydrateSectionIds
    ]);
    return rows;
  }

  static async getMessageAttachments(pool, messageIds, oldTs) {
    if (!messageIds.length) return [];
    const query = `
      SELECT id, context_id AS message_id, filename, file_size, content_type, storage_key, status, updated_at
      FROM attachments
      WHERE context_type = 'SECTION_MESSAGE' AND context_id = ANY($1::uuid[]) AND deleted_at IS NULL
      ${oldTs ? 'AND updated_at > $2' : ''}
    `;
    const params = oldTs ? [messageIds, oldTs] : [messageIds];
    const { rows } = await pool.query(query, params);
    return rows;
  }

  static async getMessageEmbeds(pool, messageIds, oldTs) {
    if (!messageIds.length) return [];
    const query = `
      SELECT * FROM message_embeds
      WHERE message_id = ANY($1::uuid[])
      ${oldTs ? 'AND updated_at > $2' : ''}
    `;
    const params = oldTs ? [messageIds, oldTs] : [messageIds];
    const { rows } = await pool.query(query, params);
    return rows;
  }

  static async getMessageReactions(pool, messageIds, oldTs) {
    if (!messageIds.length) return [];
    const query = `
      SELECT * FROM message_reactions
      WHERE message_id = ANY($1::uuid[])
      ${oldTs ? 'AND updated_at > $2' : ''}
    `;
    const params = oldTs ? [messageIds, oldTs] : [messageIds];
    const { rows } = await pool.query(query, params);
    return rows;
  }

  static async getMessageMentions(pool, messageIds, oldTs) {
    if (!messageIds.length) return [];
    const query = `
      SELECT * FROM message_mentions
      WHERE message_id = ANY($1::uuid[])
      ${oldTs ? 'AND updated_at > $2' : ''}
    `;
    const params = oldTs ? [messageIds, oldTs] : [messageIds];
    const { rows } = await pool.query(query, params);
    return rows;
  }

  // =========================================================================
  // Personal Data 쿼리
  // =========================================================================
  static async getNotifications(pool, userId, since) {
    const query = `
      SELECT * FROM notifications
      WHERE recipient_id = $1 AND created_at > $2
      ORDER BY created_at DESC
    `;
    const { rows } = await pool.query(query, [userId, since]);
    return rows;
  }

  static async getUserSubscriptions(pool, userId, oldTs) {
    const query = `
      SELECT * FROM user_subscriptions
      WHERE user_id = $1
      ${oldTs ? 'AND updated_at > $2' : ''}
    `;
    const params = oldTs ? [userId, oldTs] : [userId];
    const { rows } = await pool.query(query, params);
    return rows;
  }

  static async getUserAssets(pool, userId, oldTs) {
    const query = `
      SELECT * FROM user_assets
      WHERE user_id = $1
      ${oldTs ? 'AND purchased_at > $2' : ''}
    `;
    const params = oldTs ? [userId, oldTs] : [userId];
    const { rows } = await pool.query(query, params);
    return rows;
  }

  static async getUserHolidayCountries(pool, userId) {
    const query = `
      SELECT UNNEST(holidays_countries) AS country_code
      FROM user_settings
      WHERE user_id = $1 AND holidays_countries IS NOT NULL AND holidays_countries != '{}'
    `;
    const { rows } = await pool.query(query, [userId]);
    return rows.map(r => r.country_code);
  }

  static async getActivityFeedsForSync(pool, userId, currDIds, oldTs) {
    if (!currDIds.length) return [];
    const query = `
      SELECT id, binder_id, actor_id, action_type, target_type, target_id, metadata, created_at
      FROM activity_feeds
      WHERE binder_id = ANY($2::uuid[])
      ${oldTs ? 'AND created_at > $3' : ''}
        AND CASE
          WHEN target_type = 'SECTION' THEN EXISTS (
            SELECT 1 FROM sections s
            WHERE s.id = activity_feeds.target_id
              AND s.deleted_at IS NULL
              AND (s.access_scope = 0 OR EXISTS (
                SELECT 1 FROM section_members secm
                WHERE secm.section_id = s.id AND secm.user_id = $1 AND secm.deleted_at IS NULL
              ))
          )
          WHEN target_type = 'SECTION_MESSAGE' THEN EXISTS (
            SELECT 1 FROM section_messages sm
            JOIN sections s ON s.id = sm.section_id
            WHERE sm.id = activity_feeds.target_id
              AND (s.access_scope = 0 OR EXISTS (
                SELECT 1 FROM section_members secm
                WHERE secm.section_id = s.id AND secm.user_id = $1 AND secm.deleted_at IS NULL
              ))
          )
          ELSE true
        END
      ORDER BY created_at DESC
      LIMIT 500
    `;
    const params = oldTs ? [userId, currDIds, oldTs] : [userId, currDIds];
    const { rows } = await pool.query(query, params);
    return rows;
  }

  static async getAccessibleSectionIds(pool, userId, binderIds) {
    if (!binderIds.length) return [];
    const { rows } = await pool.query(
      `SELECT s.id
       FROM sections s
       WHERE s.binder_id = ANY($2::uuid[]) AND s.deleted_at IS NULL
         AND (s.access_scope = 0 OR EXISTS (
           SELECT 1 FROM section_members sm
           WHERE sm.section_id = s.id AND sm.user_id = $1 AND sm.deleted_at IS NULL
         ))`,
      [userId, binderIds]
    );
    return rows.map((row) => row.id);
  }

  static async getActivityFeedCursorsForSync(pool, userId, currDIds) {
    if (!currDIds.length) return [];
    const query = `
      SELECT user_id, binder_id, last_read_feed_id, last_read_feed_at, updated_at
      FROM activity_feed_cursors
      WHERE user_id = $1 AND binder_id = ANY($2::uuid[])
    `;
    const { rows } = await pool.query(query, [userId, currDIds]);
    return rows;
  }

  static async getHolidays(pool, countryCodes, oldTs) {
    const query = `
      SELECT * FROM holidays
      WHERE country_code = ANY($1::text[])
      ${oldTs ? 'AND updated_at > $2' : ''}
    `;
    const params = oldTs ? [countryCodes, oldTs] : [countryCodes];
    const { rows } = await pool.query(query, params);
    return rows;
  }

  // =========================================================================
  // Contextual Fetch 전용 쿼리 (위젯 스크롤 시)
  // =========================================================================
  static async getCalendarDataOnlyByWindow(pool, ctx) {
    const query = `
      SELECT e.* FROM events e
      JOIN calendars c ON e.calendar_id = c.id
      WHERE (c.binder_id = ANY($1::uuid[]) OR e.calendar_id = ANY($2::uuid[]))
        AND e.deleted_at IS NULL
    `;
    const { rows } = await pool.query(query, [ctx.currDIds, ctx.currCIds]);
    return { events: rows };
  }
}

module.exports = { SyncDAO };
