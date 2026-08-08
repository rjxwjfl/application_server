/**
 * src/services/sendAlertTwoChannelRegression.test.js
 * =========================================
 * RLY-20260806-190 — User 판정: 알림은 두 채널이다.
 *   · 기기 푸시(FCM)          — notification_level(선호)을 따른다. "안 받음"이면 안 간다.
 *   · 인앱 알림센터(notifications 행) — 항상 남는다. 모든 상황에.
 * 가시성(볼 수 없는 섹션인가)과 선호(notification_level)는 다른 축이다 — 가시성은 두
 * 채널 모두에 적용하고, 선호는 푸시에만 적용한다.
 *
 * 수정 전(190 이전)엔 `sendAlert`가 하나의 `userIds` 목록으로 푸시와 인앱 INSERT를 모두
 * 처리했다 — `filterUserIdsByNotificationLevel`(184가 추가)이 인앱 기록까지 지웠고,
 * `if (tokens.length === 0) return;`이 INSERT 앞에 있어 등록 기기가 없으면 인앱 기록
 * 자체가 안 생겼다. 아래 revert-verify 실측(구현 보고서 참조)이 "지금은 셋 다 인앱 기록이
 * 안 생긴다"를 실제로 재현했다.
 *
 * ⚠️ RLY-20260806-194 갱신 — 190에서 강퇴의 `requiredLevel`을 3(Writer 판단)으로 잡았으나,
 * User 판정 "나에게 직접 일어난 일은 나와 관련된 것만까지"에 따라 **1**(relatedOnly까지
 * 푸시)로 정정했다. ④·⑥이 이 정정을 4등급 전수로 검증한다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`. config/db·@utils/fcm을
 * 가짜로 교체(pendingApplicantFilterCoverageRegression.test.js와 동일 패턴).
 *
 * 실행: node src/services/sendAlertTwoChannelRegression.test.js
 */


process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test';
process.env.PGDATABASE = process.env.PGDATABASE || 'test';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test';

const dbPath = require.resolve('../../config/db');
const fcmPath = require.resolve('../utils/fcm');

let fcmSendMulticastCalls = 0;
require.cache[fcmPath] = {
  id: fcmPath, filename: fcmPath, loaded: true,
  exports: {
    sendToTopic: async () => 'stub',
    sendMulticast: async () => { fcmSendMulticastCalls++; return { successCount: 0, failureCount: 0, staleTokens: [] }; },
    subscribeToTopic: async () => {},
    unsubscribeFromTopic: async () => {},
  },
};

// notification_level: 0=allActivity 1=relatedOnly 2=mentionOnly 3=none
const binderMembers = {
  'b1:none1':      { user_id: 'none1',      notification_level: 3 },
  'b1:noDevice1':  { user_id: 'noDevice1',  notification_level: 0 },
  // RLY-20260806-194 — 강퇴 4등급 전수(User 판정: "나에게 직접 일어난 일"은 "나와 관련된
  // 것만"까지 — allActivity·relatedOnly는 푸시, mentionOnly·none은 푸시 없음).
  'b1:kickAllActivity1': { user_id: 'kickAllActivity1', notification_level: 0 },
  'b1:kickRelatedOnly1': { user_id: 'kickRelatedOnly1', notification_level: 1 },
  'b1:kickMentionOnly1': { user_id: 'kickMentionOnly1', notification_level: 2 },
  'b1:kickNone1':        { user_id: 'kickNone1',        notification_level: 3 },
  'b1:bcastAll1':  { user_id: 'bcastAll1',  notification_level: 0 },
  'b1:bcastNone1': { user_id: 'bcastNone1', notification_level: 3 },
};
const allActiveMembersOfB1 = ['none1', 'noDevice1', 'kickAllActivity1', 'kickRelatedOnly1', 'kickMentionOnly1', 'kickNone1', 'bcastAll1', 'bcastNone1'];
const devices = {
  none1: 'tok-none1',
  kickAllActivity1: 'tok-kickAllActivity1', kickRelatedOnly1: 'tok-kickRelatedOnly1',
  kickMentionOnly1: 'tok-kickMentionOnly1', kickNone1: 'tok-kickNone1',
  bcastAll1: 'tok-bcastAll1', bcastNone1: 'tok-bcastNone1',
};
// noDevice1은 의도적으로 devices에 없음 — 등록된 기기 0대 시나리오.

// 비공개 섹션(access_scope=1) — outsider1은 이 섹션의 section_members가 아니다(볼 수 없음).
const sections = { secPriv: { access_scope: 1 } };
const sectionMembersOfSecPriv = new Set(['none1']); // none1만 이 비공개 섹션 멤버.

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();

  // NotificationDAO.getActiveMemberIds (브로드캐스트 — 가시성만)
  if (s.startsWith('SELECT dm.user_id') && s.includes('FROM binder_members') && !s.includes('notification_level')) {
    return { rows: allActiveMembersOfB1.map((uid) => ({ user_id: uid })) };
  }
  // NotificationDAO.filterUserIdsByNotificationLevel (선호 — 푸시 전용)
  if (s.startsWith('SELECT dm.user_id') && s.includes('FROM binder_members') && s.includes('notification_level <= $3')) {
    const [, userIds, maxLevel] = params;
    const rows = userIds
      .map((uid) => binderMembers[`b1:${uid}`])
      .filter((row) => row && row.notification_level <= maxLevel)
      .map((row) => ({ user_id: row.user_id }));
    return { rows };
  }
  // sendAlert의 SECTION_MESSAGE 가시성 좁히기
  if (s.startsWith('SELECT bm.user_id FROM section_messages')) {
    const [routeId, userIds] = params;
    const sec = sections[routeId];
    if (!sec) return { rows: [] };
    const rows = userIds
      .filter((uid) => sec.access_scope === 0 || sectionMembersOfSecPriv.has(uid))
      .map((uid) => ({ user_id: uid }));
    return { rows };
  }
  // NotificationDAO.insertNotificationsBulk
  if (s.startsWith('INSERT INTO notifications')) {
    for (let i = 0; i < params.length; i += 10) insertedNotificationsLog.push(params[i + 1]);
    return { rows: [] };
  }
  // NotificationDAO.getActiveTokensByUserId(단수) — notificationHandler.js의 member:left가
  // 부수적으로 부르는 unsubscribeUserFromBinder용. 이 회귀의 관심사가 아니라 빈 배열로 흉내.
  if (s.startsWith('SELECT device_token, device_uuid') && s.includes('FROM user_devices')) {
    return { rows: [] };
  }
  // NotificationDAO.getActiveTokensByUserIds
  if (s.startsWith('SELECT user_id, device_token, device_uuid') && s.includes('FROM user_devices')) {
    const [userIds] = params;
    pushRequestedUserIds = userIds;
    const rows = userIds.filter((uid) => devices[uid]).map((uid) => ({ user_id: uid, device_token: devices[uid], device_uuid: 'dev' }));
    return { rows };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const insertedNotificationsLog = [];
let pushRequestedUserIds = null;

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const notificationService = require('./notificationService');

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond, detail) { if (cond) pass++; else { fail++; failures.push(detail ? `${desc}: ${detail}` : desc); } }

function reset() { insertedNotificationsLog.length = 0; pushRequestedUserIds = null; fcmSendMulticastCalls = 0; }

async function run() {
  // ============ ① "안 받음"(notification_level=none) 사람 — 푸시 0건, 인앱 기록 1건(핵심) ============
  reset();
  await notificationService.sendAlert({
    binder_id: 'b1', sender_id: 'sender1', type: 'reaction', title: 't', body: 'b',
    target_user_ids: ['none1'], requiredLevel: 1, routeData: {},
  });
  check('① 인앱 기록 1건(notification_level=none이어도 남는다)', insertedNotificationsLog.length === 1 && insertedNotificationsLog[0] === 'none1',
    `실제=${JSON.stringify(insertedNotificationsLog)}`);
  check('① 푸시 0건(FCM sendMulticast 자체가 호출 안 됨)', fcmSendMulticastCalls === 0);

  // ============ ② 등록 기기 0대인 사람 — 푸시 0건, 인앱 기록 1건 ============
  reset();
  await notificationService.sendAlert({
    binder_id: 'b1', sender_id: 'sender1', type: 'reaction', title: 't', body: 'b',
    target_user_ids: ['noDevice1'], requiredLevel: 1, routeData: {},
  });
  check('② 인앱 기록 1건(등록 기기가 없어도 남는다)', insertedNotificationsLog.length === 1 && insertedNotificationsLog[0] === 'noDevice1',
    `실제=${JSON.stringify(insertedNotificationsLog)}`);
  check('② 푸시 0건(토큰이 없어 FCM 호출까지 못 감)', fcmSendMulticastCalls === 0);
  check('② notification_level 필터는 통과했다(푸시 후보엔 들어갔었다 — 토큰이 없어서 못 간 것뿐)',
    pushRequestedUserIds && pushRequestedUserIds.includes('noDevice1'));

  // ============ ③ 볼 수 없는 섹션(비공개, 멤버 아님) — 푸시 0건, 인앱 기록 0건(가시성) ============
  reset();
  await notificationService.sendAlert({
    binder_id: 'b1', sender_id: 'sender1', type: 'mention', title: 't', body: 'b',
    target_user_ids: ['outsider-not-a-member'], requiredLevel: 2,
    routeData: { route_type: 'SECTION_MESSAGE', route_id: 'secPriv' },
  });
  check('③ 인앱 기록 0건(가시성 자체가 없어 애초에 알림이 성립하지 않는다)', insertedNotificationsLog.length === 0,
    `실제=${JSON.stringify(insertedNotificationsLog)}`);
  check('③ 푸시 0건', fcmSendMulticastCalls === 0);

  // ============ ④ 강퇴(member_kicked, requiredLevel:1) — 4등급 전수(핵심, User 판정 정정) ============
  // "나에게 직접 일어난 일"은 "나와 관련된 것만"까지 — allActivity·relatedOnly는 푸시를
  // 받고, mentionOnly·none은 안 받는다. 알림함(인앱) 기록은 190에 따라 네 등급 전부 남는다.
  reset();
  await notificationService.sendAlert({
    binder_id: 'b1', sender_id: 'kicker1', type: 'member_kicked', title: 't', body: 'b',
    target_user_ids: ['kickAllActivity1', 'kickRelatedOnly1', 'kickMentionOnly1', 'kickNone1'],
    requiredLevel: 1, routeData: {},
  });
  check('④ 알림함(인앱) 기록 — 네 등급 전부 남는다', ['kickAllActivity1', 'kickRelatedOnly1', 'kickMentionOnly1', 'kickNone1']
    .every((id) => insertedNotificationsLog.includes(id)), `실제=${JSON.stringify(insertedNotificationsLog)}`);
  check('④ 푸시 — allActivity(0)는 받는다', pushRequestedUserIds && pushRequestedUserIds.includes('kickAllActivity1'));
  check('④ 푸시 — relatedOnly(1)는 받는다(경계 포함, "나와 관련된 것"의 마지노선)',
    pushRequestedUserIds && pushRequestedUserIds.includes('kickRelatedOnly1'));
  check('④ 푸시 — mentionOnly(2)는 받지 않는다(수정 대상이었던 지점)',
    pushRequestedUserIds && !pushRequestedUserIds.includes('kickMentionOnly1'), `실제=${JSON.stringify(pushRequestedUserIds)}`);
  check('④ 푸시 — none(3)은 받지 않는다',
    pushRequestedUserIds && !pushRequestedUserIds.includes('kickNone1'));
  check('④ FCM이 실제로 호출됐다(allActivity·relatedOnly 최소 1명은 토큰이 있으므로)', fcmSendMulticastCalls === 1);

  // ============ ⑤ 브로드캐스트 분기(target_user_ids 미지정)도 동일하게 두 채널이 갈린다 ============
  reset();
  await notificationService.sendAlert({
    binder_id: 'b1', sender_id: 'someone-not-a-member', type: 'member_joined', title: 't', body: 'b',
    routeData: {},
    // requiredLevel 미지정 → 기본값 0(allActivity) — member_joined는 원래도 requiredLevel을 안 넘긴다(손대지 않음).
  });
  check('⑤ 브로드캐스트 — 인앱 기록은 notification_level과 무관하게 활성 멤버 전원(5명)에게 남는다',
    allActiveMembersOfB1.every((id) => insertedNotificationsLog.includes(id)) && insertedNotificationsLog.length === allActiveMembersOfB1.length,
    `실제=${JSON.stringify(insertedNotificationsLog)}`);
  check('⑤ 브로드캐스트 — 푸시는 notification_level<=0(allActivity)인 사람만(bcastAll1)',
    pushRequestedUserIds && pushRequestedUserIds.includes('bcastAll1') && !pushRequestedUserIds.includes('bcastNone1'),
    `실제=${JSON.stringify(pushRequestedUserIds)}`);

  // ============ ⑥ notificationHandler.js가 실제로 requiredLevel:1을 강퇴 emit에 싣는지(구조 확인) ============
  // ④는 sendAlert를 직접 호출해 requiredLevel:1 자체의 효과만 검증했다 — notificationHandler.js가
  // 진짜 그 값을 넘기는지는 별도로 확인해야 한다(eventBus를 통해 실제로 타는 경로).
  reset();
  const eventBus = require('../events/eventBus');
  const { ActionType } = require('../utils/typeDefinitions');
  require('../events/notificationHandler'); // 리스너 등록(require.cache로 1회만 실행됨)
  let capturedAlertPayload = null;
  const originalSendAlert = notificationService.sendAlert.bind(notificationService);
  notificationService.sendAlert = async (payload) => { capturedAlertPayload = payload; return originalSendAlert(payload); };
  eventBus.emit('member:left', { user_id: 'kickRelatedOnly1', binder_id: 'b1', actor_id: 'kicker1', action: ActionType.KICK });
  await new Promise((resolve) => setImmediate(resolve)); // sendAlert는 emit 핸들러 안에서 fire-and-forget으로 호출됨
  notificationService.sendAlert = originalSendAlert;
  check('⑥ notificationHandler.js의 강퇴 알림이 requiredLevel:1을 실제로 싣는다(194 정정)',
    capturedAlertPayload && capturedAlertPayload.type === 'member_kicked' && capturedAlertPayload.requiredLevel === 1,
    `실제=${JSON.stringify(capturedAlertPayload)}`);

  console.log(`\n[sendAlertTwoChannelRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[sendAlertTwoChannelRegression] 실행 실패:', error);
  process.exitCode = 1;
});
