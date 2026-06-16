/**
 * src/api/billing/webhookController.js
 * =========================================
 * Apple / Google 웹훅 컨트롤러
 *
 * 처리 불가 웹훅 → 200 반환 (재시도 방지)
 * DB 장애 → 500 반환 (Apple/Google 자동 재시도)
 * =========================================
 */

const { WebhookService } = require('../../services/webhookService');
const logger = require('../../utils/logger');

const webhookController = {
  appleWebhook: async (req, res) => {
    try {
      await WebhookService.handleAppleNotification(req.applePayload);
      res.status(200).json({ success: true });
    } catch (error) {
      logger.error('Apple webhook processing error', { error: error.message, stack: error.stack });
      res.status(500).json({ error: 'Internal server error' });
    }
  },

  googleWebhook: async (req, res) => {
    try {
      await WebhookService.handleGoogleNotification(req.googlePayload);
      res.status(200).json({ success: true });
    } catch (error) {
      logger.error('Google webhook processing error', { error: error.message, stack: error.stack });
      res.status(500).json({ error: 'Internal server error' });
    }
  },
};

module.exports = webhookController;
