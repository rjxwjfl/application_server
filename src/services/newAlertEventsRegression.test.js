/**
 * src/services/newAlertEventsRegression.test.js
 * =========================================
 * RLY-20260806-203 (T-N1~T-N4) — SC-notifications.md §16-2-A·§16-2-B(User 판정 2026-08-07)로
 * 확정된 신규 알림 3종의 배선 회귀:
 *
 *   T-N1 새 게시글           — postService.create가 바인더 멤버 전원에게 브로드캐스트,
 *                              requiredLevel: 0 ("모든 활동"에게만 — 가장 좁은 등급)
 *   T-N2 역할 변경           — binderService.updateBinderMemberRole이 당사자 1명에게,
 *                              requiredLevel: 1 (§16-2-C "나에게 직접 일어난 일")
 *   T-N3 탈퇴(잔여 멤버 통지) — notificationHandler.js의 member:left 핸들러가 자진 탈퇴
 *                              (action !== KICK)일 때도 잔여 멤버에게 브로드캐스트.
 *                              member_joined와 같은 사건의 짝이라 requiredLevel을 명시하지
 *                              않는다(= 기본값 0, member_joined와 동일 관례)
 *   T-N4 강퇴 정정 확인       — RLY-20260806-194가 이미 requiredLevel:1로 고쳤다(이 파일은
 *                              수정하지 않았음을 구조로 재확인만 한다 — sendAlertTwoChannelRegression
 *                              .test.js ⑥이 이미 값 자체를 전수 검증한다. 여기서는 중복 없이
 *                              "이번 변경이 그 분기를 건드리지 않았다"만 추가로 확인)
 *
 * 수정 전(203 이전)엔: postService.create·binderService.updateBinderMemberRole이 'sync'만
 * emit하고 'alert'를 전혀 내보내지 않았고(①·②), notificationHandler.js의 member:left
 * 핸들러는 action===KICK 분기만 있고 자진 탈�퇴(else) 분기 자체가 없었다(③) — 잔여 멤버는
 * 아무 알림도 받지 못했다. 아래 revert-verify 실측(구현 보고서 참조)이 이를 재현했다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`. config/db를 가짜로 교체하고
 * (emitBinderIdRegression.test.js와 동일 패턴), 실제 서비스 메서드를 구동해 eventBus가
 * 실제로 무엇을 emit하는지 캡처한다 — sendAlert 내부 필터링 로직 자체는
 * sendAlertTwoChannelRegression.test.js·sendAlertNotificationLevelRegression.test.js가 이미
 * 전담 검증하므로 여기서는 "배선"(누가·어떤 값으로 emit하는가)만 검증한다.
 *
 * 실행: node src/services/newAlertEventsRegression.test.js
 */

process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test';
process.env.PGDATABASE = process.env.PGDATABASE || 'test';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test';

const dbPath = require.resolve('../../config/db');
const fcmPath = require.resolve('../utils/fcm');

// notificationHandler.js는 'alert' 제네릭 리스너도 등록하므로(T-N1·T-N2 emit도 실제
// sendAlert까지 흘러간다) fcm·NotificationDAO 조회를 흉내내 부수 호출이 에러 로그 없이
// 조용히 끝나게 한다 — 이 파일의 관심사는 emit 배선이지 sendAlert 내부 로직이 아니다
// (그건 sendAlertTwoChannelRegression.test.js 전담).
require.cache[fcmPath] = {
  id: fcmPath, filename: fcmPath, loaded: true,
  exports: {
    sendToTopic: async () => 'stub',
    sendMulticast: async () => ({ successCount: 0, failureCount: 0, staleTokens: [] }),
    subscribeToTopic: async () => {},
    unsubscribeFromTopic: async () => {},
  },
};

const NOW = new Date().toISOString();

// ── 픽스처: b1 바인더 — owner1(master,0)·manager1(manager,1)·target1(member,3,역할변경 대상)·
// leaver1(member,3,자진 탈퇴자) ─────────────────────────────────────────────
const binderMembers = {
  'b1:owner1':   { binder_id: 'b1', user_id: 'owner1',   role: 0, notification_level: 0, deleted_at: null },
  'b1:manager1': { binder_id: 'b1', user_id: 'manager1', role: 1, notification_level: 0, deleted_at: null },
  'b1:target1':  { binder_id: 'b1', user_id: 'target1',  role: 3, notification_level: 0, deleted_at: null },
  'b1:leaver1':  { binder_id: 'b1', user_id: 'leaver1',  role: 3, notification_level: 0, deleted_at: null },
};

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();

  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // BinderDAO.getMember (postService.create의 멤버 확인 · leaveBinder의 본인 확인)
  if (s.startsWith('SELECT binder_id, user_id, role, notification_level')) {
    const row = binderMembers[`${params[0]}:${params[1]}`];
    return { rows: row ? [row] : [] };
  }
  // BinderDAO.getMembersForUpdate (updateBinderMemberRole의 requester·target 원자 재조회)
  if (s.startsWith('SELECT binder_id, user_id, role, deleted_at')) {
    const [binderId, userIds] = params;
    const rows = userIds.map((uid) => binderMembers[`${binderId}:${uid}`]).filter(Boolean);
    return { rows };
  }
  // BinderDAO.updateMemberRole
  if (s.startsWith('UPDATE binder_members SET role')) {
    const [role, binderId, userId] = params;
    const row = binderMembers[`${binderId}:${userId}`];
    if (row) row.role = role;
    return { rows: row ? [{ binder_id: binderId, user_id: userId, role }] : [] };
  }
  // BinderDAO.removeMember — 3개 UPDATE
  if (s.startsWith('UPDATE binder_members SET deleted_at')) {
    const [binderId, userId] = params;
    const row = binderMembers[`${binderId}:${userId}`];
    if (row) row.deleted_at = NOW;
    return { rows: [] };
  }
  if (s.startsWith('UPDATE group_members')) return { rows: [] };
  if (s.startsWith('UPDATE section_members')) return { rows: [] };
  // SectionDAO.softDeleteEmptyPrivateSections (removeMember가 마지막에 호출)
  if (s.startsWith('SELECT s.id FROM sections')) return { rows: [] };
  // BinderDAO.decrementMemberCount
  if (s.startsWith('UPDATE binders SET member_count')) return { rows: [] };
  // PostDAO.create
  if (s.startsWith('INSERT INTO posts')) {
    const [id, binder_id, author_id, , , title, body_markdown] = params;
    return { rows: [{ id, binder_id, author_id, title, body_markdown, created_at: NOW, updated_at: NOW }] };
  }
  // AttachmentDAO.findByContext (postService.withAttachments)
  if (s.startsWith('SELECT * FROM attachments')) return { rows: [] };

  // ── 아래는 notificationHandler.js의 제네릭 'alert'/'member:left' 리스너가 실제로 도는
  // 부수 경로(이 파일의 검증 대상은 아니다 — sendAlert 내부는 sendAlertTwoChannelRegression
  // .test.js 전담) — 에러 로그 없이 조용히 지나가게만 한다.
  // NotificationDAO.getActiveMemberIds (브로드캐스트 가시성)
  if (s.startsWith('SELECT dm.user_id') && s.includes('FROM binder_members') && !s.includes('notification_level')) {
    const [binderId] = params;
    const rows = Object.values(binderMembers).filter((m) => m.binder_id === binderId && !m.deleted_at).map((m) => ({ user_id: m.user_id }));
    return { rows };
  }
  // NotificationDAO.filterUserIdsByNotificationLevel (선호 — 푸시 전용)
  if (s.startsWith('SELECT dm.user_id') && s.includes('FROM binder_members') && s.includes('notification_level <= $3')) {
    const [binderId, userIds, maxLevel] = params;
    const rows = userIds.map((uid) => binderMembers[`${binderId}:${uid}`]).filter((row) => row && row.notification_level <= maxLevel).map((row) => ({ user_id: row.user_id }));
    return { rows };
  }
  // NotificationDAO.insertNotificationsBulk
  if (s.startsWith('INSERT INTO notifications')) return { rows: [] };
  // NotificationDAO.getActiveTokensByUserIds(복수)·getActiveTokensByUserId(단수) — 기기 0대로 흉내(FCM 미호출)
  if (s.startsWith('SELECT user_id, device_token, device_uuid') && s.includes('FROM user_devices')) return { rows: [] };
  if (s.startsWith('SELECT device_token, device_uuid') && s.includes('FROM user_devices')) return { rows: [] };

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { BinderService } = require('./binderService');
const { PostService } = require('./postService');
const { TargetType, ActionType } = require('../utils/typeDefinitions');
const eventBus = require('../events/eventBus');
require('../events/notificationHandler'); // member:left 리스너 등록 — T-N3는 핸들러 내부 로직이다

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond, detail) { if (cond) pass++; else { fail++; failures.push(detail ? `${desc}: ${detail}` : desc); } }

/** fn 실행 중 eventBus의 'alert' emit을 모두 캡처한다(emitBinderIdRegression.test.js와 동일 패턴). */
async function captureAlerts(fn) {
  const captured = [];
  const onAlert = (payload) => captured.push(payload);
  eventBus.on('alert', onAlert);
  try {
    await fn();
  } finally {
    eventBus.off('alert', onAlert);
  }
  return captured;
}

async function run() {
  // ============ T-N1) 새 게시글 — 브로드캐스트 + requiredLevel:0 ============
  {
    const alerts = await captureAlerts(() => PostService.create(
      { id: 'post1', binder_id: 'b1', title: '공지', body_markdown: '내용' },
      { sender_id: 'target1', device_uuid: 'dev-1' }
    ));
    const alert = alerts.find((a) => a.type === 'post_created');
    check('T-N1 post_created alert가 emit된다', !!alert, `실제 emit=${JSON.stringify(alerts)}`);
    if (alert) {
      check('T-N1 브로드캐스트다(target_user_ids 미지정 — 바인더 멤버 전원)', alert.target_user_ids === undefined, `실제=${JSON.stringify(alert.target_user_ids)}`);
      check('T-N1 requiredLevel:0("모든 활동"에게만 — 가장 좁은 등급)', alert.requiredLevel === 0, `실제=${alert.requiredLevel}`);
      check('T-N1 routeData가 POST를 가리킨다', alert.routeData && alert.routeData.route_type === TargetType.POST && alert.routeData.route_id === 'post1',
        `실제=${JSON.stringify(alert.routeData)}`);
      check('T-N1 binder_id가 실제 게시물의 바인더다(멤버십 조회로 얻은 값 — 클라 값 아님)', alert.binder_id === 'b1');
    }
  }

  // ============ T-N2) 역할 변경 — 당사자 1명 + requiredLevel:1 ============
  {
    // manager1(role=1)이 target1(role=3,member)을 editor(role=2)로 승격 — 요청자보다 낮은
    // 등급 부여라 SC-member-manage.md §16-2(동급·상위 부여 금지) 위반 없이 유효하다.
    const alerts = await captureAlerts(() => BinderService.updateBinderMemberRole('b1', 'target1', 2, 'manager1', 'dev-1'));
    const alert = alerts.find((a) => a.type === 'role_change');
    check('T-N2 role_change alert가 emit된다', !!alert, `실제 emit=${JSON.stringify(alerts)}`);
    if (alert) {
      check('T-N2 대상은 당사자 1명뿐(target_user_ids)', Array.isArray(alert.target_user_ids) && alert.target_user_ids.length === 1 && alert.target_user_ids[0] === 'target1',
        `실제=${JSON.stringify(alert.target_user_ids)}`);
      check('T-N2 requiredLevel:1(§16-2-C "나에게 직접 일어난 일" — 나와 관련된 것만)', alert.requiredLevel === 1, `실제=${alert.requiredLevel}`);
      check('T-N2 routeData가 BINDER_MEMBER·당사자를 가리킨다', alert.routeData && alert.routeData.route_type === TargetType.BINDER_MEMBER && alert.routeData.route_id === 'target1',
        `실제=${JSON.stringify(alert.routeData)}`);
    }
  }

  // ============ T-N3) 자진 탈퇴 — 잔여 멤버 브로드캐스트, requiredLevel 미지정(=0, member_joined와 짝) ============
  {
    let capturedSendAlertPayload = null;
    const notificationService = require('./notificationService');
    const originalSendAlert = notificationService.sendAlert.bind(notificationService);
    notificationService.sendAlert = async (payload) => { capturedSendAlertPayload = payload; return originalSendAlert(payload); };
    try {
      await BinderService.leaveBinder('b1', 'leaver1', 'dev-1');
      await new Promise((resolve) => setImmediate(resolve)); // member:left 핸들러는 emit 이후 비동기로 실행됨
    } finally {
      notificationService.sendAlert = originalSendAlert;
    }
    check('T-N3 자진 탈퇴 시 member_left alert가 sendAlert로 실제 호출된다(수정 전엔 KICK 분기만 있어 아무 것도 안 갔다)',
      capturedSendAlertPayload && capturedSendAlertPayload.type === 'member_left', `실제=${JSON.stringify(capturedSendAlertPayload)}`);
    if (capturedSendAlertPayload) {
      check('T-N3 브로드캐스트다(target_user_ids 미지정 — 잔여 멤버 전원)', capturedSendAlertPayload.target_user_ids === undefined);
      check('T-N3 requiredLevel을 명시하지 않는다(member_joined와 같은 사건의 짝 — 기본값 0)', capturedSendAlertPayload.requiredLevel === undefined,
        `실제=${capturedSendAlertPayload.requiredLevel}`);
      check('T-N3 sender_id는 탈퇴한 본인이다(member_joined 관례와 동일 — actor_id 없음)', capturedSendAlertPayload.sender_id === 'leaver1');
    }
  }

  // ============ T-N4) 강퇴 — 이번 변경이 그 분기를 건드리지 않았다(값 자체는 sendAlertTwoChannelRegression.test.js ⑥이 전수 검증) ============
  {
    let capturedSendAlertPayload = null;
    const notificationService = require('./notificationService');
    const originalSendAlert = notificationService.sendAlert.bind(notificationService);
    notificationService.sendAlert = async (payload) => { capturedSendAlertPayload = payload; return originalSendAlert(payload); };
    try {
      eventBus.emit('member:left', { user_id: 'target1', binder_id: 'b1', actor_id: 'manager1', action: ActionType.KICK });
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      notificationService.sendAlert = originalSendAlert;
    }
    check('T-N4 강퇴 분기는 이번 변경 후에도 member_kicked·requiredLevel:1 그대로다(194 정정 유지 확인)',
      capturedSendAlertPayload && capturedSendAlertPayload.type === 'member_kicked' && capturedSendAlertPayload.requiredLevel === 1,
      `실제=${JSON.stringify(capturedSendAlertPayload)}`);
  }

  console.log(`\n[newAlertEventsRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[newAlertEventsRegression] 실행 실패:', error);
  process.exitCode = 1;
});
