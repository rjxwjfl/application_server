/**
 * src/services/pendingApplicantFilterCoverageRegression.test.js
 * =========================================
 * RLY-20260806-023 — RLY-20260806-018이 심은 승인 대기 신청자(binder_members.role=-1) 배제 필터
 * 13곳(`role >= 0` / `role BETWEEN 0 AND 1`) 각각에 대해, "그 필터를 소스에서 지우면 실패하는" 회귀.
 *
 * 배경: 013곳 중 BinderDAO.getMember 1곳만 binderJoinApprovalRegression.test.js가 지킨다. 나머지
 * 12곳은 필터를 되돌려도 어떤 테스트도 실패하지 않았다(검수 확인). 이 스위트는 그 공백을 메운다.
 *
 * 관행: 테스트 프레임워크 없음(package.json — npm test는 실패하는 placeholder). plain assert +
 * `node <file>.js` 직접 실행, 가짜 DB connection/pool로 실제 DAO/서비스 코드를 구동한다
 * (binderJoinApprovalRegression.test.js·sectionCascadeRegression.test.js와 동일 관행).
 *
 * 핵심 설계: 각 mock의 행 필터링은 "호출부가 실제로 전달한 SQL 텍스트에 필터 문자열이 있는가"로
 * 결정한다(하드코딩된 필터링이 아님) — 즉 소스에서 `role >= 0`(또는 `role BETWEEN 0 AND 1`)을
 * 지우면 mock도 필터링을 멈추고, 대기 신청자가 반환 집합에 나타나 아래 단언이 깨진다. 실 Postgres가
 * 없어 SQL 문법 자체는 검증하지 않는다 — 이 필터가 존재/부재할 때 결과 집합의 내용이 달라지는지만
 * 검증한다("에러가 났다"가 아니라 "반환된 집합의 내용"을 단언).
 *
 * 13개 지점(파일:줄, RLY-20260806-018 기준):
 *  ① binderDAO.js:152  getMember              — role >= 0
 *  ② binderDAO.js:174  getMembersForUpdate     — role >= 0
 *  ③ binderDAO.js:190  getMembers              — dm.role >= 0
 *  ④ binderDAO.js:204  getMyBinders            — dm.role >= 0
 *  ⑤ sectionDAO.js:31  findByBinderId          — bm.role BETWEEN 0 AND 1
 *  ⑥ sectionDAO.js:64  hasAccess               — bm.role >= 0
 *  ⑦ syncDAO.js:11     getBinderIdsByUserId    — role >= 0
 *  ⑧ syncDAO.js:50     getBinderMembers        — role >= 0
 *  ⑨ syncDAO.js:79     getUsersForSync         — dm.role >= 0
 *  ⑩ syncDAO.js:105    getSection              — bm.role >= 0 (JOIN 조건)
 *  ⑪ notificationDAO.js:39  getBinderIdsByUserId — role >= 0
 *  ⑫ notificationDAO.js  getActiveMemberIds(RLY-20260806-190 이전엔 getMembersForAlert) — dm.role >= 0
 *  ⑬ notificationService.js:85  sendAlert(SECTION_MESSAGE 타겟팅) — bm.role >= 0
 *
 * 실행: node src/services/pendingApplicantFilterCoverageRegression.test.js
 */

// src/configs/db.js가 모듈 로드 시점에 PGHOST 등을 eager 검증한다(notificationService.js가 logger를
// 거쳐 간접 참조 — storageQuotaRegression.test.js와 동일 관행). 이 스위트는 실제 커넥션을 만들지
// 않으므로(⑬에서 config/db 자체를 가짜로 교체) 더미 값으로 그 검증만 통과시킨다.
process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test';
process.env.PGDATABASE = process.env.PGDATABASE || 'test';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test';

const { BinderDAO } = require('../daos/binderDAO');
const { SectionDAO } = require('../daos/sectionDAO');
const { SyncDAO } = require('../daos/syncDAO');
const { NotificationDAO } = require('../daos/notificationDAO');

const NOW = new Date().toISOString();

let pass = 0;
let fail = 0;
const failures = [];

function check(desc, cond) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(desc);
  }
}

// sectionDAO.findByBinderId처럼 필터 조건 설명 주석이 SQL 템플릿 리터럴 "안"에 `--` SQL 주석으로
// 박혀 있는 경우가 있다(다른 대부분은 `//` JS 주석이 문자열 밖에 있어 무관하지만, 이 경우는 주석
// 문구 자체가 필터 키워드를 담고 있어서 실제 WHERE절을 지워도 주석 때문에 문자열 매칭이 계속
// "필터 있음"으로 오판할 수 있다). `--`~줄끝을 먼저 제거해 실제 실행되는 SQL만 매칭 대상으로 삼는다.
function norm(sql) {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── ① BinderDAO.getMember ──────────────────────────────────────────────
async function testGetMember() {
  const rows = {
    'b1:pending1': { binder_id: 'b1', user_id: 'pending1', role: -1, notification_level: 1, nickname_in_binder: null, joined_at: NOW, deleted_at: null },
    'b1:member1': { binder_id: 'b1', user_id: 'member1', role: 3, notification_level: 1, nickname_in_binder: null, joined_at: NOW, deleted_at: null },
  };
  const conn = {
    async query(sql, params) {
      const s = norm(sql);
      const row = rows[`${params[0]}:${params[1]}`];
      if (!row) return { rows: [] };
      if (s.includes('role >= 0') && row.role < 0) return { rows: [] };
      return { rows: [row] };
    },
  };
  const pending = await BinderDAO.getMember(conn, 'b1', 'pending1');
  const member = await BinderDAO.getMember(conn, 'b1', 'member1');
  check('① BinderDAO.getMember: pending 배제', pending === null);
  check('① BinderDAO.getMember: 정상 멤버 포함', !!member && member.user_id === 'member1');
}

// ── ② BinderDAO.getMembersForUpdate ────────────────────────────────────
async function testGetMembersForUpdate() {
  const rows = [
    { binder_id: 'b1', user_id: 'pending1', role: -1, deleted_at: null },
    { binder_id: 'b1', user_id: 'member1', role: 3, deleted_at: null },
  ];
  const conn = {
    async query(sql, params) {
      const s = norm(sql);
      const [binderId, userIds] = params;
      let result = rows.filter((r) => r.binder_id === binderId && userIds.includes(r.user_id));
      if (s.includes('role >= 0')) result = result.filter((r) => r.role >= 0);
      return { rows: result };
    },
  };
  const result = await BinderDAO.getMembersForUpdate(conn, 'b1', ['pending1', 'member1']);
  const ids = result.map((r) => r.user_id);
  check('② BinderDAO.getMembersForUpdate: pending 배제', !ids.includes('pending1'));
  check('② BinderDAO.getMembersForUpdate: 정상 멤버 포함', ids.includes('member1'));
}

// ── ③ BinderDAO.getMembers ─────────────────────────────────────────────
async function testGetMembers() {
  const rows = [
    { binder_id: 'b1', user_id: 'pending1', role: -1, notification_level: 1, nickname_in_binder: null, joined_at: NOW, deleted_at: null, display_name: 'Pending', user_code: 'PND', image_url: null, email: 'p@x.com' },
    { binder_id: 'b1', user_id: 'member1', role: 3, notification_level: 1, nickname_in_binder: null, joined_at: NOW, deleted_at: null, display_name: 'Member', user_code: 'MBR', image_url: null, email: 'm@x.com' },
  ];
  const conn = {
    async query(sql, params) {
      const s = norm(sql);
      const [binderId] = params;
      let result = rows.filter((r) => r.binder_id === binderId && !r.deleted_at);
      if (s.includes('dm.role >= 0')) result = result.filter((r) => r.role >= 0);
      return { rows: result };
    },
  };
  const result = await BinderDAO.getMembers(conn, 'b1');
  const ids = result.map((r) => r.user_id);
  check('③ BinderDAO.getMembers: pending 배제', !ids.includes('pending1'));
  check('③ BinderDAO.getMembers: 정상 멤버 포함', ids.includes('member1'));
}

// ── ④ BinderDAO.getMyBinders ───────────────────────────────────────────
async function testGetMyBinders() {
  const rows = [
    { id: 'b1', name: 'B1', description: null, image_url: null, thumbnail_url: null, member_count: 2, last_activity_at: NOW, created_at: NOW, deleted_at: null, role: -1, notification_level: 1, joined_at: NOW, user_id: 'pending1', binder_id: 'b1' },
    { id: 'b1', name: 'B1', description: null, image_url: null, thumbnail_url: null, member_count: 2, last_activity_at: NOW, created_at: NOW, deleted_at: null, role: 3, notification_level: 1, joined_at: NOW, user_id: 'member1', binder_id: 'b1' },
  ];
  const conn = {
    async query(sql, params) {
      const s = norm(sql);
      const [userId] = params;
      let result = rows.filter((r) => r.user_id === userId && !r.deleted_at);
      if (s.includes('dm.role >= 0')) result = result.filter((r) => r.role >= 0);
      return { rows: result };
    },
  };
  const pendingResult = await BinderDAO.getMyBinders(conn, 'pending1');
  const memberResult = await BinderDAO.getMyBinders(conn, 'member1');
  check('④ BinderDAO.getMyBinders: pending은 결과 없음', pendingResult.length === 0);
  check('④ BinderDAO.getMyBinders: 정상 멤버는 바인더 포함', memberResult.some((r) => r.id === 'b1'));
}

// ── ⑤ SectionDAO.findByBinderId ────────────────────────────────────────
async function testFindByBinderId() {
  const sections = [
    { id: 's-priv', binder_id: 'b1', title: 'Private', access_scope: 1, is_default: false, deleted_at: null },
  ];
  const sectionMembers = []; // 아무도 명시적 section_member로 심지 않음 — master override 경로만 테스트
  const binderMembers = {
    'b1:pending1': { role: -1, deleted_at: null },
    'b1:master1': { role: 0, deleted_at: null },
  };
  function makeConn() {
    return {
      async query(sql, params) {
        const s = norm(sql);
        const [binderId, userId] = params;
        const hasRoleFilter = s.includes('role BETWEEN 0 AND 1');
        const rows = sections
          .filter((sec) => sec.binder_id === binderId && !sec.deleted_at)
          .filter((sec) => {
            if (sec.access_scope === 0) return true;
            const isSectionMember = sectionMembers.some((sm) => sm.section_id === sec.id && sm.user_id === userId && !sm.deleted_at);
            if (isSectionMember) return true;
            const bm = binderMembers[`${binderId}:${userId}`];
            if (!bm || bm.deleted_at) return false;
            if (hasRoleFilter) return bm.role >= 0 && bm.role <= 1;
            return true; // 필터 제거 시: 존재하는 binder_members 행이면(role 무관) 무조건 override
          })
          .map((sec) => ({ id: sec.id, binder_id: sec.binder_id, title: sec.title, access_scope: sec.access_scope, is_default: sec.is_default }));
        return { rows };
      },
    };
  }
  const pendingResult = await SectionDAO.findByBinderId(makeConn(), 'b1', 'pending1');
  const masterResult = await SectionDAO.findByBinderId(makeConn(), 'b1', 'master1');
  check('⑤ SectionDAO.findByBinderId: pending은 비공개 섹션 못 봄', !pendingResult.some((r) => r.id === 's-priv'));
  check('⑤ SectionDAO.findByBinderId: master(정상 관리자)는 비공개 섹션 봄', masterResult.some((r) => r.id === 's-priv'));
}

// ── ⑥ SectionDAO.hasAccess ─────────────────────────────────────────────
async function testHasAccess() {
  const sections = { 's-pub': { id: 's-pub', binder_id: 'b1', access_scope: 0, deleted_at: null } };
  const binderMembers = {
    'b1:pending1': { role: -1, deleted_at: null },
    'b1:member1': { role: 3, deleted_at: null },
  };
  const sectionMembers = [];
  function makeConn() {
    return {
      async query(sql, params) {
        const s = norm(sql);
        const [sectionId, userId] = params;
        const sec = sections[sectionId];
        if (!sec || sec.deleted_at) return { rowCount: 0 };
        const hasRoleFilter = s.includes('bm.role >= 0');
        const bm = binderMembers[`${sec.binder_id}:${userId}`];
        if (!bm || bm.deleted_at) return { rowCount: 0 };
        if (hasRoleFilter && bm.role < 0) return { rowCount: 0 };
        const scopeOk = sec.access_scope === 0 || sectionMembers.some((sm) => sm.section_id === sectionId && sm.user_id === userId && !sm.deleted_at);
        return scopeOk ? { rowCount: 1 } : { rowCount: 0 };
      },
    };
  }
  const pendingAccess = await SectionDAO.hasAccess(makeConn(), 's-pub', 'pending1');
  const memberAccess = await SectionDAO.hasAccess(makeConn(), 's-pub', 'member1');
  check('⑥ SectionDAO.hasAccess: pending은 접근 불가', pendingAccess === false);
  check('⑥ SectionDAO.hasAccess: 정상 멤버는 접근 가능', memberAccess === true);
}

// ── ⑦ SyncDAO.getBinderIdsByUserId ─────────────────────────────────────
async function testSyncGetBinderIdsByUserId() {
  const rows = [
    { binder_id: 'b1', user_id: 'pending1', role: -1, deleted_at: null },
    { binder_id: 'b1', user_id: 'member1', role: 3, deleted_at: null },
    { binder_id: 'b2', user_id: 'member1', role: 3, deleted_at: null },
  ];
  const pool = {
    async query(sql, params) {
      const s = norm(sql);
      const [userId] = params;
      let result = rows.filter((r) => r.user_id === userId && !r.deleted_at);
      if (s.includes('role >= 0')) result = result.filter((r) => r.role >= 0);
      return { rows: result.map((r) => ({ binder_id: r.binder_id })) };
    },
  };
  const pendingIds = await SyncDAO.getBinderIdsByUserId(pool, 'pending1');
  const memberIds = await SyncDAO.getBinderIdsByUserId(pool, 'member1');
  check('⑦ SyncDAO.getBinderIdsByUserId: pending은 동기화 스코프 0건(동기화 뿌리)', pendingIds.length === 0);
  check('⑦ SyncDAO.getBinderIdsByUserId: 정상 멤버는 스코프 포함', memberIds.includes('b1') && memberIds.includes('b2'));
}

// ── ⑧ SyncDAO.getBinderMembers ─────────────────────────────────────────
async function testSyncGetBinderMembers() {
  const rows = [
    { binder_id: 'b1', user_id: 'pending1', role: -1, nickname_in_binder: null, joined_at: NOW, created_at: NOW, updated_at: NOW, deleted_at: null },
    { binder_id: 'b1', user_id: 'member1', role: 3, nickname_in_binder: null, joined_at: NOW, created_at: NOW, updated_at: NOW, deleted_at: null },
  ];
  const pool = {
    async query(sql, params) {
      const s = norm(sql);
      const [currDIds] = params;
      let result = rows.filter((r) => currDIds.includes(r.binder_id) && !r.deleted_at);
      if (s.includes('role >= 0')) result = result.filter((r) => r.role >= 0);
      return { rows: result };
    },
  };
  const result = await SyncDAO.getBinderMembers(pool, ['b1']);
  const ids = result.map((r) => r.user_id);
  check('⑧ SyncDAO.getBinderMembers: pending은 멤버 로스터에서 배제(동기화 페이로드 비노출)', !ids.includes('pending1'));
  check('⑧ SyncDAO.getBinderMembers: 정상 멤버는 로스터 포함', ids.includes('member1'));
}

// ── ⑨ SyncDAO.getUsersForSync ──────────────────────────────────────────
async function testGetUsersForSync() {
  const memberRows = [
    { binder_id: 'b1', user_id: 'pending1', role: -1, deleted_at: null },
    { binder_id: 'b1', user_id: 'member1', role: 3, deleted_at: null },
  ];
  const userInfos = {
    pending1: { id: 'pending1', user_code: 'PND', display_name: 'Pending', bio: null, image_url: null, thumbnail_url: null, created_at: NOW, updated_at: NOW, deleted_at: null },
    member1: { id: 'member1', user_code: 'MBR', display_name: 'Member', bio: null, image_url: null, thumbnail_url: null, created_at: NOW, updated_at: NOW, deleted_at: null },
  };
  const pool = {
    async query(sql, params) {
      const s = norm(sql);
      const [currDIds] = params;
      let candidates = memberRows.filter((r) => currDIds.includes(r.binder_id) && !r.deleted_at);
      if (s.includes('dm.role >= 0')) candidates = candidates.filter((r) => r.role >= 0);
      const rows = candidates.map((r) => userInfos[r.user_id]).filter(Boolean);
      return { rows };
    },
  };
  // RLY-20260806-050 — getUsersForSync가 oldTs 인자를 더 이상 받지 않는다(무조건 100% 재전송으로 정정).
  const result = await SyncDAO.getUsersForSync(pool, ['b1']);
  const ids = result.map((r) => r.id);
  check('⑨ SyncDAO.getUsersForSync: pending 프로필은 다른 멤버 동기화에 노출 안 됨', !ids.includes('pending1'));
  check('⑨ SyncDAO.getUsersForSync: 정상 멤버 프로필은 포함', ids.includes('member1'));
}

// ── ⑩ SyncDAO.getSection ───────────────────────────────────────────────
async function testGetSection() {
  const sections = [
    { id: 's-pub', binder_id: 'b1', title: 'Public', access_scope: 0, is_default: false, deleted_at: null },
  ];
  const binderMembers = {
    'b1:pending1': { role: -1, deleted_at: null },
    'b1:member1': { role: 3, deleted_at: null },
  };
  function makePool() {
    return {
      async query(sql, params) {
        const s = norm(sql);
        const [userId, currDIds] = params;
        const bm = binderMembers[`b1:${userId}`];
        const hasJoinFilter = s.includes('bm.role >= 0');
        // JOIN 조건: bm.deleted_at IS NULL은 필터 유무와 무관하게 항상 적용됨
        if (!bm || bm.deleted_at) return { rows: [] };
        // bm.role >= 0가 JOIN ON절에 있으면, role<0인 행은 애초에 JOIN이 안 되어 결과가 0건이 된다
        if (hasJoinFilter && bm.role < 0) return { rows: [] };
        const rows = sections.filter(
          (sec) => currDIds.includes(sec.binder_id) && !sec.deleted_at
            && ((bm.role >= 0 && bm.role <= 1) || sec.access_scope === 0)
        );
        return { rows };
      },
    };
  }
  const pendingResult = await SyncDAO.getSection(makePool(), 'pending1', ['b1'], null, []);
  const memberResult = await SyncDAO.getSection(makePool(), 'member1', ['b1'], null, []);
  check('⑩ SyncDAO.getSection: pending은 섹션 델타 0건(JOIN 자체가 막힘)', pendingResult.length === 0);
  check('⑩ SyncDAO.getSection: 정상 멤버는 공개 섹션 델타 받음', memberResult.some((r) => r.id === 's-pub'));
}

// ── ⑪ NotificationDAO.getBinderIdsByUserId ─────────────────────────────
async function testNotifGetBinderIdsByUserId() {
  const rows = [
    { binder_id: 'b1', user_id: 'pending1', role: -1, deleted_at: null },
    { binder_id: 'b1', user_id: 'member1', role: 3, deleted_at: null },
  ];
  const conn = {
    async query(sql, params) {
      const s = norm(sql);
      const [userId] = params;
      let result = rows.filter((r) => r.user_id === userId && !r.deleted_at);
      if (s.includes('role >= 0')) result = result.filter((r) => r.role >= 0);
      return { rows: result.map((r) => ({ binder_id: r.binder_id })) };
    },
  };
  const pendingIds = await NotificationDAO.getBinderIdsByUserId(conn, 'pending1');
  const memberIds = await NotificationDAO.getBinderIdsByUserId(conn, 'member1');
  check('⑪ NotificationDAO.getBinderIdsByUserId: pending은 FCM 바인더 토픽 구독 대상 0건', pendingIds.length === 0);
  check('⑪ NotificationDAO.getBinderIdsByUserId: 정상 멤버는 토픽 포함', memberIds.includes('b1'));
}

// ── ⑫ NotificationDAO.getActiveMemberIds ────────────────────────────────
// RLY-20260806-190 — getMembersForAlert(notification_level까지 SQL에서 함께 거르던
// 메서드)는 삭제됐다(가시성·선호를 분리하며 정리 — sendAlert가 이제 이 메서드로 가시성만
// 가져온 뒤, filterUserIdsByNotificationLevel로 선호를 별도로 좁힌다). 이 회귀의 관심사인
// "pending은 대상 아님·정상 멤버는 대상"은 role>=0 필터로 여전히 유효해 그대로 옮긴다.
async function testGetActiveMemberIds() {
  const rows = [
    { binder_id: 'b1', user_id: 'pending1', role: -1, deleted_at: null },
    { binder_id: 'b1', user_id: 'member1', role: 3, deleted_at: null },
  ];
  const conn = {
    async query(sql, params) {
      const s = norm(sql);
      const [binderId] = params;
      let result = rows.filter((r) => r.binder_id === binderId && !r.deleted_at);
      if (s.includes('dm.role >= 0')) result = result.filter((r) => r.role >= 0);
      return { rows: result.map((r) => ({ user_id: r.user_id })) };
    },
  };
  const ids = await NotificationDAO.getActiveMemberIds(conn, 'b1');
  check('⑫ NotificationDAO.getActiveMemberIds: pending은 대상 아님', !ids.includes('pending1'));
  check('⑫ NotificationDAO.getActiveMemberIds: 정상 멤버는 대상', ids.includes('member1'));
}

// ── ⑬ NotificationService.sendAlert (SECTION_MESSAGE 타겟팅) ───────────
async function testSendAlertSectionMessageTargeting() {
  const dbPath = require.resolve('../../config/db');
  // notificationService.js는 최상단에서 `require('../utils/fcm')`을 무조건 실행하는데, fcm.js →
  // firebase.js → configs/index.js → configs/db.js가 PGHOST 등 실 DB env를 필수로 요구해서(이 worktree
  // .env에는 없음) 그대로 두면 require 시점에 죽는다. mockQuery 도달 전이라 authz 분기와 무관한
  // 환경 결함이므로 fcm만 무해한 스텁으로 교체해 우회한다(SQL 필터 검증과는 무관).
  const fcmPath = require.resolve('../utils/fcm');
  require.cache[fcmPath] = {
    id: fcmPath,
    filename: fcmPath,
    loaded: true,
    exports: {
      sendToTopic: async () => 'stub',
      sendMulticast: async () => ({ successCount: 0, failureCount: 0, staleTokens: [] }),
      subscribeToTopic: async () => {},
      unsubscribeFromTopic: async () => {},
    },
  };

  const messages = { msg1: { id: 'msg1', section_id: 'sec1' } };
  const sectionsFixture = { sec1: { id: 'sec1', binder_id: 'b1', access_scope: 0, deleted_at: null } };
  const binderMembers = {
    'b1:pending1': { role: -1, deleted_at: null },
    'b1:member1': { role: 3, deleted_at: null },
  };
  const sectionMembers = [];

  const mockPool = {
    async query(sql, params) {
      const s = norm(sql);
      if (s.startsWith('SELECT bm.user_id FROM section_messages')) {
        const [routeId, userIds] = params;
        const msg = messages[routeId];
        if (!msg) return { rows: [] };
        const sec = sectionsFixture[msg.section_id];
        const hasRoleFilter = s.includes('bm.role >= 0');
        const rows = userIds
          .filter((uid) => {
            const bm = binderMembers[`${sec.binder_id}:${uid}`];
            if (!bm || bm.deleted_at) return false;
            if (hasRoleFilter && bm.role < 0) return false;
            return sec.access_scope === 0 || sectionMembers.some((sm) => sm.section_id === sec.id && sm.user_id === uid && !sm.deleted_at);
          })
          .map((uid) => ({ user_id: uid }));
        return { rows };
      }
      // NotificationDAO.filterUserIdsByNotificationLevel (RLY-20260806-184 신규) — 이
      // 회귀의 관심사는 pending 배제뿐이라 notification_level은 다루지 않는다. 후보를
      // 그대로 통과시켜(전부 기본값 0=allActivity로 취급) 그 뒤의 SECTION_MESSAGE 전용
      // 필터가 pending을 배제하는 것만 검증한다.
      if (s.startsWith('SELECT dm.user_id') && s.includes('FROM binder_members') && s.includes('notification_level <= $3')) {
        const [, userIds] = params;
        return { rows: userIds.map((uid) => ({ user_id: uid })) };
      }
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
      return { rows: [] };
    },
  };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockPool };

  delete require.cache[require.resolve('../daos/notificationDAO')];
  delete require.cache[require.resolve('./notificationService')];
  const { NotificationDAO: FreshNotificationDAO } = require('../daos/notificationDAO');
  const notificationService = require('./notificationService');

  let capturedUserIds = null;
  const original = FreshNotificationDAO.getActiveTokensByUserIds;
  FreshNotificationDAO.getActiveTokensByUserIds = async (_conn, userIds) => {
    capturedUserIds = userIds;
    return []; // 토큰 없음 → fcm 미호출로 조기 반환(순수 authz 분기만 검증)
  };

  try {
    await notificationService.sendAlert({
      binder_id: 'b1',
      sender_id: 'someoneElse',
      type: 'message',
      title: 't',
      body: 'b',
      target_user_ids: ['pending1', 'member1'],
      routeData: { route_type: 'SECTION_MESSAGE', route_id: 'msg1' },
    });
  } finally {
    FreshNotificationDAO.getActiveTokensByUserIds = original;
  }

  check('⑬ NotificationService.sendAlert: pending은 SECTION_MESSAGE 푸시 대상에서 배제', capturedUserIds !== null && !capturedUserIds.includes('pending1'));
  check('⑬ NotificationService.sendAlert: 정상 멤버는 푸시 대상 포함', capturedUserIds !== null && capturedUserIds.includes('member1'));
}

async function run() {
  await testGetMember();
  await testGetMembersForUpdate();
  await testGetMembers();
  await testGetMyBinders();
  await testFindByBinderId();
  await testHasAccess();
  await testSyncGetBinderIdsByUserId();
  await testSyncGetBinderMembers();
  await testGetUsersForSync();
  await testGetSection();
  await testNotifGetBinderIdsByUserId();
  await testGetActiveMemberIds();
  await testSendAlertSectionMessageTargeting();

  console.log(`\n[pendingApplicantFilterCoverageRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[pendingApplicantFilterCoverageRegression] 실행 실패:', error);
  process.exitCode = 1;
});
