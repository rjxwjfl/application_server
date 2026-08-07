class NotificationDAO {
  /**
   * 유저의 활성 디바이스 토큰 조회
   */
  async getActiveTokensByUserId(conn, userId) {
    const query = `
      SELECT device_token, device_uuid
      FROM user_devices
      WHERE user_id = $1 AND is_active = TRUE AND device_token IS NOT NULL
    `;
    const result = await conn.query(query, [userId]);
    return result.rows;
  }

  /**
   * 다수 유저의 활성 디바이스 토큰 일괄 조회
   */
  async getActiveTokensByUserIds(conn, userIds) {
    if (!userIds || userIds.length === 0) return [];
    const query = `
      SELECT user_id, device_token, device_uuid
      FROM user_devices
      WHERE user_id = ANY($1) AND is_active = TRUE AND device_token IS NOT NULL
    `;
    const result = await conn.query(query, [userIds]);
    return result.rows;
  }

  /**
   * 유저가 속한 바인더 ID 목록 조회
   */
  // role >= 0 — join-request pending(role=-1, RLY-20260806-018) 신청자의 디바이스를 해당
  // 바인더의 FCM 토픽(subscribeUserToAllBinders)에 구독시키지 않는다. 구독되면 승인 전인데도
  // 바인더 활동(SYNC/ALERT) 푸시를 받게 된다.
  async getBinderIdsByUserId(conn, userId) {
    const query = `
      SELECT binder_id
      FROM binder_members
      WHERE user_id = $1 AND deleted_at IS NULL AND role >= 0
    `;
    const result = await conn.query(query, [userId]);
    return result.rows.map((r) => r.binder_id);
  }

  /**
   * 만료 토큰 비활성화
   */
  async deactivateTokens(conn, tokens) {
    if (!tokens || tokens.length === 0) return;
    const query = `
      UPDATE user_devices
      SET is_active = FALSE, updated_at = NOW()
      WHERE device_token = ANY($1)
    `;
    await conn.query(query, [tokens]);
  }

  /**
   * notification_level 기준으로 바인더 멤버 필터링
   * notification_level: 0=모두, 1=관련만, 2=멘션만, 3=수신거부
   */
  // role >= 0 — pending(role=-1) 신청자는 ALERT 대상에서 제외한다(RLY-20260806-018). 대상에
  // 들면 승인 전에 binder 활동 알림(메시지 미리보기 등 title/body 포함)을 받게 된다.
  async getMembersForAlert(conn, binderId, maxLevel) {
    const query = `
      SELECT dm.user_id, dm.notification_level, dm.role
      FROM binder_members dm
      WHERE dm.binder_id = $1
        AND dm.deleted_at IS NULL
        AND dm.role >= 0
        AND dm.notification_level <= $2
    `;
    const result = await conn.query(query, [binderId, maxLevel]);
    return result.rows;
  }

  /**
   * 알림 벌크 INSERT (새 스키마)
   */
  async insertNotificationsBulk(conn, notifications) {
    if (!notifications || notifications.length === 0) return;

    const values = [];
    const params = [];
    let idx = 1;

    for (const n of notifications) {
      values.push(
        `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
      );
      params.push(
        n.id,
        n.recipient_id,
        n.sender_id || null,
        n.notification_type,
        n.route_type,
        n.route_id || null,
        n.binder_id || null,
        n.title || null,
        n.body || null,
        n.payload ? JSON.stringify(n.payload) : null,
      );
    }

    const query = `
      INSERT INTO notifications (id, recipient_id, sender_id, notification_type, route_type, route_id, binder_id, title, body, payload)
      VALUES ${values.join(', ')}
    `;
    await conn.query(query, params);
  }

  async getByRecipient(conn, recipientId, { cursor_at, limit = 30, unread_only = false } = {}) {
    const conditions = ['recipient_id = $1', 'deleted_at IS NULL'];
    const params = [recipientId];
    let paramIdx = 2;

    if (unread_only) {
      conditions.push('is_read = FALSE');
    }
    if (cursor_at) {
      conditions.push(`created_at < $${paramIdx++}`);
      params.push(cursor_at);
    }
    params.push(limit);

    // RLY-20260806-147 — group_key는 폐기 컬럼(T-1, design_intent.md 판정 블록)이라 SELECT
    // 목록에서 제거했다. 채울 규칙이 영구히 없어 "미사용 표시"가 아니라 컬럼 자체를 지웠다.
    const query = `
      SELECT id, recipient_id, sender_id, notification_type, route_type, route_id,
             binder_id, title, body, payload, is_read, created_at
      FROM notifications
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${paramIdx}
    `;
    const result = await conn.query(query, params);
    return result.rows;
  }

  async markAsRead(conn, notificationId, recipientId) {
    const query = `
      UPDATE notifications
      SET is_read = TRUE, updated_at = now()
      WHERE id = $1 AND recipient_id = $2
    `;
    await conn.query(query, [notificationId, recipientId]);
  }

  async markAllAsRead(conn, recipientId) {
    const query = `
      UPDATE notifications
      SET is_read = TRUE, updated_at = now()
      WHERE recipient_id = $1 AND is_read = FALSE
    `;
    await conn.query(query, [recipientId]);
  }

  async softDelete(conn, notificationId, recipientId) {
    const query = `
      UPDATE notifications
      SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND recipient_id = $2
    `;
    await conn.query(query, [notificationId, recipientId]);
  }

  async getUnreadCount(conn, recipientId) {
    const query = `
      SELECT COUNT(*) AS count
      FROM notifications
      WHERE recipient_id = $1 AND is_read = FALSE AND deleted_at IS NULL
    `;
    const result = await conn.query(query, [recipientId]);
    return parseInt(result.rows[0].count, 10);
  }
}

module.exports = { NotificationDAO: new NotificationDAO() };
