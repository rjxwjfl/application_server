/**
 * src/jobs/reminderJobs.js
 * =========================================
 * 리마인더 FCM 발송 배치
 *
 * - 매 1분: trigger_at <= now() && is_sent=false 인 reminders 처리
 * - FCM 발송 후 row hard delete (schema.md 2026-06-11)
 * =========================================
 */

const cron = require('node-cron');
const { ReminderDAO } = require('../daos/reminderDAO');
const { NotificationDAO } = require('../daos/notificationDAO');
const { sendMulticast } = require('../utils/fcm');
const pool = require('../../config/db');
const logger = require('../utils/logger');

// target_type 상수 (schema.md Section 10)
const TARGET_EVENT_INSTANCE = 0;
const TARGET_TASK_INSTANCE = 1;

function buildNotification(reminder) {
  const timeLabel = reminder.item_time
    ? new Date(reminder.item_time).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
    : '';

  if (reminder.target_type === TARGET_EVENT_INSTANCE) {
    return {
      title: `📅 ${reminder.summary}`,
      body: timeLabel ? `${timeLabel} 일정이 있습니다.` : '일정 시간이 되었습니다.',
    };
  }
  if (reminder.target_type === TARGET_TASK_INSTANCE) {
    return {
      title: `✅ ${reminder.summary}`,
      body: timeLabel ? `마감 ${timeLabel}` : '할 일 마감 시간이 되었습니다.',
    };
  }
  return { title: '알림', body: reminder.summary || '' };
}

async function processReminders() {
  try {
    const now = new Date();
    const reminders = await ReminderDAO.findPendingWithDetails(pool, now);
    if (reminders.length === 0) return;

    logger.info('Reminder batch: processing', { count: reminders.length });

    // 유저별로 묶어 토큰 조회를 최소화
    const userIds = [...new Set(reminders.map((r) => r.user_id))];
    const tokenRows = await NotificationDAO.getActiveTokensByUserIds(pool, userIds);

    // userId → tokens 맵
    const tokenMap = {};
    for (const row of tokenRows) {
      if (!tokenMap[row.user_id]) tokenMap[row.user_id] = [];
      if (row.device_token) tokenMap[row.user_id].push(row.device_token);
    }

    let sent = 0;
    let failed = 0;
    const staleTokensAll = [];

    for (const reminder of reminders) {
      const tokens = tokenMap[reminder.user_id] || [];

      if (tokens.length > 0) {
        try {
          const notification = buildNotification(reminder);
          const data = {
            reminder_id: reminder.id,
            target_type: String(reminder.target_type),
            target_id: reminder.target_id,
          };
          const result = await sendMulticast(tokens, notification, data);
          sent += result.successCount;
          if (result.staleTokens.length > 0) {
            staleTokensAll.push(...result.staleTokens);
          }
        } catch (err) {
          logger.error('Reminder FCM send failed', { reminderId: reminder.id, error: err.message });
          failed++;
        }
      }

      // 발송 성공 여부와 무관하게 hard delete (재발송 방지)
      await ReminderDAO.deleteById(pool, reminder.id);
    }

    // 만료된 토큰 비활성화
    if (staleTokensAll.length > 0) {
      await NotificationDAO.deactivateTokens(pool, staleTokensAll);
    }

    if (sent > 0 || failed > 0) {
      logger.info('Reminder batch done', { sent, failed, deleted: reminders.length });
    }
  } catch (err) {
    logger.error('Reminder batch failed', { error: err.message });
  }
}

function startReminderJobs() {
  // 매 1분 실행
  cron.schedule('* * * * *', processReminders);
  logger.info('Reminder jobs started (every 1 min)');
}

module.exports = { startReminderJobs, processReminders };
