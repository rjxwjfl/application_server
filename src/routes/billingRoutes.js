const express = require('express');
const router = express.Router();
const billingController = require('../api/billing/billingController');

// 구독 상태 조회 (설계: GET /billing/status)
router.get('/status', billingController.getSubscriptionStatus);

// 보유 자산 목록
router.get('/assets', billingController.getAssets);

// 구독 이력 조회
router.get('/history', billingController.getSubscriptionHistory);

// 구매 검증 및 활성화 (설계: POST /billing/verify-purchase)
router.post('/verify-purchase', billingController.verifyPurchase);

// 일회성 자산 구매 검증 (설계: POST /billing/verify-asset-purchase)
router.post('/verify-asset-purchase', billingController.verifyAssetPurchase);

// 구매 복원
router.post('/restore', billingController.restorePurchases);

// 구독 취소
router.delete('/subscription', billingController.cancelSubscription);

// 기능 접근 권한 조회 (미설계, 내부 유지)
router.get('/entitlements', billingController.getEntitlements);

module.exports = router;
