/**
 * src/services/binderJoinApprovalRegression.test.js
 * =========================================
 * RLY-20260806-018 바인더 가입 승인 우회 회귀 스위트.
 *
 * authzRegression.test.js와 동일한 관행을 따른다: 테스트 프레임워크 없이 plain assert +
 * `node <file>.js` 직접 실행, 가짜 DB connection으로 실제 서비스 코드를 구동한다. 실제 Postgres가
 * 없어 SQL 자체의 정합성(문법·컬럼명)은 검증하지 않는다 — 서비스 레이어의 인가 분기(멤버십·role
 * 게이트)가 role=-1 pending sentinel을 올바르게 다루는지를 검증한다.
 *
 * 실행: node src/services/binderJoinApprovalRegression.test.js
 */

const assert = require('assert');

const dbPath = require.resolve('../../config/db');

const NOW = new Date().toISOString();

const db = {
  binders: {},
  binder_settings: {},
  binder_members: {}, // key: `${binderId}:${userId}`
};

function setMember(binderId, userId, role, deletedAt = null) {
  db.binder_members[`${binderId}:${userId}`] = {
    binder_id: binderId, user_id: userId, role,
    notification_level: 1, nickname_in_binder: null,
    joined_at: NOW, created_at: NOW, updated_at: NOW, deleted_at: deletedAt,
  };
}

// ── 픽스처 ──────────────────────────────────────────────────────────────
// bA: 비공개(is_public=false) + 승인제(require_approval=true). masterA=master(role=0).
// bB: 공개(is_public=true) + 승인 불필요(require_approval=false) — 종전과 동일한 즉시가입 대상.
db.binders.bA = { id: 'bA', name: 'ApprovalBinder', description: null, image_url: null, thumbnail_url: null, member_count: 1, last_activity_at: NOW, created_at: NOW, updated_at: NOW, deleted_at: null };
db.binder_settings.bA = { binder_id: 'bA', is_public: false, is_searchable: false, require_approval: true, updated_at: NOW };
setMember('bA', 'masterA', 0);

db.binders.bB = { id: 'bB', name: 'PublicBinder', description: null, image_url: null, thumbnail_url: null, member_count: 1, last_activity_at: NOW, created_at: NOW, updated_at: NOW, deleted_at: null };
db.binder_settings.bB = { binder_id: 'bB', is_public: true, is_searchable: true, require_approval: false, updated_at: NOW };
setMember('bB', 'masterB', 0);

const queryLog = [];

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  queryLog.push(s);

  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // BinderDAO.getSettings
  if (s.startsWith('SELECT binder_id, is_public, is_searchable, require_approval, updated_at') && s.includes('FROM binder_settings')) {
    const row = db.binder_settings[params[0]];
    return { rows: row ? [row] : [] };
  }

  // BinderDAO.getMember / getMemberIncludingPending — 둘 다 단일 행 lookup, getMember만 "AND role >= 0"이 붙는다.
  if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2') && !s.includes('ANY(')) {
    const row = db.binder_members[`${params[0]}:${params[1]}`];
    if (!row) return { rows: [] };
    if (s.includes('AND role >= 0') && row.role < 0) return { rows: [] };
    return { rows: [row] };
  }

  // BinderDAO.getMembers(목록) — authz 통과 후에만 도달해야 함
  if (s.includes('FROM binder_members dm') && s.includes('JOIN users u')) {
    return { rows: [] };
  }

  // BinderDAO.getPendingMembers
  if (s.includes('FROM binder_members dm') && s.includes('dm.role = -1')) {
    const rows = Object.values(db.binder_members)
      .filter((r) => r.binder_id === params[0] && r.role === -1 && !r.deleted_at)
      .map((r) => ({ user_id: r.user_id, created_at: r.created_at, display_name: null, user_code: null, image_url: null }));
    return { rows };
  }

  // BinderDAO.findById(binders)
  if (s.includes('FROM binders') && s.includes('WHERE id = $1') && !s.includes('ILIKE')) {
    const row = db.binders[params[0]];
    return { rows: row ? [row] : [] };
  }

  // BinderDAO.addMember — INSERT..ON CONFLICT DO UPDATE (role sentinel -1 또는 정식 role)
  if (s.startsWith('INSERT INTO binder_members')) {
    const [binderId, userId, role] = params;
    const key = `${binderId}:${userId}`;
    const prev = db.binder_members[key];
    const row = {
      binder_id: binderId, user_id: userId, role,
      notification_level: prev ? prev.notification_level : 1,
      nickname_in_binder: prev ? prev.nickname_in_binder : null,
      joined_at: prev ? prev.joined_at : NOW,
      created_at: prev ? prev.created_at : NOW,
      updated_at: NOW,
      deleted_at: null,
    };
    db.binder_members[key] = row;
    return { rows: [row] };
  }

  // BinderDAO.removePendingRequest — role=-1 행만 soft delete
  if (s.startsWith('UPDATE binder_members') && s.includes('role = -1')) {
    const [binderId, userId] = params;
    const row = db.binder_members[`${binderId}:${userId}`];
    if (row && row.role === -1) row.deleted_at = NOW;
    return { rows: [] };
  }

  // 나머지 쓰기 구문(incrementMemberCount 등) — 이 회귀의 관심사가 아니므로 성공만 흉내낸다.
  if (s.startsWith('UPDATE ') || s.startsWith('INSERT INTO')) {
    return { rows: [{}] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const mockDb = {
  query: mockQuery,
  connect: async () => ({ query: mockQuery, release() {} }),
};

require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { BinderService } = require('./binderService');

let pass = 0;
let fail = 0;
const failures = [];

async function expectStatus(desc, fn, expectedStatus) {
  try {
    await fn();
    fail++;
    failures.push(`${desc}: 예상 ${expectedStatus} — 통과해버림(에러 없음)`);
  } catch (err) {
    if (err.statusCode === expectedStatus) {
      pass++;
    } else {
      fail++;
      failures.push(`${desc}: 예상 ${expectedStatus}, 실제 ${err.statusCode || '(non-AppError) ' + err.message}`);
    }
  }
}

async function expectOk(desc, fn) {
  try {
    await fn();
    pass++;
  } catch (err) {
    fail++;
    failures.push(`${desc}: 정상 통과를 기대했지만 에러 — ${err.statusCode || ''} ${err.message}`);
  }
}

async function run() {
  // ① 승인제 신청 → 정식 멤버 아님
  await expectOk('requestBinderJoin(승인제) 자체는 성공', () => BinderService.requestBinderJoin('bA', 'applicant1', 'dev1'));
  await expectStatus('신청 직후 applicant1은 정식 멤버 아님(getBinderMembers)', () => BinderService.getBinderMembers('bA', 'applicant1'), 403);

  // ② 대기 상태로 바인더 조회·검색 차단
  await expectStatus('대기 상태 getBinder 차단(비공개 바인더)', () => BinderService.getBinder('bA', 'applicant1'), 403);
  await expectStatus('대기 상태 search 차단', () => BinderService.search('bA', { q: 'test' }, 'applicant1'), 403);

  // ⑥ 대기 role(-1)이 관리자 권한 비교를 통과하지 않음 — 승인 전에 먼저 검증(승인 후엔 role이 바뀌어 의미 없음)
  await expectStatus('pending role은 getJoinRequests(관리자 전용) 통과 못함', () => BinderService.getJoinRequests('bA', 'applicant1'), 403);
  await expectStatus('pending role은 approveJoinRequest 요청자 권한도 통과 못함', () => BinderService.approveJoinRequest('bA', 'masterA', 'applicant1'), 403);

  // ③ 승인 후 접근 가능
  await expectOk('관리자(masterA)의 approveJoinRequest', () => BinderService.approveJoinRequest('bA', 'applicant1', 'masterA'));
  await expectOk('승인 후 applicant1은 정식 멤버(getBinderMembers 통과)', () => BinderService.getBinderMembers('bA', 'applicant1'));

  // ④ 거절 후 차단 유지
  await expectOk('requestBinderJoin(applicant2)', () => BinderService.requestBinderJoin('bA', 'applicant2', 'dev2'));
  await expectOk('관리자(masterA)의 rejectJoinRequest', () => BinderService.rejectJoinRequest('bA', 'applicant2', 'masterA'));
  await expectStatus('거절 후 applicant2는 여전히 비멤버', () => BinderService.getBinderMembers('bA', 'applicant2'), 403);

  // ⑤ 공개(require_approval=false) 바인더는 종전과 동일하게 즉시 가입
  await expectOk('requestBinderJoin(공개 바인더)', () => BinderService.requestBinderJoin('bB', 'newuserB', 'dev3'));
  await expectOk('공개 바인더는 신청 즉시 정식 멤버', () => BinderService.getBinderMembers('bB', 'newuserB'));

  // ── 추가: 중복 신청·재신청이 500이 아니라 명시적 4xx인지 ──────────────────
  await expectStatus('이미 정식 멤버(applicant1)의 재신청은 409', () => BinderService.requestBinderJoin('bA', 'applicant1', 'dev1'), 409);
  await expectOk('거절 이력(applicant2)의 재신청은 새 pending으로 성공', () => BinderService.requestBinderJoin('bA', 'applicant2', 'dev2'));
  await expectStatus('이미 대기 중(applicant2)인데 또 신청하면 409(500 아님)', () => BinderService.requestBinderJoin('bA', 'applicant2', 'dev2'), 409);
  await expectStatus('재신청 후에도 정식 멤버는 아님', () => BinderService.getBinderMembers('bA', 'applicant2'), 403);

  console.log(`\n[binderJoinApprovalRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[binderJoinApprovalRegression] 실행 실패:', error);
  process.exitCode = 1;
});
