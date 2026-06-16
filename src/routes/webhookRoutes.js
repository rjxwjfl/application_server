/**
 * src/routes/webhookRoutes.js
 * =========================================
 * 외부 웹훅 라우트 (Firebase Auth 미적용, 자체 검증)
 * =========================================
 */

const express = require('express');
const router = express.Router();
const { verifyAppleWebhook, verifyGoogleWebhook } = require('../middleware/webhookAuthMiddleware');
const webhookController = require('../api/billing/webhookController');

// Apple App Store S2S V2
router.post('/apple', verifyAppleWebhook, webhookController.appleWebhook);

// Google Play RTDN (Pub/Sub)
router.post('/google', verifyGoogleWebhook, webhookController.googleWebhook);

module.exports = router;
