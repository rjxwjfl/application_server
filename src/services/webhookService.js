/**
 * src/services/webhookService.js
 * =========================================
 * Apple S2S V2 / Google Play RTDN 웹훅 처리
 *
 * 핵심 패턴:
 *   withTransaction → insertReceiptLog (멱등성) → 상태 전이 → insertSubscriptionEvent → COMMIT → eventBus
 * =========================================
 */

const { BillingDAO } = require('../daos/billingDAO');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const withTransaction = require('../core/withTransaction');
const logger = require('../utils/logger');
const {
  ProductIdMap,
  SubscriptionStatus,
  SubscriptionEventType,
  GracePeriodDays,
  StorePlatform,
} = require('../configs/billing');

class WebhookService {
  // ═══════════════════════════════════════════════════════
  //  Apple S2S V2
  // ═══════════════════════════════════════════════════════

  async handleAppleNotification(payload) {
    const { notificationType, subtype, data } = payload;
    const { signedTransactionInfo, signedRenewalInfo } = data || {};

    if (!signedTransactionInfo) {
      logger.warn('Apple webhook missing signedTransactionInfo', { notificationType });
      return;
    }

    const txInfo = signedTransactionInfo;
    const renewalInfo = signedRenewalInfo || {};

    const handler = this._appleHandlers[notificationType];
    if (!handler) {
      logger.warn('Unhandled Apple notification type', { notificationType, subtype });
      return;
    }

    await handler.call(this, txInfo, renewalInfo, subtype);
  }

  get _appleHandlers() {
    return {
      SUBSCRIBED: this._appleSubscribed,
      DID_RENEW: this._appleDidRenew,
      DID_CHANGE_RENEWAL_STATUS: this._appleRenewalStatusChanged,
      GRACE_PERIOD_LAPSE: this._appleGracePeriod,
      EXPIRED: this._appleExpired,
      REFUND: this._appleRefund,
      CONSUMPTION_REQUEST: this._appleNoop,
      TEST: this._appleNoop,
    };
  }

  async _appleSubscribed(txInfo, renewalInfo, subtype) {
    const userId = txInfo.appAccountToken;
    if (!userId) {
      logger.warn('Apple SUBSCRIBED missing appAccountToken', { transactionId: txInfo.transactionId });
      return;
    }

    const result = await withTransaction(async (client) => {
      const inserted = await BillingDAO.insertReceiptLog(client, {
        user_id: userId,
        subscription_id: null,
        transaction_id: txInfo.transactionId,
        original_transaction_id: txInfo.originalTransactionId,
        store_type: StorePlatform.APPLE,
        event_type: SubscriptionEventType.SUBSCRIBED,
        raw_payload: txInfo,
      });
      if (!inserted) return null;

      if (txInfo.inAppOwnershipType === 'FAMILY_SHARED') return null;

      const mapping = ProductIdMap[txInfo.productId];
      if (!mapping) {
        logger.warn('Unknown Apple productId', { productId: txInfo.productId });
        return null;
      }

      const isTrial = subtype === 'INITIAL_BUY' && txInfo.offerType === 1;

      let subscription = await BillingDAO.findByOriginalTransactionId(client, txInfo.originalTransactionId);

      if (subscription) {
        subscription = await BillingDAO.updatePeriod(client, subscription.id, {
          status: isTrial ? SubscriptionStatus.TRIAL : SubscriptionStatus.ACTIVE,
          current_period_start: new Date(txInfo.purchaseDate),
          current_period_end: new Date(txInfo.expiresDate),
        });
      } else {
        subscription = await BillingDAO.create(client, {
          id: generateUUID(),
          user_id: userId,
          store_type: StorePlatform.APPLE,
          product_id: txInfo.productId,
          billing_cycle: mapping.cycle,
          status: isTrial ? SubscriptionStatus.TRIAL : SubscriptionStatus.ACTIVE,
          original_transaction_id: txInfo.originalTransactionId,
          current_period_start: new Date(txInfo.purchaseDate),
          current_period_end: new Date(txInfo.expiresDate),
        });
      }

      await BillingDAO.insertSubscriptionEvent(client, {
        user_id: userId,
        subscription_id: subscription.id,
        event_type: isTrial ? SubscriptionEventType.TRIAL_START : SubscriptionEventType.SUBSCRIBED,
        metadata: { productId: txInfo.productId, subtype },
      });

      return subscription;
    });

    if (result) {
      eventBus.emit('subscription:created', {
        user_id: result.user_id,
        subscription_id: result.id,
        product_id: result.product_id,
      });
      logger.info('Apple SUBSCRIBED processed', { subscriptionId: result.id });
    }
  }

  async _appleDidRenew(txInfo) {
    const result = await withTransaction(async (client) => {
      const subscription = await BillingDAO.findByOriginalTransactionId(client, txInfo.originalTransactionId);
      if (!subscription) {
        logger.warn('Apple DID_RENEW: subscription not found', { originalTransactionId: txInfo.originalTransactionId });
        return null;
      }

      const inserted = await BillingDAO.insertReceiptLog(client, {
        user_id: subscription.user_id,
        subscription_id: subscription.id,
        transaction_id: txInfo.transactionId,
        original_transaction_id: txInfo.originalTransactionId,
        store_type: StorePlatform.APPLE,
        event_type: SubscriptionEventType.RENEWED,
        raw_payload: txInfo,
      });
      if (!inserted) return null;

      await BillingDAO.updatePeriod(client, subscription.id, {
        status: SubscriptionStatus.ACTIVE,
        current_period_start: new Date(txInfo.purchaseDate),
        current_period_end: new Date(txInfo.expiresDate),
      });

      await BillingDAO.insertSubscriptionEvent(client, {
        user_id: subscription.user_id,
        subscription_id: subscription.id,
        event_type: SubscriptionEventType.RENEWED,
        metadata: { transactionId: txInfo.transactionId },
      });

      return subscription;
    });

    if (result) {
      logger.info('Apple DID_RENEW processed', { subscriptionId: result.id });
    }
  }

  async _appleRenewalStatusChanged(txInfo, renewalInfo, subtype) {
    await withTransaction(async (client) => {
      const subscription = await BillingDAO.findByOriginalTransactionId(client, txInfo.originalTransactionId);
      if (!subscription) return;

      const eventType = subtype === 'AUTO_RENEW_DISABLED'
        ? SubscriptionEventType.CANCELED
        : SubscriptionEventType.REINSTATED;

      const inserted = await BillingDAO.insertReceiptLog(client, {
        user_id: subscription.user_id,
        subscription_id: subscription.id,
        transaction_id: `renewal_status_${txInfo.originalTransactionId}_${Date.now()}`,
        original_transaction_id: txInfo.originalTransactionId,
        store_type: StorePlatform.APPLE,
        event_type: eventType,
        raw_payload: { txInfo, renewalInfo, subtype },
      });
      if (!inserted) return;

      if (subtype === 'AUTO_RENEW_DISABLED') {
        await BillingDAO.markCanceled(client, subscription.id);
      } else {
        await BillingDAO.reinstate(client, subscription.id);
      }

      await BillingDAO.insertSubscriptionEvent(client, {
        user_id: subscription.user_id,
        subscription_id: subscription.id,
        event_type: eventType,
        metadata: { subtype },
      });

      logger.info('Apple RENEWAL_STATUS_CHANGED processed', { subscriptionId: subscription.id, subtype });
    });
  }

  async _appleGracePeriod(txInfo) {
    const result = await withTransaction(async (client) => {
      const subscription = await BillingDAO.findByOriginalTransactionId(client, txInfo.originalTransactionId);
      if (!subscription) return null;

      const inserted = await BillingDAO.insertReceiptLog(client, {
        user_id: subscription.user_id,
        subscription_id: subscription.id,
        transaction_id: `grace_${txInfo.originalTransactionId}_${Date.now()}`,
        original_transaction_id: txInfo.originalTransactionId,
        store_type: StorePlatform.APPLE,
        event_type: SubscriptionEventType.GRACE_START,
        raw_payload: txInfo,
      });
      if (!inserted) return null;

      const gracePeriodEnd = new Date(txInfo.expiresDate);
      gracePeriodEnd.setDate(gracePeriodEnd.getDate() + GracePeriodDays.apple);

      await BillingDAO.updateStatus(client, subscription.id, {
        status: SubscriptionStatus.PAST_DUE,
        grace_period_end: gracePeriodEnd,
      });

      await BillingDAO.insertSubscriptionEvent(client, {
        user_id: subscription.user_id,
        subscription_id: subscription.id,
        event_type: SubscriptionEventType.GRACE_START,
        metadata: { grace_period_end: gracePeriodEnd.toISOString() },
      });

      return { subscription, gracePeriodEnd };
    });

    if (result) {
      eventBus.emit('subscription:grace_period', {
        user_id: result.subscription.user_id,
        subscription_id: result.subscription.id,
        grace_period_end: result.gracePeriodEnd,
      });
      logger.info('Apple GRACE_PERIOD processed', { subscriptionId: result.subscription.id });
    }
  }

  async _appleExpired(txInfo) {
    const result = await withTransaction(async (client) => {
      const subscription = await BillingDAO.findByOriginalTransactionId(client, txInfo.originalTransactionId);
      if (!subscription) return null;

      const inserted = await BillingDAO.insertReceiptLog(client, {
        user_id: subscription.user_id,
        subscription_id: subscription.id,
        transaction_id: `expired_${txInfo.originalTransactionId}_${Date.now()}`,
        original_transaction_id: txInfo.originalTransactionId,
        store_type: StorePlatform.APPLE,
        event_type: SubscriptionEventType.EXPIRED,
        raw_payload: txInfo,
      });
      if (!inserted) return null;

      await BillingDAO.expire(client, subscription.id);

      await BillingDAO.insertSubscriptionEvent(client, {
        user_id: subscription.user_id,
        subscription_id: subscription.id,
        event_type: SubscriptionEventType.EXPIRED,
        metadata: {},
      });

      return subscription;
    });

    if (result) {
      eventBus.emit('subscription:expired', {
        user_id: result.user_id,
        subscription_id: result.id,
      });
      logger.info('Apple EXPIRED processed', { subscriptionId: result.id });
    }
  }

  async _appleRefund(txInfo) {
    const result = await withTransaction(async (client) => {
      const subscription = await BillingDAO.findByOriginalTransactionId(client, txInfo.originalTransactionId);
      if (!subscription) return null;

      const inserted = await BillingDAO.insertReceiptLog(client, {
        user_id: subscription.user_id,
        subscription_id: subscription.id,
        transaction_id: `refund_${txInfo.transactionId}`,
        original_transaction_id: txInfo.originalTransactionId,
        store_type: StorePlatform.APPLE,
        event_type: SubscriptionEventType.REFUNDED,
        raw_payload: txInfo,
      });
      if (!inserted) return null;

      await BillingDAO.expire(client, subscription.id);

      await BillingDAO.insertSubscriptionEvent(client, {
        user_id: subscription.user_id,
        subscription_id: subscription.id,
        event_type: SubscriptionEventType.REFUNDED,
        metadata: { revocationDate: txInfo.revocationDate, revocationReason: txInfo.revocationReason },
      });

      return subscription;
    });

    if (result) {
      eventBus.emit('subscription:refunded', {
        user_id: result.user_id,
        subscription_id: result.id,
      });
      logger.info('Apple REFUND processed', { subscriptionId: result.id });
    }
  }

  async _appleNoop() {
    // TEST, CONSUMPTION_REQUEST 등 처리 불필요 이벤트
  }

  // ═══════════════════════════════════════════════════════
  //  Google Play RTDN
  // ═══════════════════════════════════════════════════════

  async handleGoogleNotification(message) {
    const { subscriptionNotification, oneTimeProductNotification } = message;

    if (subscriptionNotification) {
      await this._handleGoogleSubscription(subscriptionNotification);
    } else if (oneTimeProductNotification) {
      logger.info('Google one-time product notification received', { oneTimeProductNotification });
    } else {
      logger.warn('Unknown Google notification format', { message });
    }
  }

  async _handleGoogleSubscription(notification) {
    const { purchaseToken, subscriptionId, notificationType } = notification;

    let purchaseData;
    try {
      purchaseData = await this._getGoogleSubscriptionState(purchaseToken, subscriptionId);
    } catch (apiError) {
      logger.error('Google Play API call failed', { subscriptionId, error: apiError.message });
      throw apiError;
    }

    const result = await withTransaction(async (client) => {
      const mapping = ProductIdMap[subscriptionId];
      if (!mapping) {
        logger.warn('Unknown Google subscriptionId', { subscriptionId });
        return null;
      }

      const transactionId = `google_${purchaseToken}_${notificationType}_${Date.now()}`;
      let subscription = await BillingDAO.findByOriginalTransactionId(client, purchaseToken);

      const userId = subscription?.user_id || purchaseData.obfuscatedExternalAccountId;
      if (!userId) {
        logger.warn('Google subscription missing user identifier');
        return null;
      }

      const inserted = await BillingDAO.insertReceiptLog(client, {
        user_id: userId,
        subscription_id: subscription?.id || null,
        transaction_id: transactionId,
        original_transaction_id: purchaseToken,
        store_type: StorePlatform.GOOGLE,
        event_type: this._mapGoogleNotificationType(notificationType),
        raw_payload: { notification, purchaseData },
      });
      if (!inserted) return null;

      switch (notificationType) {
        case 4: // SUBSCRIPTION_PURCHASED
        case 7: { // SUBSCRIPTION_RESTARTED
          if (subscription) {
            subscription = await BillingDAO.updatePeriod(client, subscription.id, {
              status: SubscriptionStatus.ACTIVE,
              current_period_start: new Date(purchaseData.startTime),
              current_period_end: new Date(purchaseData.expiryTime),
            });
          } else {
            subscription = await BillingDAO.create(client, {
              id: generateUUID(),
              user_id: userId,
              store_type: StorePlatform.GOOGLE,
              product_id: subscriptionId,
              billing_cycle: mapping.cycle,
              status: SubscriptionStatus.ACTIVE,
              original_transaction_id: purchaseToken,
              current_period_start: new Date(purchaseData.startTime),
              current_period_end: new Date(purchaseData.expiryTime),
            });
          }

          await BillingDAO.insertSubscriptionEvent(client, {
            user_id: userId,
            subscription_id: subscription.id,
            event_type: SubscriptionEventType.SUBSCRIBED,
            metadata: { subscriptionId, notificationType },
          });

          return { action: 'created', subscription };
        }

        case 2: { // SUBSCRIPTION_RENEWED
          if (!subscription) return null;

          await BillingDAO.updatePeriod(client, subscription.id, {
            status: SubscriptionStatus.ACTIVE,
            current_period_start: new Date(purchaseData.startTime),
            current_period_end: new Date(purchaseData.expiryTime),
          });

          await BillingDAO.insertSubscriptionEvent(client, {
            user_id: userId,
            subscription_id: subscription.id,
            event_type: SubscriptionEventType.RENEWED,
            metadata: { notificationType },
          });

          return { action: 'renewed', subscription };
        }

        case 3: { // SUBSCRIPTION_CANCELED
          if (!subscription) return null;

          await BillingDAO.markCanceled(client, subscription.id);

          await BillingDAO.insertSubscriptionEvent(client, {
            user_id: userId,
            subscription_id: subscription.id,
            event_type: SubscriptionEventType.CANCELED,
            metadata: { notificationType },
          });

          return { action: 'canceled', subscription };
        }

        case 6: { // SUBSCRIPTION_IN_GRACE_PERIOD
          if (!subscription) return null;

          const gracePeriodEnd = new Date(purchaseData.expiryTime);
          gracePeriodEnd.setDate(gracePeriodEnd.getDate() + GracePeriodDays.google);

          await BillingDAO.updateStatus(client, subscription.id, {
            status: SubscriptionStatus.PAST_DUE,
            grace_period_end: gracePeriodEnd,
          });

          await BillingDAO.insertSubscriptionEvent(client, {
            user_id: userId,
            subscription_id: subscription.id,
            event_type: SubscriptionEventType.GRACE_START,
            metadata: { grace_period_end: gracePeriodEnd.toISOString() },
          });

          return { action: 'grace_period', subscription, gracePeriodEnd };
        }

        case 13: { // SUBSCRIPTION_EXPIRED
          if (!subscription) return null;

          await BillingDAO.expire(client, subscription.id);

          await BillingDAO.insertSubscriptionEvent(client, {
            user_id: userId,
            subscription_id: subscription.id,
            event_type: SubscriptionEventType.EXPIRED,
            metadata: { notificationType },
          });

          return { action: 'expired', subscription };
        }

        case 12: { // SUBSCRIPTION_REVOKED (환불)
          if (!subscription) return null;

          await BillingDAO.expire(client, subscription.id);

          await BillingDAO.insertSubscriptionEvent(client, {
            user_id: userId,
            subscription_id: subscription.id,
            event_type: SubscriptionEventType.REFUNDED,
            metadata: { notificationType },
          });

          return { action: 'refunded', subscription };
        }

        default: {
          logger.info('Google notification type not handled', { notificationType });
          return null;
        }
      }
    });

    if (!result) return;

    const { action, subscription, gracePeriodEnd } = result;

    if (action === 'created') {
      eventBus.emit('subscription:created', {
        user_id: subscription.user_id,
        subscription_id: subscription.id,
        product_id: subscription.product_id,
      });
    } else if (action === 'grace_period') {
      eventBus.emit('subscription:grace_period', {
        user_id: subscription.user_id,
        subscription_id: subscription.id,
        grace_period_end: gracePeriodEnd,
      });
    } else if (action === 'expired') {
      eventBus.emit('subscription:expired', {
        user_id: subscription.user_id,
        subscription_id: subscription.id,
      });
    } else if (action === 'refunded') {
      eventBus.emit('subscription:refunded', {
        user_id: subscription.user_id,
        subscription_id: subscription.id,
      });
    }
  }

  // RLY-20260806-199 — subscriptionId는 호출부(this._getGoogleSubscriptionState(purchaseToken,
  // subscriptionId), line ~355)가 넘기지만 이 메서드 본문(Google Play API 호출)은 packageName·
  // purchaseToken만 쓴다 — 결제 로직 자체를 만지지 말라는 이번 태스크 지시에 따라 시그니처·
  // 호출 로직은 그대로 두고 이름만 밑줄 접두어로 "의도적으로 안 씀"을 표시했다. Google Play
  // API 연동이 실제로 완전한지(subscriptionId가 애초에 필요 없는지, 아니면 빠진 사용처가
  // 있는지)는 결제 도메인 판단이 필요해 조사·수정하지 않았다 — 구현 보고서에 등재.
  async _getGoogleSubscriptionState(purchaseToken, _subscriptionId) {
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });

    const androidpublisher = google.androidpublisher({ version: 'v3', auth });
    const packageName = process.env.GOOGLE_PLAY_PACKAGE_NAME;

    const response = await androidpublisher.purchases.subscriptionsv2.get({
      packageName,
      token: purchaseToken,
    });

    return response.data;
  }

  _mapGoogleNotificationType(type) {
    const map = {
      1: SubscriptionEventType.SUBSCRIBED,
      2: SubscriptionEventType.RENEWED,
      3: SubscriptionEventType.CANCELED,
      4: SubscriptionEventType.SUBSCRIBED,
      6: SubscriptionEventType.GRACE_START,
      7: SubscriptionEventType.REINSTATED,
      12: SubscriptionEventType.REFUNDED,
      13: SubscriptionEventType.EXPIRED,
    };
    return map[type] || SubscriptionEventType.SUBSCRIBED;
  }
}

module.exports = { WebhookService: new WebhookService() };
