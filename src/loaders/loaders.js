const expressLoader = require('./expressLoader');
const postgresLoader = require('./postgresLoader');
require('../events/notificationHandler');
require('../events/auditHandler');
require('../events/feedHandler');
require('../events/billingHandler');
const { startSubscriptionJobs } = require('../jobs/subscriptionJobs');
const { startMediaLifecycleJobs } = require('../jobs/mediaLifecycleJobs');
const { startHolidayJobs } = require('../jobs/holidayJobs');
const { startPartitionJobs } = require('../jobs/partitionJobs');
const { startCleanupJobs } = require('../jobs/cleanupJobs');
const { startReminderJobs } = require('../jobs/reminderJobs');
const { startMediaWorkerJobs } = require('../jobs/mediaWorkerJobs');

async function loaders({ expressApp, config }) {
  // 1. DB 연결 초기화
  const pool = await postgresLoader({ dbConfig: config.DB });

  // 2. Express 설정 적용
  await expressLoader({ app: expressApp, config });

  // 3. 크론 작업 시작
  startSubscriptionJobs();
  startMediaLifecycleJobs();
  startHolidayJobs();
  // RLY-20260806-175 — cleanupJobs보다 먼저 둔다: 파티션이 없으면 다른 job들의 INSERT가
  // 막힐 수 있어 확보가 정리보다 우선이다(순서상 의미는 없다 — 둘 다 독립적으로 fire-and-
  // forget이지만 읽는 사람이 우선순위를 알 수 있게 배치했다).
  startPartitionJobs();
  startCleanupJobs();
  startReminderJobs();
  startMediaWorkerJobs(); // RLY-20260806-047 — media.md §4-4 Worker 파이프라인(node-cron 폴링).

  return { pool };
}

module.exports = loaders;