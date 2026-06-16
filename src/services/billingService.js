const { BillingDAO } = require('../daos/billingDAO');
const { generateUUID } = require('../utils/uuid');
const pool = require('../../config/db');
const withTransaction = require('../core/withTransaction');
const { ConflictError, BadRequestError } = require('../core/errors');
const logger = require('../utils/logger');
const {
  Plans,
  ProductIdMap,
  SubscriptionStatus,
  SubscriptionEventType,
} = require('../configs/billing');

class BillingService {
  async getSubscriptionStatus(userId) {
    const subscription = await BillingDAO.findActiveByUserId(pool, userId);
    if (!subscription) {
      return { plan: Plans.FREE, subscription: null };
    }

    const planInfo = this._resolvePlan(subscription.product_id);
    return { plan: planInfo, subscription };
  }

  async getEntitlements(userId) {
    const subscription = await BillingDAO.findActiveByUserId(pool, userId);
    const assets = await BillingDAO.findAssetsByUserId(pool, userId);

    let plan = Plans.FREE;

    if (subscription) {
      const { status, cancel_at_period_end, current_period_end } = subscription;
      const now = new Date();

      const isActive = status === SubscriptionStatus.ACTIVE
        || status === SubscriptionStatus.TRIAL
        || status === SubscriptionStatus.PAST_DUE
        || (status === SubscriptionStatus.CANCELED
          && cancel_at_period_end
          && new Date(current_period_end) > now);

      if (isActive) {
        plan = this._resolvePlan(subscription.product_id);
      }
    }

    return {
      plan,
      features: plan.features,
      assets: assets.map((a) => ({ type: a.asset_type, id: a.asset_id })),
    };
  }

  async checkFeatureAccess(userId, feature) {
    const { plan } = await this.getEntitlements(userId);
    return plan.features.includes(feature);
  }

  async verifyAndActivatePurchase(userId, receiptData) {
    const existing = await BillingDAO.findActiveByUserId(pool, userId);
    if (existing && existing.status !== SubscriptionStatus.EXPIRED) {
      throw new ConflictError('이미 활성 구독이 있습니다');
    }

    const { store_type, product_id, transaction_id, original_transaction_id } = receiptData;

    const mapping = ProductIdMap[product_id];
    if (!mapping) throw new BadRequestError('유효하지 않은 상품 ID입니다');

    if (original_transaction_id) {
      const existingSub = await BillingDAO.findByOriginalTransactionId(pool, original_transaction_id);
      if (existingSub && existingSub.user_id !== userId) {
        throw new ConflictError('이 구매는 다른 계정에 연결되어 있습니다');
      }
    }

    const subscriptionId = generateUUID();

    const subscription = await withTransaction(async (client) => {
      const subscription = await BillingDAO.create(client, {
        id: subscriptionId,
        user_id: userId,
        store_type,
        product_id,
        billing_cycle: mapping.cycle,
        status: receiptData.is_trial ? SubscriptionStatus.TRIAL : SubscriptionStatus.ACTIVE,
        original_transaction_id: original_transaction_id || transaction_id,
        current_period_start: receiptData.period_start || new Date(),
        current_period_end: receiptData.period_end,
        cancel_at_period_end: false,
      });

      await BillingDAO.insertReceiptLog(client, {
        user_id: userId,
        subscription_id: subscriptionId,
        transaction_id,
        original_transaction_id: original_transaction_id || transaction_id,
        store_type,
        event_type: receiptData.is_trial
          ? SubscriptionEventType.TRIAL_START
          : SubscriptionEventType.SUBSCRIBED,
        raw_payload: receiptData,
      });

      await BillingDAO.insertSubscriptionEvent(client, {
        user_id: userId,
        subscription_id: subscriptionId,
        event_type: receiptData.is_trial
          ? SubscriptionEventType.TRIAL_START
          : SubscriptionEventType.SUBSCRIBED,
        metadata: { product_id, store_type },
      });

      return subscription;
    });

    logger.info('Subscription activated', { userId, subscriptionId, store_type, product_id });
    return subscription;
  }

  async verifyAndRecordAssetPurchase(userId, data) {
    const asset = await BillingDAO.insertAsset(pool, {
      user_id: userId,
      asset_type: data.asset_type,
      asset_id: data.asset_id,
    });

    if (!asset) return { already_owned: true };

    logger.info('Asset purchased', { userId, asset_type: data.asset_type, asset_id: data.asset_id });
    return asset;
  }

  async restorePurchases(userId, receipts) {
    const results = [];

    for (const receipt of receipts) {
      const { original_transaction_id } = receipt;
      const existing = await BillingDAO.findByOriginalTransactionId(pool, original_transaction_id);

      if (existing) {
        if (existing.user_id !== userId) {
          results.push({
            original_transaction_id,
            status: 'error',
            message: '다른 계정에 연결된 구매입니다',
          });
          continue;
        }
        results.push({
          original_transaction_id,
          status: 'restored',
          subscription: existing,
        });
      } else {
        results.push({
          original_transaction_id,
          status: 'not_found',
          message: '서버에 기록이 없습니다. 웹훅 수신 후 자동 복원됩니다.',
        });
      }
    }

    return results;
  }

  async getSubscriptionHistory(userId) {
    const subscription = await BillingDAO.findActiveByUserId(pool, userId);
    if (!subscription) return { subscription: null, events: [] };

    const events = await BillingDAO.getEventsBySubscriptionId(pool, subscription.id);
    return { subscription, events };
  }

  async cancelSubscription(userId) {
    const subscription = await BillingDAO.findActiveByUserId(pool, userId);
    if (!subscription) throw new BadRequestError('활성 구독이 없습니다');

    await withTransaction(async (client) => {
      await BillingDAO.markCanceled(client, subscription.id);
      await BillingDAO.insertSubscriptionEvent(client, {
        user_id: userId,
        subscription_id: subscription.id,
        event_type: SubscriptionEventType.CANCELED,
        metadata: { reason: 'user_request' },
      });
    });

    logger.info('Subscription canceled', { userId, subscriptionId: subscription.id });
  }

  async getAssets(userId) {
    const result = await pool.query(
      `SELECT asset_type, asset_id, purchased_at
       FROM user_assets
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY purchased_at DESC`,
      [userId]
    );
    return result.rows;
  }

  _resolvePlan(productId) {
    const mapping = ProductIdMap[productId];
    return mapping?.plan || Plans.FREE;
  }
}

module.exports = { BillingService: new BillingService() };
