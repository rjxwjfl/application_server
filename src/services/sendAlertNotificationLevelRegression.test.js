/**
 * src/services/sendAlertNotificationLevelRegression.test.js
 * =========================================
 * RLY-20260806-184 — `NotificationService.sendAlert`가 `target_user_ids`를 명시로 받는
 * 경로(멘션·반응·배정·강퇴 등)에서 `requiredLevel`(notification_level)을 전혀 안 봤다.
 * `SC-notifications.md` E7 "notification_level=none — 해당 binder의 모든 알림 차단"이
 * 명시하는데, 브로드캐스트 경로(`getMembersForAlert`, `target_user_ids` 미지정 시)만 SQL
 * WHERE절 자체에 필터가 있어 적용됐고 explicit-target 경로는 아예 필터를 안 탔다 —
 * 수신자가 그 binder 알림을 꺼도 멘션·반응 알림은 그대로 갔다.
 *
 * `NotificationDAO.filterUserIdsByNotificationLevel`을 추가해 explicit-target 경로에도
 * (binder_id가 있는 경우에만) 같은 기준을 적용했다. binder 스코프가 없는 알림(구독 등,
 * billingHandler.js)은 notification_level 개념 자체가 없어 그대로 둔다 — 회귀 ④가 확인.
 *
 * ⚠️ RLY-20260806-190 갱신 — "알림은 두 채널이다"(User 판정): notification_level은 기기
 * 푸시에만 적용하고, 인앱 알림센터 기록(notifications INSERT)은 항상 남는다. 이 회귀는
 * 원래 INSERT 대상을 기준으로 검사했지만(184 당시엔 두 채널이 분리되기 전이라 INSERT도
 * 함께 걸러지는 게 "수정"이었다), 190 이후엔 INSERT가 항상 전원에게 일어나는 게 맞는
 * 동작이라 검사 기준을 **푸시 대상**(`getActiveTokensByUserIds`에 실제로 넘어간 user_id,
 * `pendingApplicantFilterCoverageRegression.test.js` ⑬과 동일한 monkey-patch 캡처 방식)
 * 으로 옮겼다 — INSERT는 항상 전원이라는 것도 별도로 한 번 확인한다(sendAlertTwoChannelRegression.test.js
 * 가 이 채널 분리 자체의 전용 회귀다, 여기는 notification_level "값"이 맞게 적용되는지만
 * 본다).
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`. config/db·@utils/fcm을
 * 가짜로 교체(pendingApplicantFilterCoverageRegression.test.js와 동일 패턴 — fcm.js가
 * firebase.js를 통해 실 env를 요구해서 스텁 필요).
 *
 * 실행: node src/services/sendAlertNotificationLevelRegression.test.js
 */


process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test';
process.env.PGDATABASE = process.env.PGDATABASE || 'test';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test';

const dbPath = require.resolve('../../config/db');
const fcmPath = require.resolve('../utils/fcm');

require.cache[fcmPath] = {
  id: fcmPath, filename: fcmPath, loaded: true,
  exports: {
    sendToTopic: async () => 'stub',
    sendMulticast: async () => ({ successCount: 0, failureCount: 0, staleTokens: [] }),
    subscribeToTopic: async () => {},
    unsubscribeFromTopic: async () => {},
  },
};

// notification_level: 0=allActivity 1=relatedOnly 2=mentionOnly 3=none
const binderMembers = {
  'b1:allActivity1':  { user_id: 'allActivity1',  notification_level: 0 },
  'b1:relatedOnly1':  { user_id: 'relatedOnly1',  notification_level: 1 },
  'b1:mentionOnly1':  { user_id: 'mentionOnly1',  notification_level: 2 },
  'b1:none1':         { user_id: 'none1',         notification_level: 3 },
};
const allUserIds = ['allActivity1', 'relatedOnly1', 'mentionOnly1', 'none1'];
const devices = allUserIds.reduce((acc, id) => { acc[id] = `token-${id}`; return acc; }, {});

const insertedNotificationsLog = []; // 인앱 알림센터 — 항상 전원(190 이후의 기대 동작)
let pushRequestedUserIds = null; // 기기 푸시 — notification_level로 좁혀진 뒤의 후보(monkey-patch로 캡처)

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();

  // NotificationDAO.filterUserIdsByNotificationLevel (RLY-20260806-184 신규)
  if (s.startsWith('SELECT dm.user_id') && s.includes('FROM binder_members') && s.includes('notification_level <= $3')) {
    const [binderId, userIds, maxLevel] = params;
    const rows = userIds
      .map((uid) => binderMembers[`${binderId}:${uid}`])
      .filter((row) => row && row.notification_level <= maxLevel)
      .map((row) => ({ user_id: row.user_id }));
    return { rows };
  }
  // NotificationDAO.insertNotificationsBulk — id만 흉내(recipient_id를 확인 대상으로 삼는다)
  if (s.startsWith('INSERT INTO notifications')) {
    // params는 10개씩 반복: id, recipient_id, sender_id, notification_type, route_type, route_id, binder_id, title, body, payload
    for (let i = 0; i < params.length; i += 10) {
      insertedNotificationsLog.push(params[i + 1]); // recipient_id
    }
    return { rows: [] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { NotificationDAO } = require('../daos/notificationDAO');
const notificationService = require('./notificationService');

// pendingApplicantFilterCoverageRegression.test.js ⑬과 동일한 monkey-patch 캡처 —
// "누가 실제로 푸시 후보(토큰 조회)까지 도달했는가"가 이 파일의 진짜 관심사다. 이
// 파일은 단일 목적 스크립트라(원본 복원이 필요한 다른 테스트와 공유하지 않는다)
// 원본을 따로 저장해 두지 않는다.
NotificationDAO.getActiveTokensByUserIds = async (_conn, userIds) => {
  pushRequestedUserIds = userIds;
  return userIds.filter((uid) => devices[uid]).map((uid) => ({ user_id: uid, device_token: devices[uid], device_uuid: 'dev' }));
};

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond, detail) { if (cond) pass++; else { fail++; failures.push(detail ? `${desc}: ${detail}` : desc); } }

async function run() {
  // ============ ① requiredLevel:2(mentionOnly, 멘션과 동일) — 푸시는 allActivity·relatedOnly·mentionOnly만, 인앱 기록은 전원 ============
  insertedNotificationsLog.length = 0; pushRequestedUserIds = null;
  await notificationService.sendAlert({
    binder_id: 'b1', sender_id: 'sender1', type: 'mention', title: 't', body: 'b',
    target_user_ids: allUserIds, requiredLevel: 2, routeData: {},
  });
  check('① 인앱 기록 — 4명 전원(190: notification_level과 무관하게 항상 남는다)',
    allUserIds.every((id) => insertedNotificationsLog.includes(id)), `실제=${JSON.stringify(insertedNotificationsLog)}`);
  check('① 푸시 — allActivity(0)는 받는다', pushRequestedUserIds && pushRequestedUserIds.includes('allActivity1'));
  check('① 푸시 — relatedOnly(1)는 받는다', pushRequestedUserIds && pushRequestedUserIds.includes('relatedOnly1'));
  check('① 푸시 — mentionOnly(2)는 받는다(경계 포함, <=)', pushRequestedUserIds && pushRequestedUserIds.includes('mentionOnly1'));
  check('① 푸시 — none(3)은 못 받는다(E7 "모든 알림 차단")', pushRequestedUserIds && !pushRequestedUserIds.includes('none1'),
    `실제=${JSON.stringify(pushRequestedUserIds)}`);

  // ============ ② requiredLevel:1(relatedOnly, 반응과 동일) — 푸시는 allActivity·relatedOnly만, 인앱 기록은 전원 ============
  insertedNotificationsLog.length = 0; pushRequestedUserIds = null;
  await notificationService.sendAlert({
    binder_id: 'b1', sender_id: 'sender1', type: 'reaction', title: 't', body: 'b',
    target_user_ids: allUserIds, requiredLevel: 1, routeData: {},
  });
  check('② 인앱 기록 — 4명 전원', allUserIds.every((id) => insertedNotificationsLog.includes(id)));
  check('② 푸시 — allActivity(0)는 받는다', pushRequestedUserIds.includes('allActivity1'));
  check('② 푸시 — relatedOnly(1)는 받는다(경계 포함)', pushRequestedUserIds.includes('relatedOnly1'));
  check('② 푸시 — mentionOnly(2)는 못 받는다(수정 전엔 여기서도 갔다 — 결함의 핵심)',
    !pushRequestedUserIds.includes('mentionOnly1'), `실제=${JSON.stringify(pushRequestedUserIds)}`);
  check('② 푸시 — none(3)은 못 받는다', !pushRequestedUserIds.includes('none1'));

  // ============ ③ requiredLevel:0(allActivity만) — notification_level=none인 사람은 푸시는 못 받아도 인앱 기록은 남는다(190 핵심) ============
  insertedNotificationsLog.length = 0; pushRequestedUserIds = null;
  await notificationService.sendAlert({
    binder_id: 'b1', sender_id: 'sender1', type: 'assignment', title: 't', body: 'b',
    target_user_ids: ['none1'], requiredLevel: 0, routeData: {},
  });
  check('③ 인앱 기록 — notification_level=none(3)이어도 남는다(190 — "모든 상황에")',
    insertedNotificationsLog.includes('none1'), `실제=${JSON.stringify(insertedNotificationsLog)}`);
  check('③ 푸시 — notification_level=none(3)인 사람은 못 받는다(선호는 여전히 푸시엔 적용)',
    pushRequestedUserIds === null || !pushRequestedUserIds.includes('none1'));

  // ============ ④ binder_id가 없으면(구독 알림 등 user 단위) 필터를 아예 안 탄다 — 인앱·푸시 둘 다 ============
  insertedNotificationsLog.length = 0; pushRequestedUserIds = null;
  await notificationService.sendAlert({
    sender_id: 'system1', type: 'subscription', title: 't', body: 'b',
    target_user_ids: ['none1'], routeData: {},
    // binder_id 없음 — none1은 notification_level=3(binder b1 기준)이지만, 이 알림은
    // binder 스코프가 아예 없어(구독은 user 단위) 그 값이 적용될 대상 자체가 아니다.
  });
  check('④ 인앱 기록 — binder_id 없는 알림(구독 등)도 남는다', insertedNotificationsLog.includes('none1'));
  check('④ 푸시 — binder_id 없는 알림(구독 등)은 notification_level과 무관하게 나간다',
    pushRequestedUserIds && pushRequestedUserIds.includes('none1'), `실제=${JSON.stringify(pushRequestedUserIds)}`);

  console.log(`\n[sendAlertNotificationLevelRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[sendAlertNotificationLevelRegression] 실행 실패:', error);
  process.exitCode = 1;
});
