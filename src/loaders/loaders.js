const expressLoader = require('./expressLoader');
const postgresLoader = require('./postgresLoader');
require('../events/notificationHandler');
require('../events/auditHandler');
require('../events/feedHandler');
require('../events/billingHandler');
const { startSubscriptionJobs } = require('../jobs/subscriptionJobs');
const { startMediaLifecycleJobs } = require('../jobs/mediaLifecycleJobs');
const { startHolidayJobs } = require('../jobs/holidayJobs');
const { startCleanupJobs } = require('../jobs/cleanupJobs');
const { startReminderJobs } = require('../jobs/reminderJobs');

async function loaders({ expressApp, config }) {
  // 1. DB 연결 초기화
  const pool = await postgresLoader({ dbConfig: config.DB });

  // 2. Express 설정 적용
  await expressLoader({ app: expressApp, config });

  // 3. 크론 작업 시작
  startSubscriptionJobs();
  startMediaLifecycleJobs();
  startHolidayJobs();
  startCleanupJobs();
  startReminderJobs();

  return { pool };
}

module.exports = loaders;