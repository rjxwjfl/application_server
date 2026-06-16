/**
 * src/configs/billing.js
 * =========================================
 * 빌링/구독 시스템 설정
 *
 * - 플랜 정의 (서버사이드 SOT)
 * - ProductID → 플랜 매핑
 * - 구독 상태 / 이벤트 타입 상수
 * - 유예기간 설정
 * =========================================
 */

const Plans = Object.freeze({
  FREE: {
    id: 0,
    name: 'FREE',
    maxDrawers: 3,
    maxMembersPerDrawer: 5,
    maxCalendars: 2,
    features: ['basic_messaging', 'basic_calendar', 'basic_tasks'],
  },
  PREMIUM: {
    id: 1,
    name: 'PREMIUM',
    maxDrawers: -1,
    maxMembersPerDrawer: -1,
    maxCalendars: -1,
    features: [
      'basic_messaging', 'basic_calendar', 'basic_tasks',
      'unlimited_drawers', 'unlimited_members', 'unlimited_calendars',
      'file_upload_extended', 'custom_themes', 'priority_support',
    ],
  },
});

/** Apple App Store / Google Play ProductID → 플랜 매핑 */
const ProductIdMap = Object.freeze({
  // Apple
  'com.app.premium.monthly': { plan: Plans.PREMIUM, cycle: 0 },
  'com.app.premium.yearly': { plan: Plans.PREMIUM, cycle: 1 },
  // Google
  'app_premium_monthly': { plan: Plans.PREMIUM, cycle: 0 },
  'app_premium_yearly': { plan: Plans.PREMIUM, cycle: 1 },
});

/** 구독 상태 */
const SubscriptionStatus = Object.freeze({
  ACTIVE: 'active',
  TRIAL: 'trial',
  PAST_DUE: 'past_due',
  CANCELED: 'canceled',
  EXPIRED: 'expired',
});

/** 구독 이벤트 타입 (subscription_events.event_type) */
const SubscriptionEventType = Object.freeze({
  SUBSCRIBED: 0,
  RENEWED: 1,
  CANCELED: 2,
  EXPIRED: 3,
  GRACE_START: 4,
  REINSTATED: 5,
  REFUNDED: 6,
  UPGRADED: 7,
  DOWNGRADED: 8,
  TRIAL_START: 9,
  TRIAL_CONVERTED: 10,
});

/** 스토어별 유예기간(일) */
const GracePeriodDays = Object.freeze({
  apple: 60,
  google: 30,
});

/** 결제 주기 */
const BillingCycle = Object.freeze({
  MONTHLY: 0,
  YEARLY: 1,
});

/** 스토어 구분 */
const StorePlatform = Object.freeze({
  APPLE: 'apple',
  GOOGLE: 'google',
});

module.exports = {
  Plans,
  ProductIdMap,
  SubscriptionStatus,
  SubscriptionEventType,
  GracePeriodDays,
  BillingCycle,
  StorePlatform,
};
