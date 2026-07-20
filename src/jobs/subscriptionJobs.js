/**
 * src/jobs/subscriptionJobs.js
 * =========================================
 * 구독 만료 배치 크론
 *
 * - 매 시간 :00 — 유예기간 만료 체크 → EXPIRED
 * - 매 시간 :30 — 취소 후 기간 만료 체크 → EXPIRED
 * =========================================
 */

const { BillingDAO } = require('../daos/billingDAO');
const { SubscriptionEventType } = require('../configs/billing');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const pool = require('../../config/db');
const logger = require('../utils/logger');

const CANDIDATE_QUERY_MAX_ATTEMPTS = 2;
const CANDIDATE_QUERY_RETRY_DELAY_MS = 250;

function isConnectionEstablishmentTimeout(error) {
  return error?.message === 'Connection terminated due to connection timeout'
    || error?.message === 'timeout exceeded when trying to connect';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryCandidatesWithRetry(jobName, queryCandidates) {
  for (let attempt = 1; attempt <= CANDIDATE_QUERY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await queryCandidates();
    } catch (error) {
      logger.error('Subscription candidate query failed', {
        jobName,
        attempt,
        errorName: error?.name,
        errorCode: error?.code,
        errorMessage: error?.message,
      });

      if (!isConnectionEstablishmentTimeout(error)
          || attempt === CANDIDATE_QUERY_MAX_ATTEMPTS) {
        throw error;
      }

      await delay(CANDIDATE_QUERY_RETRY_DELAY_MS);
    }
  }
}

async function rollbackSafely(client, jobName) {
  try {
    await client.query('ROLLBACK');
  } catch (rollbackError) {
    logger.error('Subscription transaction rollback failed', {
      jobName,
      errorName: rollbackError?.name,
      errorCode: rollbackError?.code,
      errorMessage: rollbackError?.message,
    });
  }
}

/**
 * 유예기간 만료 체크
 * PAST_DUE && grace_period_end < now → EXPIRED
 */
async function expireGracePeriodSubscriptions() {
  try {
    const now = new Date();
    const expired = await queryCandidatesWithRetry(
      'expireGracePeriodSubscriptions',
      () => BillingDAO.findExpiredGracePeriods(pool, now),
    );

    if (expired.length === 0) return;

    logger.info('Grace period expiration batch', { count: expired.length });

    for (const sub of expired) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await BillingDAO.expire(client, sub.id);

        await BillingDAO.insertSubscriptionEvent(client, {
          id: generateUUID(),
          subscription_id: sub.id,
          event_type: SubscriptionEventType.EXPIRED,
          metadata: { reason: 'grace_period_expired' },
        });

        await client.query('COMMIT');

        eventBus.emit('subscription:expired', {
          user_id: sub.user_id,
          subscription_id: sub.id,
        });

        logger.info('Grace period subscription expired', { subscriptionId: sub.id, userId: sub.user_id });
      } catch (error) {
        await rollbackSafely(client, 'expireGracePeriodSubscriptions');
        logger.error('Failed to expire grace period subscription', { subscriptionId: sub.id, error: error.message });
      } finally {
        client.release();
      }
    }
  } catch (error) {
    logger.error('Grace period expiration batch failed', {
      jobName: 'expireGracePeriodSubscriptions',
      errorName: error?.name,
      errorCode: error?.code,
      errorMessage: error?.message,
    });
  }
}

/**
 * 취소 후 기간 만료 체크
 * CANCELED && cancel_at_period_end && current_period_end < now → EXPIRED
 */
async function expireCanceledSubscriptions() {
  try {
    const now = new Date();
    const expired = await queryCandidatesWithRetry(
      'expireCanceledSubscriptions',
      () => BillingDAO.findExpiredCanceledSubscriptions(pool, now),
    );

    if (expired.length === 0) return;

    logger.info('Canceled subscription expiration batch', { count: expired.length });

    for (const sub of expired) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await BillingDAO.expire(client, sub.id);

        await BillingDAO.insertSubscriptionEvent(client, {
          id: generateUUID(),
          subscription_id: sub.id,
          event_type: SubscriptionEventType.EXPIRED,
          metadata: { reason: 'canceled_period_ended' },
        });

        await client.query('COMMIT');

        eventBus.emit('subscription:expired', {
          user_id: sub.user_id,
          subscription_id: sub.id,
        });

        logger.info('Canceled subscription expired', { subscriptionId: sub.id, userId: sub.user_id });
      } catch (error) {
        await rollbackSafely(client, 'expireCanceledSubscriptions');
        logger.error('Failed to expire canceled subscription', { subscriptionId: sub.id, error: error.message });
      } finally {
        client.release();
      }
    }
  } catch (error) {
    logger.error('Canceled subscription expiration batch failed', {
      jobName: 'expireCanceledSubscriptions',
      errorName: error?.name,
      errorCode: error?.code,
      errorMessage: error?.message,
    });
  }
}

/**
 * 크론 스케줄러 시작
 */
function startSubscriptionJobs() {
  // 매 시간 :00 — 유예기간 만료 체크
  setInterval(() => {
    const now = new Date();
    if (now.getMinutes() === 0) {
      expireGracePeriodSubscriptions();
    }
  }, 60 * 1000); // 1분마다 체크

  // 매 시간 :30 — 취소 후 기간 만료 체크
  setInterval(() => {
    const now = new Date();
    if (now.getMinutes() === 30) {
      expireCanceledSubscriptions();
    }
  }, 60 * 1000);

  logger.info('Subscription cron jobs started');
}

module.exports = {
  expireGracePeriodSubscriptions,
  expireCanceledSubscriptions,
  startSubscriptionJobs,
  queryCandidatesWithRetry,
};
