const { BillingService } = require('../../services/billingService');
const asyncHandler = require('../../core/asyncHandler');
const { BadRequestError } = require('../../core/errors');

const billingController = {
  getSubscriptionStatus: asyncHandler(async (req, res) => {
    const result = await BillingService.getSubscriptionStatus(req.user_id);
    res.json({ success: true, data: result });
  }),

  getEntitlements: asyncHandler(async (req, res) => {
    const result = await BillingService.getEntitlements(req.user_id);
    res.json({ success: true, data: result });
  }),

  verifyPurchase: asyncHandler(async (req, res) => {
    const subscription = await BillingService.verifyAndActivatePurchase(req.user_id, req.body);
    res.status(201).json({ success: true, data: subscription, message: '구독이 활성화되었습니다' });
  }),

  verifyAssetPurchase: asyncHandler(async (req, res) => {
    const result = await BillingService.verifyAndRecordAssetPurchase(req.user_id, req.body);
    res.status(201).json({ success: true, data: result });
  }),

  restorePurchases: asyncHandler(async (req, res) => {
    const { receipts } = req.body;
    if (!receipts || !Array.isArray(receipts)) {
      throw new BadRequestError('receipts 배열이 필요합니다');
    }
    const results = await BillingService.restorePurchases(req.user_id, receipts);
    res.json({ success: true, data: results });
  }),

  getSubscriptionHistory: asyncHandler(async (req, res) => {
    const result = await BillingService.getSubscriptionHistory(req.user_id);
    res.json({ success: true, data: result });
  }),

  cancelSubscription: asyncHandler(async (req, res) => {
    await BillingService.cancelSubscription(req.user_id);
    res.json({ success: true, message: '구독이 취소되었습니다' });
  }),

  getAssets: asyncHandler(async (req, res) => {
    const result = await BillingService.getAssets(req.user_id);
    res.json({ success: true, data: { assets: result } });
  }),
};

module.exports = billingController;
