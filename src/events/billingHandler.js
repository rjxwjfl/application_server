/**
 * src/events/billingHandler.js
 * =========================================
 * 구독 이벤트 핸들러
 *
 * 이벤트: subscription:created, subscription:expired,
 *         subscription:refunded, subscription:grace_period
 * =========================================
 */

const eventBus = require('./eventBus');
const notificationService = require('../services/notificationService');
const logger = require('../utils/logger');

eventBus.on('subscription:created', ({ user_id, subscription_id, plan_id }) => {
  logger.info('Subscription created', { user_id, subscription_id, plan_id });

  notificationService.sendAlert({
    sender_id: user_id,
    type: 'subscription',
    title: '구독 완료',
    body: '프리미엄 구독이 활성화되었습니다.',
    target_user_ids: [user_id],
    routeData: { route_type: 80, route_id: subscription_id },
  });
});

eventBus.on('subscription:expired', ({ user_id, subscription_id }) => {
  logger.info('Subscription expired', { user_id, subscription_id });

  notificationService.sendAlert({
    sender_id: user_id,
    type: 'subscription',
    title: '구독 만료',
    body: '프리미엄 구독이 만료되었습니다. 무료 플랜으로 전환됩니다.',
    target_user_ids: [user_id],
    routeData: { route_type: 80, route_id: subscription_id },
  });
});

eventBus.on('subscription:refunded', ({ user_id, subscription_id }) => {
  logger.info('Subscription refunded', { user_id, subscription_id });

  notificationService.sendAlert({
    sender_id: user_id,
    type: 'subscription',
    title: '구독 환불',
    body: '구독이 환불 처리되었습니다. 무료 플랜으로 전환됩니다.',
    target_user_ids: [user_id],
    routeData: { route_type: 80, route_id: subscription_id },
  });
});

eventBus.on('subscription:grace_period', ({ user_id, subscription_id, grace_period_end }) => {
  logger.info('Subscription grace period started', { user_id, subscription_id, grace_period_end });

  notificationService.sendAlert({
    sender_id: user_id,
    type: 'subscription',
    title: '결제 실패',
    body: '구독 갱신 결제가 실패했습니다. 결제 수단을 확인해주세요.',
    target_user_ids: [user_id],
    routeData: { route_type: 80, route_id: subscription_id },
  });
});
