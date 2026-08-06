class SyncDAO {

  // =========================================================================
  // 권한 획득 유틸리티
  // =========================================================================
  // role >= 0 — join-request pending(role=-1, RLY-20260806-018) 바인더는 이 유저의 동기화
  // 스코프(currDIds)에 넣지 않는다. 이 함수가 sync 파이프라인 전체의 접근 스코프 뿌리이므로,
  // 여기서 빠지면 getSection·getEventsDeltaFull 등 하위 모든 델타 쿼리가 자동으로 차단된다.
  //
  // b.deleted_at IS NULL — RLY-20260806-025 방어선. binder 삭제 cascade(BinderDAO.cascadeSoftDelete)가
  // binder_members도 함께 soft delete하므로 정상 경로에서는 이 join 없이도 막힌다. 그래도 건다 —
  // cascade가 부분 실패했거나 과거(cascade 도입 전) 데이터가 남아 binder_members만 살아있는 경우의
  // 방어선이다.
  static async getBinderIdsByUserId(pool, userId) {
    const { rows } = await pool.query(
      `SELECT bm.binder_id FROM binder_members bm
       JOIN binders b ON b.id = bm.binder_id
       WHERE bm.user_id = $1 AND bm.deleted_at IS NULL AND bm.role >= 0 AND b.deleted_at IS NULL`,
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
    // role >= 0 — pending(role=-1) 신청자를 다른 멤버의 동기화 페이로드(멤버 로스터)에 노출하지
    // 않는다(RLY-20260806-018). currDIds는 이미 getBinderIdsByUserId에서 필터되므로 이 필터가
    // 실제로 걸러내는 건 "요청자는 진짜 멤버지만 같은 바인더에 다른 pending 신청자가 있는" 경우다.
    const query = `
      SELECT binder_id, user_id, role, nickname_in_binder, joined_at,
             created_at, updated_at, deleted_at
      FROM binder_members
      WHERE binder_id = ANY($1::uuid[]) AND deleted_at IS NULL AND role >= 0
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
        -- role >= 0 — pending(role=-1) 신청자의 프로필을 다른 멤버 동기화에 끼워 보내지 않는다
        -- (RLY-20260806-018).
        SELECT DISTINCT dm.user_id FROM binder_members dm
        WHERE dm.binder_id = ANY($1::uuid[]) AND dm.deleted_at IS NULL AND dm.role >= 0
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
    // role >= 0 — currDIds는 이미 getBinderIdsByUserId에서 pending 바인더를 걸러내지만, 이 JOIN과
    // "role <= 1(master·manager 전체 섹션 접근)" 비교 자체도 독립적으로 뚫려 있었다: role=-1이
    // "<= 1"을 통과해 대기 신청자가 비공개 섹션까지 전부 받아가는 경로였다(RLY-20260806-018).
    const query = `
      SELECT s.* FROM sections s
      JOIN binder_members bm ON bm.binder_id = s.binder_id
        AND bm.user_id = $1 AND bm.deleted_at IS NULL AND bm.role >= 0
      WHERE s.binder_id = ANY($2::uuid[])
        AND (
          (s.deleted_at IS NULL AND (
            bm.role BETWEEN 0 AND 1
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

  static async fetchSectionMembers(pool, binderId, userId, since) {
    const { rows } = await pool.query(
      `SELECT sm.*
       FROM section_members sm
       JOIN sections s ON s.id = sm.section_id
       WHERE s.binder_id = $1
         AND ($3::timestamptz IS NULL OR sm.updated_at >= $3)
         AND (
           -- active rows: sections the requester can access
           (sm.deleted_at IS NULL AND s.deleted_at IS NULL AND (
             s.access_scope = 0
             OR EXISTS (
               SELECT 1 FROM section_members own_sm
               WHERE own_sm.section_id = sm.section_id
                 AND own_sm.user_id = $2
                 AND own_sm.deleted_at IS NULL
             )
           ))
           -- tombstones: self-removal OR other members removed from sections requester is still in
           OR (sm.deleted_at IS NOT NULL AND (
             sm.user_id = $2
             OR s.access_scope = 0
             OR EXISTS (
               SELECT 1 FROM section_members own_sm
               WHERE own_sm.section_id = sm.section_id
                 AND own_sm.user_id = $2
                 AND own_sm.deleted_at IS NULL
             )
           ))
         )
       ORDER BY sm.updated_at, sm.id`,
      [binderId, userId, since]
    );
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
    // c.deleted_at IS NULL은 "새로 접근 가능해진 캘린더의 현재 스냅샷" 브랜치(두 번째 SELECT)에만
    // 건다(RLY-20260806-025 방어선) — 델타/tombstone 브랜치(첫 SELECT, oldDIds 스코프)에 걸면 캘린더
    // cascade로 e.deleted_at이 막 세팅된 이벤트 자체가 tombstone으로 못 나간다(다른 멤버가 삭제를
    // 통보받지 못함). 캘린더가 삭제됐다는 사실은 이벤트 자신의 deleted_at 필드로 이미 실린다.
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
        AND c.deleted_at IS NULL
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
        ((c.binder_id = ANY($4::uuid[]) OR e.calendar_id = ANY($5::uuid[])) AND i.deleted_at IS NULL AND c.deleted_at IS NULL AND i.start_date >= $6)
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
        ((c.binder_id = ANY($4::uuid[]) OR e.calendar_id = ANY($5::uuid[])) AND ep.deleted_at IS NULL AND c.deleted_at IS NULL)
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
        ((c.binder_id = ANY($4::uuid[]) OR t.calendar_id = ANY($5::uuid[])) AND t.deleted_at IS NULL AND c.deleted_at IS NULL AND (t.created_at >= $6 OR t.updated_at >= $6))
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
        ((c.binder_id = ANY($4::uuid[]) OR t.calendar_id = ANY($5::uuid[])) AND ti.deleted_at IS NULL AND c.deleted_at IS NULL AND ti.due_date >= $6)
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
        ((c.binder_id = ANY($4::uuid[]) OR t.calendar_id = ANY($5::uuid[])) AND tp.deleted_at IS NULL AND c.deleted_at IS NULL)
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
        ((c.binder_id = ANY($4::uuid[]) OR sd.calendar_id = ANY($5::uuid[])) AND sd.deleted_at IS NULL AND c.deleted_at IS NULL)
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
    // 순수 스냅샷 쿼리(델타/tombstone 분기 없음) — c.deleted_at IS NULL 추가는 방어선일 뿐 tombstone
    // 경로를 건드리지 않는다(RLY-20260806-025).
    const query = `
      SELECT e.* FROM events e
      JOIN calendars c ON e.calendar_id = c.id
      WHERE (c.binder_id = ANY($1::uuid[]) OR e.calendar_id = ANY($2::uuid[]))
        AND e.deleted_at IS NULL
        AND c.deleted_at IS NULL
    `;
    const { rows } = await pool.query(query, [ctx.currDIds, ctx.currCIds]);
    return { events: rows };
  }
}

module.exports = { SyncDAO };
