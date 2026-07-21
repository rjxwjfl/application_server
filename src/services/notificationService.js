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
      let userIds = target_user_ids;
      if (!userIds || userIds.length === 0) {
        const members = await NotificationDAO.getMembersForAlert(pool, binder_id, requiredLevel);
        userIds = members.map((m) => m.user_id).filter((id) => id !== sender_id);
      } else {
        userIds = userIds.filter((id) => id !== sender_id);
      }

      if (userIds.length === 0) return;

      const devices = await NotificationDAO.getActiveTokensByUserIds(pool, userIds);
      const tokens = devices.map((d) => d.device_token);

      if (tokens.length === 0) return;

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

      const notification_type = ALERT_TYPE_MAP[type] || ActionType.CREATE;
      const notifications = userIds.map((userId) => ({
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
