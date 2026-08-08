const fcm = require('../utils/fcm');
const { NotificationDAO } = require('../daos/notificationDAO');
const { generateUUID } = require('../utils/uuid');
const pool = require('../../config/db');
const logger = require('../utils/logger');
const { getRedis } = require('../loaders/redisLoader');
const { ActionType, TargetType } = require('../utils/typeDefinitions');

// semantic type → ActionType v4 문자열
const ALERT_TYPE_MAP = {
  assignment: ActionType.ASSIGN,
  mention: ActionType.CREATE,
  invitation: ActionType.JOIN,
  approval: ActionType.JOIN,
  reminder: ActionType.CREATE,
  rsvp: ActionType.RSVP_UPDATE,
  reaction: ActionType.REACT,
  pin: ActionType.PIN,
  message: ActionType.CREATE,
  // RLY-20260806-203(T-N1~N3) — 신규 3종. member_joined·member_kicked는 ALERT_TYPE_MAP
  // 도입 이전부터 있던 호출부라 매핑이 없고 기본값(ActionType.CREATE)으로 떨어진다 —
  // 그 둘은 이번 범위가 아니라 손대지 않는다(기존 notification_type 값 변경 = 동작 변경).
  post_created: ActionType.CREATE,
  role_change: ActionType.ROLE_CHANGE,
  member_left: ActionType.LEAVE,
};

class NotificationService {
  async sendSync({ binder_id, sender_id, device_uuid }) {
    try {
      const debounced = await this._debounceSync(binder_id);
      if (debounced) {
        logger.debug('SYNC debounced, skipping', { binder_id });
        return;
      }

      const topic = `binder_${binder_id}`;
      const data = {
        type: 'SYNC',
        binder_id: String(binder_id || ''),
        sender_id: String(sender_id || ''),
        device_uuid: String(device_uuid || ''),
        timestamp: Date.now().toString(),
      };

      await fcm.sendToTopic(topic, data);
    } catch (error) {
      logger.error('SYNC push failed', { binder_id, error: error.message });
    }
  }

  /**
   * ALERT 푸시: notification+data, Multicast
   *
   * RLY-20260806-190 — User 판정: 알림은 두 채널이다.
   *   · 기기 푸시(FCM)      — notification_level(선호)을 따른다. "안 받음"이면 안 간다.
   *   · 인앱 알림센터(notifications 행) — 항상 남는다. 모든 상황에.
   * 가시성(볼 수 없는 섹션인가 등)과 선호(notification_level)는 다른 축이다 — 가시성은
   * 두 채널 모두에 적용하고(볼 수 없으면 애초에 알림 자체가 성립하지 않는다), 선호는
   * 푸시에만 적용한다. 아래 흐름이 그 구분을 그대로 코드로 옮긴 것이다:
   *   1) visibleUserIds — 가시성만 통과(자기 자신 제외 + SECTION_MESSAGE 접근 좁히기).
   *      이 목록 그대로 인앱 notifications INSERT 대상이 된다 — 기기 등록 여부·
   *      notification_level과 무관하게 항상 여기까지 도달한 사람은 기록이 남는다.
   *   2) pushUserIds — visibleUserIds에 notification_level 필터를 추가로 적용한 부분집합.
   *      FCM 발송 대상만 이걸로 좁힌다.
   *
   * @param {string} params.binder_id
   * @param {string} params.sender_id
   * @param {string} params.type - 알림 유형 (assignment, mention, invitation, approval, reminder, message 등)
   * @param {string} params.title
   * @param {string} params.body
   * @param {string[]} [params.target_user_ids]
   * @param {number} [params.requiredLevel=0]
   * @param {object} [params.routeData] - { route_type (TargetType v4 string), route_id }
   * @param {string} [params.device_uuid]
   */
  async sendAlert({
    binder_id,
    sender_id,
    type,
    title,
    body,
    target_user_ids,
    requiredLevel = 0,
    routeData = {},
    device_uuid,
  }) {
    try {
      // ── ① 가시성(visibility) — 두 채널 모두에 적용 ──────────────────────────
      let visibleUserIds = target_user_ids;
      if (!visibleUserIds || visibleUserIds.length === 0) {
        // 브로드캐스트(target_user_ids 미지정) — 활성 멤버 전원(가시성만, 선호는 아직 안 봄).
        const memberIds = await NotificationDAO.getActiveMemberIds(pool, binder_id);
        visibleUserIds = memberIds.filter((id) => id !== sender_id);
      } else {
        visibleUserIds = visibleUserIds.filter((id) => id !== sender_id);
      }

      if (routeData.route_type === TargetType.SECTION_MESSAGE && routeData.route_id) {
        // role >= 0 — 방어적 필터(RLY-20260806-018). visibleUserIds는 이미 브로드캐스트
        // 경로에서 pending을 걸렀지만, target_user_ids로 직접 넘어온 경우까지 대비한다.
        // 이건 "이 메시지가 속한 비공개 섹션을 볼 수 있는가" — 가시성이라 두 채널 모두에
        // 적용해야 맞다(선호 필터가 아니다).
        const { rows } = await pool.query(
          `SELECT bm.user_id FROM section_messages m
           JOIN sections s ON s.id = m.section_id
           JOIN binder_members bm ON bm.binder_id = s.binder_id AND bm.deleted_at IS NULL AND bm.role >= 0
           WHERE m.id = $1 AND bm.user_id = ANY($2::uuid[]) AND (s.access_scope = 0 OR
             EXISTS (SELECT 1 FROM section_members sm WHERE sm.section_id = s.id
                 AND sm.user_id = bm.user_id AND sm.deleted_at IS NULL))`,
          [routeData.route_id, visibleUserIds]
        );
        visibleUserIds = rows.map((row) => row.user_id);
      }

      if (visibleUserIds.length === 0) return;

      // ── ② 인앱 알림센터 — 가시성만 통과하면 항상 기록한다(User 판정: "모든 상황에") ──
      const notification_type = ALERT_TYPE_MAP[type] || ActionType.CREATE;
      const notifications = visibleUserIds.map((userId) => ({
        id: generateUUID(),
        recipient_id: userId,
        sender_id,
        notification_type,
        route_type: routeData.route_type || TargetType.SECTION_MESSAGE,
        route_id: routeData.route_id || null,
        binder_id,
        title,
        body,
        payload: { ...routeData, device_uuid },
      }));
      await NotificationDAO.insertNotificationsBulk(pool, notifications);

      // ── ③ 선호(preference) — notification_level, 기기 푸시에만 적용 ──────────
      // binder_id가 없는 알림(구독 등, billingHandler.js)은 notification_level 개념 자체가
      // 성립하지 않아(user 단위, binder 스코프 없음) 필터 없이 그대로 푸시 대상이 된다.
      let pushUserIds = visibleUserIds;
      if (binder_id) {
        pushUserIds = await NotificationDAO.filterUserIdsByNotificationLevel(pool, binder_id, visibleUserIds, requiredLevel);
      }
      if (pushUserIds.length === 0) return;

      const devices = await NotificationDAO.getActiveTokensByUserIds(pool, pushUserIds);
      const tokens = devices.map((d) => d.device_token);
      if (tokens.length === 0) return; // 인앱 기록은 이미 ②에서 끝났다 — 여기서 return해도 손실 없음.

      const data = {
        type: 'ALERT',
        binder_id: String(binder_id || ''),
        sender_id: String(sender_id || ''),
        device_uuid: String(device_uuid || ''),
        route_type: String(routeData.route_type || ''),
        route_id: String(routeData.route_id || ''),
        timestamp: Date.now().toString(),
      };

      const result = await fcm.sendMulticast(tokens, { title, body }, data);

      if (result.staleTokens.length > 0) {
        await NotificationDAO.deactivateTokens(pool, result.staleTokens);
        logger.info('Deactivated stale tokens', { count: result.staleTokens.length });
      }
    } catch (error) {
      logger.error('ALERT push failed', { binder_id, type, error: error.message });
    }
  }

  async subscribeUserToAllBinders(userId) {
    try {
      const devices = await NotificationDAO.getActiveTokensByUserId(pool, userId);
      const tokens = devices.map((d) => d.device_token);
      if (tokens.length === 0) return;

      const binderIds = await NotificationDAO.getBinderIdsByUserId(pool, userId);
      for (const binderId of binderIds) {
        await fcm.subscribeToTopic(tokens, `binder_${binderId}`);
      }
      logger.info('Subscribed user to all binder topics', { userId, binderCount: binderIds.length });
    } catch (error) {
      logger.error('subscribeUserToAllBinders failed', { userId, error: error.message });
    }
  }

  async subscribeUserToBinder(userId, binderId) {
    try {
      const devices = await NotificationDAO.getActiveTokensByUserId(pool, userId);
      const tokens = devices.map((d) => d.device_token);
      if (tokens.length === 0) return;
      await fcm.subscribeToTopic(tokens, `binder_${binderId}`);
    } catch (error) {
      logger.error('subscribeUserToBinder failed', { userId, binderId, error: error.message });
    }
  }

  async unsubscribeUserFromBinder(userId, binderId) {
    try {
      const devices = await NotificationDAO.getActiveTokensByUserId(pool, userId);
      const tokens = devices.map((d) => d.device_token);
      if (tokens.length === 0) return;
      await fcm.unsubscribeFromTopic(tokens, `binder_${binderId}`);
    } catch (error) {
      logger.error('unsubscribeUserFromBinder failed', { userId, binderId, error: error.message });
    }
  }

  async _debounceSync(binderId) {
    const redis = getRedis();
    if (!redis) return false;
    const key = `sync_debounce:${binderId}`;
    const result = await redis.set(key, '1', 'EX', 2, 'NX');
    return result === null;
  }
}

module.exports = new NotificationService();
