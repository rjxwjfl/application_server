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

  // RLY-20260806-190 — User 판정: 알림은 두 채널이다. 기기 푸시(FCM)는 notification_level
  // (선호)을 따르지만, 인앱 알림센터(notifications 행)는 "모든 상황에" 항상 남아야 한다.
  // 예전 getMembersForAlert(notification_level <= maxLevel을 SQL WHERE절에 바로 건 브로드
  // 캐스트 전용 조회)는 가시성(binder 멤버인가)과 선호(수준을 낮췄는가)를 한 번에 걸러
  // 인앱 기록까지 함께 사라지게 했다 — 삭제하고 이 메서드로 대체한다. 가시성만(활성 멤버
  // 전원, role>=0) 가져온다 — 선호는 sendAlert가 이 결과에 별도로
  // filterUserIdsByNotificationLevel을 적용해 "푸시 대상만" 추가로 좁힌다(인앱 insert
  // 대상 목록은 이 메서드의 결과 그대로 쓴다).
  async getActiveMemberIds(conn, binderId) {
    const query = `
      SELECT dm.user_id
      FROM binder_members dm
      WHERE dm.binder_id = $1
        AND dm.deleted_at IS NULL
        AND dm.role >= 0
    `;
    const result = await conn.query(query, [binderId]);
    return result.rows.map((row) => row.user_id);
  }

  /**
   * notification_level 기준으로 후보 목록 필터링(선호 — 푸시 전용)
   * notification_level: 0=모두, 1=관련만, 2=멘션만, 3=수신거부
   */
  // RLY-20260806-184 — notificationService.sendAlert가 target_user_ids를 명시로 받는 경로
  // (멘션·반응·배정·강퇴 등)에서 그동안 notification_level을 전혀 안 봤다. RLY-20260806-190
  // 부터는 브로드캐스트 경로도 이 메서드를 함께 쓴다(가시성은 getActiveMemberIds가 이미
  // 걸렀으니, 여기서는 순수하게 선호만 추가로 좁힌다 — 두 경로가 이제 같은 함수를 공유한다).
  //
  // ⚠️ deleted_at IS NULL을 넣지 않았다 — 브로드캐스트 경로와 다르다. 강퇴(member_kicked)
  // 알림은 대상이 이미 binder_members에서 소프트 삭제된 뒤(kickBinderMember 트랜잭션
  // 커밋 후) 발송된다 — deleted_at IS NULL을 넣으면 강퇴된 바로 그 사람이 자기 강퇴
  // 알림 대상에서 걸러져 "강퇴됐다는 사실 자체를 통보받지 못하는" 새로운 결함이 생긴다.
  // binder_members.PRIMARY KEY(binder_id,user_id)라 이 조회는 소프트 삭제 여부와 무관하게
  // 그 사람이 마지막으로 가졌던 notification_level을 그대로 읽는다 — 목적(수신자 개인의
  // 알림 강도 설정을 반영)에 정확히 부합한다. role >= 0도 넣지 않았다 — chk_bm_role
  // CHECK(role BETWEEN 0 AND 3)로 음수 role 자체가 스키마에서 불가능해져(RLY-20260806-024)
  // 이제 항상 참인 죽은 조건이다.
  async filterUserIdsByNotificationLevel(conn, binderId, userIds, maxLevel) {
    if (!userIds || userIds.length === 0) return [];
    const query = `
      SELECT dm.user_id
      FROM binder_members dm
      WHERE dm.binder_id = $1
        AND dm.user_id = ANY($2::uuid[])
        AND dm.notification_level <= $3
    `;
    const result = await conn.query(query, [binderId, userIds, maxLevel]);
    return result.rows.map((row) => row.user_id);
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
