/**
 * src/jobs/reminderJobs.js
 * =========================================
 * 리마인더 발송 배치 (RLY-20260806-032 — 2단계, SC-reminder.md §1·§2-A·§2-B·§5A).
 *
 * 매 1분(durable trigger 계약, system.md §10-13 — F-S7 외부 트리거 이관 전이라 저장소의 다른
 * job 4개와 동일 수준 node-cron으로 맞춘다. min-instances=0에서의 발화 보장은 F-S7이 별도로
 * 푼다 — 이 job은 그 계약을 앞당기지 않는다):
 *
 *   1. reminders에서 due & 미발송 행을 최대 500개 원자적으로 claim(FOR UPDATE SKIP LOCKED,
 *      lease 5분) — ReminderDAO.claimDueBatch.
 *   2. 대상 회차 INNER JOIN(효과상)으로 삭제된 항목을 걸러낸다 — ReminderDAO.findClaimedWithDetails.
 *   3. 각 행마다 수신자(접근권 × 수신 선호, §2-A)를 구하고 FCM 발송(500 토큰/배치).
 *   4. Event·Task는 sent_at 기록, SpecialDay는 다음 해로 롤링(sent_at 영구 NULL 유지).
 *   5. 실패는 지수 백오프로 재시도, 상한 도달 시 포기(sent_at으로 종결 — GC 대상에 들게 함).
 * =========================================
 */

const cron = require('node-cron');
const pool = require('../../config/db');
const { ReminderDAO } = require('../daos/reminderDAO');
const { NotificationDAO } = require('../daos/notificationDAO');
const fcm = require('../utils/fcm');
const { generateUUID } = require('../utils/uuid');
const { computeNextTriggerAt } = require('../utils/specialDayRolling');
const { TargetType, ActionType } = require('../utils/typeDefinitions');
const logger = require('../utils/logger');

const BATCH_LIMIT = 500; // system.md §10-13 "최대 500행"
const LEASE_MINUTES = 5; // schema.md §10-4 claim_token 주석 "만료(5분)"
// 무한 재시도 금지(지시) — 5회 상한. backoffMinutes(아래)가 1·2·4·8·16분 계단이라 최초 실패
// 이후 최대 약 31분 안에 재시도가 끝난다. 리마인더는 "정시성이 중요한 알림"이라 그 이상 계속
// 재시도해도 이미 늦은 알림이 될 뿐이고, claim 후보 목록에 영원히 남아 매 tick 헛돌기만 한다.
const MAX_ATTEMPTS = 5;
const FCM_TOKEN_CHUNK = 500; // FCM sendEachForMulticast 자체 한도(SC-reminder "500/배치"와 동일 수)

const REMINDER_TARGET_TYPE_STRING = {
  0: TargetType.EVENT_INSTANCE,
  1: TargetType.TASK_INSTANCE,
  2: TargetType.SPECIAL_DAY,
};

// attemptCount는 claimDueBatch가 claim 시점에 이미 +1 해 둔 값(1부터 시작)이므로
// 2^(attemptCount-1)분 계단, 16분 상한.
function backoffMinutes(attemptCount) {
  return Math.min(2 ** (attemptCount - 1), 16);
}

// "N분/시간/일/주 후" — 리마인더 피커 6종 프리셋(§4-1)과 같은 단위 축을 쓴다. 딱 떨어지지
// 않는 커스텀 초 값(예: 90분)은 분 단위로 대충 맞춘다 — 알림 문구는 근사만 필요하다.
function formatOffsetPhrase(offsetSeconds) {
  if (!offsetSeconds) return '지금';
  const units = [
    { sec: 604800, label: '주' },
    { sec: 86400, label: '일' },
    { sec: 3600, label: '시간' },
    { sec: 60, label: '분' },
  ];
  for (const u of units) {
    if (offsetSeconds % u.sec === 0) return `${offsetSeconds / u.sec}${u.label} 후`;
  }
  return `${Math.max(Math.round(offsetSeconds / 60), 1)}분 후`;
}

function buildNotification(reminder) {
  const phrase = formatOffsetPhrase(reminder.trigger_offset);
  const title = `🔔 ${reminder.summary || '알림'}`;
  // §4-4: event="N 후 시작", task="N 후 마감", special_day="N 후 기념일"(예시 문구 참조)
  const body = reminder.target_type === 1 ? `${phrase} 마감`
    : reminder.target_type === 2 ? `${phrase} 기념일`
      : `${phrase} 시작`;
  return { title, body };
}

// 발송 완료 처리 — Event·Task는 markSent, SpecialDay는 다음 해로 롤링.
//
// RLY-20260806-048 — computeNextTriggerAt(specialDayRolling.js)이 이제 "그 해에 없음"(양력
// 2/29 평년, 음력 윤달 없는 해)을 그냥 건너뛰고 존재하는 다음 해로 넘어간다 — 정상 경로에서 더는
// throw하지 않는다(이전엔 음력 쪽이 여기서 throw해 아래 재시도 경로를 타다 결국 포기했고, 그게
// 그 기념일 알림이 영구히 죽는 결함이었다 — throw 자체가 사라지므로 자연히 해소된다). 그래도
// 남는 throw(전진 상한 초과 등, 정상 데이터로는 도달 안 함)는 순수 계산 실패라 재시도해도 항상
// 같은 결과다 — 아래 retryOrGiveUp이 error.permanent를 보고 백오프 없이 바로 종결한다.
async function finalizeSuccess(reminder, claimToken) {
  if (reminder.target_type === 2) {
    const nextTriggerAt = computeNextTriggerAt({
      currentTriggerAt: reminder.trigger_at,
      triggerOffsetSeconds: reminder.trigger_offset,
      timezone: reminder.timezone,
      isLunar: reminder.special_day_is_lunar,
      lunarMonth: reminder.special_day_lunar_month,
      lunarDay: reminder.special_day_lunar_day,
      lunarIsLeapMonth: reminder.special_day_lunar_is_leap_month,
    });
    const applied = await ReminderDAO.rollSpecialDay(pool, reminder.id, nextTriggerAt, claimToken);
    if (!applied) {
      logger.warn('SpecialDay reminder roll skipped — claim stolen by another worker (stale lease)', { reminderId: reminder.id });
    }
    return;
  }
  const applied = await ReminderDAO.markSent(pool, reminder.id, claimToken);
  if (!applied) {
    logger.warn('Reminder markSent skipped — claim stolen by another worker (stale lease)', { reminderId: reminder.id });
  }
}

async function retryOrGiveUp(reminder, claimToken, error) {
  // error.permanent(specialDayRolling.js) — 순수 계산 실패는 재시도해도 항상 같은 결과라
  // 백오프 없이 바로 종결한다. 클래스·reason 분류 체계는 만들지 않는다(지시) — 속성 하나만 본다.
  if (error && error.permanent) {
    logger.error('Reminder dispatch giving up — deterministic failure, retry would not help', {
      reminderId: reminder.id, targetType: reminder.target_type, targetId: reminder.target_id,
      attemptCount: reminder.attempt_count, error: error.message,
    });
    await ReminderDAO.giveUp(pool, reminder.id, claimToken);
    return;
  }
  if (reminder.attempt_count >= MAX_ATTEMPTS) {
    logger.error('Reminder dispatch giving up after max attempts', {
      reminderId: reminder.id, targetType: reminder.target_type, targetId: reminder.target_id,
      attemptCount: reminder.attempt_count, error: error?.message,
    });
    await ReminderDAO.giveUp(pool, reminder.id, claimToken);
    return;
  }
  const nextAttemptAt = new Date(Date.now() + backoffMinutes(reminder.attempt_count) * 60 * 1000);
  logger.error('Reminder dispatch failed, will retry', {
    reminderId: reminder.id, attemptCount: reminder.attempt_count,
    nextAttemptAt: nextAttemptAt.toISOString(), error: error?.message,
  });
  await ReminderDAO.markFailed(pool, reminder.id, claimToken, nextAttemptAt);
}

// RLY-20260806-194 — sendAlert(190이 가시성/선호로 분리)와 달리 여기는 recipientIds
// 하나(ReminderDAO.getRecipients — 접근권 AND notification_level<=1)로 푸시·아래
// insertNotificationsBulk를 둘 다 처리한다. 190이 고친 "혼합"과 겉모습은 같지만 결함이
// 아니다 — SC-reminder.md §2-A-2(확정 2026-08-03, 결정 63)가 notification_level<=1을
// 리마인더 "수신자" 정의 자체에 포함시킨다(reminderDAO.js 상단 주석 참조). 조사해 확인,
// 고치지 않았다. tokens.length===0 조기 return도 없다 — 아래 insertNotificationsBulk는
// tokens가 아니라 recipientIds 기준이라 등록 기기가 없어도 그대로 진행된다(190의 ②에
// 해당하는 결함 자체가 여기엔 없음).
async function dispatchOne(reminder, claimToken) {
  try {
    const recipientIds = await ReminderDAO.getRecipients(pool, reminder.target_type, reminder.target_id);

    if (recipientIds.length > 0) {
      const devices = await NotificationDAO.getActiveTokensByUserIds(pool, recipientIds);
      const tokens = devices.map((d) => d.device_token);
      const { title, body } = buildNotification(reminder);
      const targetTypeString = REMINDER_TARGET_TYPE_STRING[reminder.target_type];
      const staleTokens = [];

      for (let i = 0; i < tokens.length; i += FCM_TOKEN_CHUNK) {
        const chunk = tokens.slice(i, i + FCM_TOKEN_CHUNK);
        // eslint-disable-next-line no-await-in-loop
        const result = await fcm.sendMulticast(chunk, { title, body }, {
          type: 'REMINDER',
          route_type: targetTypeString,
          route_id: reminder.target_id,
          reminder_id: reminder.id,
          timestamp: Date.now().toString(),
        });
        staleTokens.push(...result.staleTokens);
      }
      if (staleTokens.length > 0) {
        await NotificationDAO.deactivateTokens(pool, staleTokens);
      }

      // 알림함 통합(§4-5 "reminder도 도착하면 알림함에 표시") — notificationService.sendAlert와
      // 동일한 insertNotificationsBulk를 재사용한다. sender_id 없음(시스템 발화, 특정 발신자가
      // 없다 — sendAlert의 "sender_id 제외" 필터링과 달리 이 알림은 애초에 sender가 없다).
      const notifications = recipientIds.map((userId) => ({
        id: generateUUID(),
        recipient_id: userId,
        sender_id: null,
        notification_type: ActionType.CREATE,
        route_type: targetTypeString,
        route_id: reminder.target_id,
        binder_id: null,
        title,
        body,
        payload: { reminder_id: reminder.id },
      }));
      await NotificationDAO.insertNotificationsBulk(pool, notifications);
    }

    await finalizeSuccess(reminder, claimToken);
  } catch (err) {
    await retryOrGiveUp(reminder, claimToken, err);
  }
}

async function dispatchReminders() {
  const claimToken = generateUUID();
  try {
    const claimed = await ReminderDAO.claimDueBatch(pool, {
      claimToken, limit: BATCH_LIMIT, leaseMinutes: LEASE_MINUTES, maxAttempts: MAX_ATTEMPTS,
    });
    if (claimed.length === 0) return;

    const details = await ReminderDAO.findClaimedWithDetails(pool, claimed.map((r) => r.id));
    const detailIds = new Set(details.map((d) => d.id));

    // claim은 됐지만 대상 회차가 없는(=삭제됨) 행 — deleteCascadeHelpers.js(RLY-20260806-027)가
    // 정상 동작했다면 애초에 여기 도달할 reminders 행이 없어야 한다. 그래도 claim_token을 쥔 채
    // 방치하면 5분 lease가 끝날 때까지 재claim이 막히므로, 도달 시엔 즉시 종결한다.
    const orphaned = claimed.filter((r) => !detailIds.has(r.id));
    for (const orphan of orphaned) {
      logger.warn('Reminder target missing at dispatch time (deleted?) — closing without send', {
        reminderId: orphan.id, targetType: orphan.target_type, targetId: orphan.target_id,
      });
      // eslint-disable-next-line no-await-in-loop
      await ReminderDAO.giveUp(pool, orphan.id, claimToken);
    }

    logger.info('Reminder dispatch tick', { claimed: claimed.length, dispatched: details.length, orphaned: orphaned.length });

    for (const reminder of details) {
      // eslint-disable-next-line no-await-in-loop
      await dispatchOne(reminder, claimToken);
    }
  } catch (err) {
    logger.error('Reminder dispatch tick failed', { error: err.message });
  }
}

function startReminderJobs() {
  cron.schedule('* * * * *', dispatchReminders);
  logger.info('Reminder jobs scheduled (every 1 minute)');
}

module.exports = {
  startReminderJobs,
  dispatchReminders,
  dispatchOne,
  formatOffsetPhrase,
  backoffMinutes,
};
