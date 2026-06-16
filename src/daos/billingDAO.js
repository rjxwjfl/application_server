/**
 * src/daos/billingDAO.js
 * =========================================
 * 빌링/구독 데이터 접근 객체
 *
 * 테이블: user_subscriptions, payment_receipt_logs,
 *         subscription_events, user_assets
 * =========================================
 */

class BillingDAOClass {
  // ─── user_subscriptions ───────────────────────────────

  async findActiveByUserId(conn, userId) {
    const query = `
      SELECT * FROM user_subscriptions
      WHERE user_id = $1 AND status IN ('ACTIVE', 'PAST_DUE', 'CANCELED')
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const result = await conn.query(query, [userId]);
    return result.rows[0] || null;
  }

  async findById(conn, id) {
    const query = `
      SELECT * FROM user_subscriptions
      WHERE id = $1
    `;
    const result = await conn.query(query, [id]);
    return result.rows[0] || null;
  }

  async findByOriginalTransactionId(conn, originalTransactionId) {
    const query = `
      SELECT * FROM user_subscriptions
      WHERE original_transaction_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const result = await conn.query(query, [originalTransactionId]);
    return result.rows[0] || null;
  }

  async create(conn, data) {
    const query = `
      INSERT INTO user_subscriptions (
        id, user_id, store_type, product_id, billing_cycle,
        status, original_transaction_id,
        current_period_start, current_period_end,
        cancel_at_period_end, grace_period_end,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7,
        $8, $9,
        $10, $11,
        now(), now()
      ) RETURNING *
    `;
    const result = await conn.query(query, [
      data.id, data.user_id, data.store_type, data.product_id, data.billing_cycle,
      data.status, data.original_transaction_id,
      data.current_period_start, data.current_period_end,
      data.cancel_at_period_end || false, data.grace_period_end || null,
    ]);
    return result.rows[0];
  }

  async updateStatus(conn, id, statusData) {
    const fields = [];
    const values = [];
    let idx = 1;

    if (statusData.status !== undefined) {
      fields.push(`status = $${idx++}`);
      values.push(statusData.status);
    }
    if (statusData.grace_period_end !== undefined) {
      fields.push(`grace_period_end = $${idx++}`);
      values.push(statusData.grace_period_end);
    }
    if (statusData.cancel_at_period_end !== undefined) {
      fields.push(`cancel_at_period_end = $${idx++}`);
      values.push(statusData.cancel_at_period_end);
    }
    if (statusData.canceled_at !== undefined) {
      fields.push(`canceled_at = $${idx++}`);
      values.push(statusData.canceled_at);
    }
    if (statusData.cancel_reason !== undefined) {
      fields.push(`cancel_reason = $${idx++}`);
      values.push(statusData.cancel_reason);
    }

    if (fields.length === 0) return null;

    fields.push(`updated_at = now()`);
    values.push(id);

    const query = `
      UPDATE user_subscriptions
      SET ${fields.join(', ')}
      WHERE id = $${idx}
      RETURNING *
    `;
    const result = await conn.query(query, values);
    return result.rows[0] || null;
  }

  async updatePeriod(conn, id, periodData) {
    const query = `
      UPDATE user_subscriptions
      SET status = $1,
          current_period_start = $2,
          current_period_end = $3,
          grace_period_end = NULL,
          updated_at = now()
      WHERE id = $4
      RETURNING *
    `;
    const result = await conn.query(query, [
      periodData.status,
      periodData.current_period_start,
      periodData.current_period_end,
      id,
    ]);
    return result.rows[0] || null;
  }

  async markCanceled(conn, id) {
    const query = `
      UPDATE user_subscriptions
      SET cancel_at_period_end = true,
          status = 'CANCELED',
          canceled_at = now(),
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `;
    const result = await conn.query(query, [id]);
    return result.rows[0] || null;
  }

  async reinstate(conn, id) {
    const query = `
      UPDATE user_subscriptions
      SET cancel_at_period_end = false,
          status = 'ACTIVE',
          canceled_at = NULL,
          cancel_reason = NULL,
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `;
    const result = await conn.query(query, [id]);
    return result.rows[0] || null;
  }

  async expire(conn, id) {
    const query = `
      UPDATE user_subscriptions
      SET status = 'EXPIRED',
          cancel_at_period_end = false,
          grace_period_end = NULL,
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `;
    const result = await conn.query(query, [id]);
    return result.rows[0] || null;
  }

  // ─── payment_receipt_logs ─────────────────────────────

  /**
   * 영수증 로그 삽입 (멱등성 게이트)
   * @returns {object|null} null이면 이미 처리된 트랜잭션
   */
  async insertReceiptLog(conn, data) {
    const query = `
      INSERT INTO payment_receipt_logs (
        user_id, subscription_id, transaction_id, original_transaction_id,
        store_type, event_type, raw_payload, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
      ON CONFLICT (transaction_id) DO NOTHING
      RETURNING id
    `;
    const result = await conn.query(query, [
      data.user_id, data.subscription_id, data.transaction_id,
      data.original_transaction_id, data.store_type, data.event_type,
      JSON.stringify(data.raw_payload),
    ]);
    return result.rows[0] || null;
  }

  async findByTransactionId(conn, transactionId) {
    const query = `
      SELECT * FROM payment_receipt_logs
      WHERE transaction_id = $1
    `;
    const result = await conn.query(query, [transactionId]);
    return result.rows[0] || null;
  }

  // ─── subscription_events ──────────────────────────────

  async insertSubscriptionEvent(conn, data) {
    const query = `
      INSERT INTO subscription_events (
        user_id, subscription_id, event_type, from_plan_id, to_plan_id, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, now())
      RETURNING *
    `;
    const result = await conn.query(query, [
      data.user_id, data.subscription_id, data.event_type,
      data.from_plan_id || null, data.to_plan_id || null,
      JSON.stringify(data.metadata || {}),
    ]);
    return result.rows[0];
  }

  async getEventsBySubscriptionId(conn, subscriptionId) {
    const query = `
      SELECT * FROM subscription_events
      WHERE subscription_id = $1
      ORDER BY created_at DESC
    `;
    const result = await conn.query(query, [subscriptionId]);
    return result.rows;
  }

  // ─── user_assets ──────────────────────────────────────

  async findAssetsByUserId(conn, userId) {
    const query = `
      SELECT user_id, asset_type, asset_id, purchased_at
      FROM user_assets
      WHERE user_id = $1
    `;
    const result = await conn.query(query, [userId]);
    return result.rows;
  }

  async insertAsset(conn, data) {
    const query = `
      INSERT INTO user_assets (user_id, asset_type, asset_id, purchased_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (user_id, asset_type, asset_id) DO NOTHING
      RETURNING *
    `;
    const result = await conn.query(query, [
      data.user_id, data.asset_type, data.asset_id,
    ]);
    return result.rows[0] || null;
  }

  async deleteAsset(conn, userId, assetType, assetId) {
    const query = `
      DELETE FROM user_assets
      WHERE user_id = $1 AND asset_type = $2 AND asset_id = $3
    `;
    await conn.query(query, [userId, assetType, assetId]);
  }

  // ─── 배치 쿼리 ───────────────────────────────────────

  async findExpiredGracePeriods(conn, now) {
    const query = `
      SELECT * FROM user_subscriptions
      WHERE status = 'PAST_DUE'
        AND grace_period_end IS NOT NULL
        AND grace_period_end < $1
    `;
    const result = await conn.query(query, [now]);
    return result.rows;
  }

  async findExpiredCanceledSubscriptions(conn, now) {
    const query = `
      SELECT * FROM user_subscriptions
      WHERE status = 'CANCELED'
        AND cancel_at_period_end = true
        AND current_period_end < $1
    `;
    const result = await conn.query(query, [now]);
    return result.rows;
  }
}

module.exports = { BillingDAO: new BillingDAOClass() };
