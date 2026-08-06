/**
 * src/services/binderJoinApprovalRegression.test.js
 * =========================================
 * RLY-20260806-018/024 바인더 가입 승인 회귀 스위트.
 *
 * authzRegression.test.js와 동일한 관행을 따른다: 테스트 프레임워크 없이 plain assert +
 * `node <file>.js` 직접 실행, 가짜 DB connection으로 실제 서비스 코드를 구동한다. 실제 Postgres가
 * 없어 SQL 자체의 정합성(문법·컬럼명)은 검증하지 않는다 — 서비스 레이어의 인가 분기와 상태 전이가
 * 스펙(schema.md:234-256, api.md:446-521)대로 동작하는지를 검증한다.
 *
 * RLY-20260806-018은 승인 대기를 binder_members.role = -1 sentinel로 표시했으나, RLY-20260806-024
 * 로 별도 binder_join_requests 테이블로 이전됐다 — 대기자는 이제 binder_members에 전혀 나타나지
 * 않는다. 이 스위트는 그 새 계약을 검증한다.
 *
 * 실행: node src/services/binderJoinApprovalRegression.test.js
 */

const assert = require('assert');

const dbPath = require.resolve('../../config/db');

const NOW = new Date().toISOString();
const PAST = new Date(Date.now() - 24 * 3600 * 1000).toISOString(); // 만료 PENDING 픽스처용

const db = {
  binders: {},
  binder_settings: {},
  binder_members: {}, // key: `${binderId}:${userId}`
  binder_join_requests: {}, // key: id
};

function setMember(binderId, userId, role, deletedAt = null) {
  db.binder_members[`${binderId}:${userId}`] = {
    binder_id: binderId, user_id: userId, role,
    notification_level: 1, nickname_in_binder: null,
    joined_at: NOW, created_at: NOW, updated_at: NOW, deleted_at: deletedAt,
  };
}

let seq = 0;
function setJoinRequest(binderId, requesterId, status, { expiresAt = null, decidedBy = null, decidedAt = null } = {}) {
  const id = `jr-${++seq}`;
  db.binder_join_requests[id] = {
    id, binder_id: binderId, requester_id: requesterId, status,
    decided_by: decidedBy, decided_at: decidedAt,
    expires_at: expiresAt || new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    created_at: NOW, updated_at: NOW,
  };
  return id;
}

function filterJoinRequests(binderId, status) {
  return Object.values(db.binder_join_requests).filter((r) => {
    if (r.binder_id !== binderId) return false;
    if (status && r.status !== status) return false;
    // 조회 시점 판정 — 만료된 PENDING은 status를 바꾸지 않은 채(배치 없음) 목록에서만 제외한다
    // (design_intent.md:236, DAO.getJoinRequests 주석 참조).
    if (r.status === 'PENDING' && new Date(r.expires_at) <= new Date()) return false;
    return true;
  });
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

  // BinderDAO.getMember — 항상 "AND role >= 0"이 붙는다(대기자는 binder_members에 없으므로
  // 이 필터의 영향을 이제 받지 않지만, 필터 자체는 회귀 대상이라 남겨둔다).
  if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2') && !s.includes('ANY(')) {
    const row = db.binder_members[`${params[0]}:${params[1]}`];
    if (!row) return { rows: [] };
    if (s.includes('AND role >= 0') && row.role < 0) return { rows: [] };
    return { rows: [row] };
  }

  // BinderDAO.getMembers(목록) — authz 통과 후에만 도달해야 함
  // RLY-20260806-066 — u.email 제거로 `JOIN users u`도 함께 빠졌다. LEFT JOIN user_infos만으로 매칭한다.
  if (s.includes('FROM binder_members dm') && s.includes('LEFT JOIN user_infos ui')) {
    return { rows: [] };
  }

  // BinderDAO.findById(binders)
  if (s.includes('FROM binders') && s.includes('WHERE id = $1') && !s.includes('ILIKE')) {
    const row = db.binders[params[0]];
    return { rows: row ? [row] : [] };
  }

  // BinderDAO.addMember — INSERT..ON CONFLICT DO UPDATE (정식 role만 쓴다 — sentinel 없음)
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

  // ── BinderDAO — binder_join_requests (RLY-20260806-024) ──────────────────

  // hasActiveBlock — idx_bjr_blocked
  if (s.startsWith('SELECT id FROM binder_join_requests')) {
    const [binderId, requesterId] = params;
    const blocked = Object.values(db.binder_join_requests).some(
      (r) => r.binder_id === binderId && r.requester_id === requesterId && r.status === 'BLOCKED'
    );
    return { rows: blocked ? [{ id: 'blocked-row' }] : [] };
  }

  // createJoinRequest — uq_bjr_pending 부분 유니크 인덱스를 시뮬레이션(동시 복수 PENDING 차단)
  if (s.startsWith('INSERT INTO binder_join_requests')) {
    const [id, binderId, requesterId] = params;
    const dupe = Object.values(db.binder_join_requests).find(
      (r) => r.binder_id === binderId && r.requester_id === requesterId && r.status === 'PENDING'
    );
    if (dupe) {
      const err = new Error('duplicate key value violates unique constraint "uq_bjr_pending"');
      err.code = '23505';
      err.constraint = 'uq_bjr_pending';
      throw err;
    }
    const row = {
      id, binder_id: binderId, requester_id: requesterId, status: 'PENDING',
      decided_by: null, decided_at: null,
      expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      created_at: NOW, updated_at: NOW,
    };
    db.binder_join_requests[id] = row;
    return { rows: [row] };
  }

  // getJoinRequestForUpdate
  if (s.startsWith('SELECT id, binder_id, requester_id, status, expires_at FROM binder_join_requests')) {
    const [requestId, binderId] = params;
    const row = db.binder_join_requests[requestId];
    if (!row || row.binder_id !== binderId) return { rows: [] };
    return { rows: [row] };
  }

  // getJoinRequests — COUNT(*)
  if (s.startsWith('SELECT COUNT(*) AS count FROM binder_join_requests')) {
    const binderId = params[0];
    const status = s.includes('bjr.status = $2') ? params[1] : undefined;
    return { rows: [{ count: String(filterJoinRequests(binderId, status).length) }] };
  }

  // getJoinRequests — 목록
  if (s.startsWith('SELECT bjr.id, bjr.requester_id')) {
    const binderId = params[0];
    const hasStatus = s.includes('bjr.status = $2');
    const status = hasStatus ? params[1] : undefined;
    const limit = hasStatus ? params[2] : params[1];
    const offset = hasStatus ? params[3] : params[2];
    const rows = filterJoinRequests(binderId, status)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(offset, offset + limit)
      .map((r) => ({
        id: r.id, requester_id: r.requester_id, status: r.status,
        created_at: r.created_at, expires_at: r.expires_at,
        decided_by: r.decided_by, decided_at: r.decided_at, display_name: null,
      }));
    return { rows };
  }

  // decideJoinRequest — approve|reject|block
  if (s.startsWith('UPDATE binder_join_requests')) {
    const [status, deciderId, requestId] = params;
    const row = db.binder_join_requests[requestId];
    if (row) {
      row.status = status;
      row.decided_by = deciderId;
      row.decided_at = NOW;
      row.updated_at = NOW;
    }
    return { rows: row ? [row] : [] };
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
    const result = await fn();
    pass++;
    return result;
  } catch (err) {
    fail++;
    failures.push(`${desc}: 정상 통과를 기대했지만 에러 — ${err.statusCode || ''} ${err.message}`);
    return undefined;
  }
}

function check(desc, condition) {
  if (condition) {
    pass++;
  } else {
    fail++;
    failures.push(`${desc}: 단언 실패`);
  }
}

async function run() {
  // ① 승인제 신청 → PENDING 행 생성, binder_members는 무변경(정식 멤버 아님)
  const req1 = await expectOk('requestBinderJoin(승인제) 자체는 성공', () => BinderService.requestBinderJoin('bA', 'applicant1', 'dev1'));
  check('① requestBinderJoin은 binder_join_requests에 PENDING 행을 만든다', req1 && req1.status === 'PENDING');
  check('① applicant1은 binder_members에 전혀 나타나지 않는다(무변경)', db.binder_members['bA:applicant1'] === undefined);
  await expectStatus('신청 직후 applicant1은 정식 멤버 아님(getBinderMembers)', () => BinderService.getBinderMembers('bA', 'applicant1'), 403);

  // ② 대기 상태로 바인더 조회·검색 차단
  await expectStatus('대기 상태 getBinder 차단(비공개 바인더)', () => BinderService.getBinder('bA', 'applicant1'), 403);
  await expectStatus('대기 상태 search 차단', () => BinderService.search('bA', { q: 'test' }, 'applicant1'), 403);

  // pending 신청자가 관리자 권한을 전혀 가지지 못함(승인 전에 먼저 검증 — 승인 후엔 role이 바뀌어 의미 없음)
  await expectStatus('pending 신청자는 getJoinRequests(관리자 전용) 통과 못함', () => BinderService.getJoinRequests('bA', 'applicant1'), 403);
  await expectStatus('pending 신청자는 decideJoinRequest 요청자 권한도 통과 못함', () => BinderService.decideJoinRequest('bA', req1.id, 'approve', 'applicant1'), 403);

  // ③ 승인 후 접근 가능 + decided_by·decided_at 기록
  const approved = await expectOk('관리자(masterA)의 decideJoinRequest(approve)', () => BinderService.decideJoinRequest('bA', req1.id, 'approve', 'masterA'));
  check('③ 승인 결과 status=APPROVED', approved && approved.status === 'APPROVED');
  check('③ 승인 결과 decided_by=masterA 기록', approved && approved.decided_by === 'masterA');
  check('③ 승인 결과 decided_at 기록', approved && approved.decided_at != null);
  await expectOk('승인 후 applicant1은 정식 멤버(getBinderMembers 통과)', () => BinderService.getBinderMembers('bA', 'applicant1'));

  // ④ 거절 후 차단 유지 + decided_by·decided_at 기록
  const req2 = await expectOk('requestBinderJoin(applicant2)', () => BinderService.requestBinderJoin('bA', 'applicant2', 'dev2'));
  const rejected = await expectOk('관리자(masterA)의 decideJoinRequest(reject)', () => BinderService.decideJoinRequest('bA', req2.id, 'reject', 'masterA'));
  check('③ 거절 결과 status=REJECTED', rejected && rejected.status === 'REJECTED');
  check('③ 거절 결과 decided_by=masterA 기록', rejected && rejected.decided_by === 'masterA');
  await expectStatus('거절 후 applicant2는 여전히 비멤버', () => BinderService.getBinderMembers('bA', 'applicant2'), 403);

  // ⑤ 공개(require_approval=false) 바인더는 종전과 동일하게 즉시 가입
  const immediate = await expectOk('requestBinderJoin(공개 바인더)', () => BinderService.requestBinderJoin('bB', 'newuserB', 'dev3'));
  check('공개 바인더 즉시가입은 join_request 행을 만들지 않는다(null 반환)', immediate == null);
  await expectOk('공개 바인더는 신청 즉시 정식 멤버', () => BinderService.getBinderMembers('bB', 'newuserB'));

  // ── 중복 신청·재신청이 500이 아니라 명시적 4xx인지 ──────────────────
  // ALREADY_MEMBER는 api.md:464-468에 따라 400(이전엔 409로 오검증했었다).
  await expectStatus('이미 정식 멤버(applicant1)의 재신청은 400(ALREADY_MEMBER)', () => BinderService.requestBinderJoin('bA', 'applicant1', 'dev1'), 400);
  const req3 = await expectOk('거절 이력(applicant2)의 재신청은 새 PENDING으로 성공', () => BinderService.requestBinderJoin('bA', 'applicant2', 'dev2'));
  check('재신청은 별도 신규 행(req2와 다른 id)', req3 && req3.id !== req2.id);

  // ② 동시 복수 PENDING이 DB(uq_bjr_pending 시뮬레이션) 레벨에서 불가
  await expectStatus('② 이미 대기 중(applicant2)인데 또 신청하면 409(ALREADY_REQUESTED, 500 아님)', () => BinderService.requestBinderJoin('bA', 'applicant2', 'dev2'), 409);
  await expectStatus('재신청 후에도 정식 멤버는 아님', () => BinderService.getBinderMembers('bA', 'applicant2'), 403);

  // ④ BLOCKED 유저의 재신청은 거부된다
  const req4 = await expectOk('requestBinderJoin(applicant3)', () => BinderService.requestBinderJoin('bA', 'applicant3', 'dev4'));
  const blocked = await expectOk('관리자(masterA)의 decideJoinRequest(block)', () => BinderService.decideJoinRequest('bA', req4.id, 'block', 'masterA'));
  check('④ 차단 결과 status=BLOCKED', blocked && blocked.status === 'BLOCKED');
  await expectStatus('④ 차단된 applicant3의 재신청은 403(BLOCKED)', () => BinderService.requestBinderJoin('bA', 'applicant3', 'dev4'), 403);

  // 이미 처리된(APPROVED) 신청을 다시 decide하면 409 — PENDING이 아닌 행에 대한 재처리 방지
  await expectStatus('이미 승인된 신청을 다시 decide하면 409(ALREADY_DECIDED)', () => BinderService.decideJoinRequest('bA', req1.id, 'reject', 'masterA'), 409);

  // ⑤ 만료된 PENDING은 조회에서 제외된다(design_intent.md:236 — 조회 시점 판정, 배치 없음)
  setJoinRequest('bA', 'applicant4', 'PENDING', { expiresAt: PAST });
  const list = await expectOk('관리자(masterA)의 getJoinRequests(전체)', () => BinderService.getJoinRequests('bA', 'masterA'));
  check('⑤ 만료된 PENDING은 목록에 나타나지 않는다', list && !list.requests.some((r) => r.requester.id === 'applicant4'));
  const pendingList = await expectOk('관리자(masterA)의 getJoinRequests(status=PENDING)', () => BinderService.getJoinRequests('bA', 'masterA', { status: 'PENDING' }));
  check('⑤ status=PENDING 필터에서도 만료 PENDING은 제외된다', pendingList && !pendingList.requests.some((r) => r.requester.id === 'applicant4'));
  check('⑤ total도 만료 PENDING을 세지 않는다', pendingList && pendingList.total === pendingList.requests.length);

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
