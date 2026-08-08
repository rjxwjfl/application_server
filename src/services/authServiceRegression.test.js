/**
 * src/services/authServiceRegression.test.js
 * =========================================
 * RLY-20260806-208 — authService.js는 이 저장소에서 어떤 회귀 테스트에도 걸리지 않던
 * 파일이었다(RLY-20260806-199 실측). "인증이 가장 위험하다 — 여기가 틀리면 다른 모든
 * 인가가 무의미해진다"는 전제로 최우선 착수한다.
 *
 * docs/user/SC-auth.md와 대조해 문서가 명시적으로 규정하는 것만 단언한다(코드가 하는
 * 것을 그대로 굳히지 않는다):
 *   - getMe: 소프트 삭제(영구 차단)된 사용자는 null을 반환한다(§1-4 "영구 차단" ·
 *     E2 — UserDAO.findByUid가 deleted_at IS NULL로 걸러 신규 가입처럼 보이게 위장한다)
 *   - register: setCustomUserClaims 실패 시 가입을 롤백하고 503/CLAIM_ISSUANCE_FAILED를
 *     던진다(§1-3 표 · 1-4 다이어그램의 Resp503 경로 — silent failure 차단이 이 스펙의
 *     핵심 설계 의도다)
 *   - register: 이미 가입된 이메일은 거부한다(E8 "서버는 원본 정보 반환 또는
 *     ConflictException" 중 후자 — 현재 코드가 택한 쪽)
 *   - reactivate: inactive(status=1) 사용자를 active로 복귀시킨다(E1 · §16-2 happy path)
 *
 * ⚠️ RLY-20260806-212 갱신 — 208에서 발견한 결함("reactivate가 status·deleted_at 어느
 * 쪽에도 WHERE 가드가 없어, 유효한 Firebase 토큰만 있으면 소프트 삭제(자진 탈퇴·영구
 * 차단)된 계정도 되살릴 수 있었다")을 여기서 고쳤다. §16-6("자진 탈퇴도 30일 내 복원
 * 미지원 — V2 이관, 신규 user_id로만 재가입")과 §1-4("자진 탈퇴·영구 차단은 같은
 * deleted_at 컬럼을 공유, 구분은 audit_log에서")를 근거로 **deleted_at이 설정된 계정은
 * 자진 탈퇴든 영구 차단이든 이 메서드로 되살아나면 안 된다**고 판정했다 — 둘을 가르는
 * 컬럼이 없으므로 새 컬럼을 만들지 않고, UserDAO.reactivate가 deleted_at 자체를 더 이상
 * 건드리지 않게 하고(SET에서 제거) WHERE에 status=1(휴면)·deleted_at IS NULL을 요구한다.
 * 막힌 경우(활성·소프트 삭제·미가입 전부)는 이유를 가리지 않고 하나의 404로 접는다
 * (specialDayService.getById의 F-S8a 존재 오라클 방어와 같은 패턴) — 아래 ⑦b·⑦c·⑦d가
 * 이 셋을 모두 검증한다.
 *
 * mock이 실제로 무엇을 검증하는지 확인(RLY-20260806-135 교훈 — SQL 텍스트와 무관하게
 * 항상 통과하는 mock은 아무것도 증명하지 않는다) — ②·④·⑦은 프로덕션 코드를 임시로
 * 되돌려(cp 백업 + 복원) 이 테스트가 실제로 실패하는지 확인했다(구현 보고서 참조).
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`. config/db·utils/firebase를
 * 가짜로 교체(sendAlertTwoChannelRegression.test.js와 동일 패턴).
 *
 * 실행: node src/services/authServiceRegression.test.js
 */

process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test';
process.env.PGDATABASE = process.env.PGDATABASE || 'test';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test';

const dbPath = require.resolve('../../config/db');
const firebasePath = require.resolve('../utils/firebase');
const NOW = new Date().toISOString();

// ── 가짜 Firebase Admin — admin.auth().setCustomUserClaims만 이 파일의 관심사다 ──────
let claimCalls = [];
let claimShouldFail = false;
const fakeAdmin = {
  auth: () => ({
    setCustomUserClaims: async (uid, claims) => {
      claimCalls.push({ uid, claims });
      if (claimShouldFail) throw new Error('[fake] setCustomUserClaims 실패(시뮬레이션)');
    },
    verifyIdToken: async () => { throw new Error('[fake] 이 파일은 verifyIdToken을 쓰지 않는다'); },
  }),
};
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: { admin: fakeAdmin, verifyIdToken: async () => { throw new Error('unused'); } },
};

// ── 픽스처 ──────────────────────────────────────────────────────────────
// uid-active: 정상 활성 사용자. uid-inactive: 휴면(status=1). uid-deleted: 소프트
// 삭제(영구 차단 — deleted_at 설정, §1-4). uid-new: users에 아예 없는 신규 가입자.
const usersByUid = {
  'uid-active':   { id: 'u-active',   firebase_uid: 'uid-active',   email: 'active@x.com',   provider: 'google', status: 0, deleted_at: null },
  'uid-inactive': { id: 'u-inactive', firebase_uid: 'uid-inactive', email: 'inactive@x.com', provider: 'google', status: 1, deleted_at: null },
  'uid-deleted':  { id: 'u-deleted',  firebase_uid: 'uid-deleted',  email: 'deleted@x.com',  provider: 'google', status: 0, deleted_at: NOW },
};
const infosByUserId = {
  'u-active':   { user_code: 'U0001', display_name: 'Active', bio: null, image_url: null, thumbnail_url: null },
  'u-inactive': { user_code: 'U0002', display_name: 'Inactive', bio: null, image_url: null, thumbnail_url: null },
  'u-deleted':  { user_code: 'U0003', display_name: 'Deleted', bio: null, image_url: null, thumbnail_url: null },
};
const settingsByUserId = {
  'u-active':   { language_code: 'ko', timezone: 'UTC' },
  'u-inactive': { language_code: 'ko', timezone: 'UTC' },
};

let insertedUsers = [];
let insertedInfos = [];
let insertedSettings = [];
let insertedDevices = [];
// RLY-20260806-229 — 가입 트랜잭션이 만드는 기본 바인더
let insertedBinders = [];
let insertedMembers = [];
let insertedSections = [];
let cleanupCalls = [];
let deactivateDeviceCalls = [];
let updateLastActivityCalls = [];
let reactivateCalls = [];

function reset() {
  claimCalls = []; claimShouldFail = false;
  insertedUsers = []; insertedInfos = []; insertedSettings = []; insertedDevices = [];
  cleanupCalls = []; deactivateDeviceCalls = []; updateLastActivityCalls = []; reactivateCalls = [];
  insertedBinders = []; insertedMembers = []; insertedSections = [];
}

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();

  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // UserDAO.findByUid — ⚠️ deleted_at IS NULL 필터가 §1-4의 "영구 차단 위장" 핵심.
  if (s.startsWith('SELECT') && s.includes('FROM users u') && s.includes('firebase_uid = $1') && s.includes('deleted_at IS NULL')) {
    const row = usersByUid[params[0]];
    if (!row || row.deleted_at) return { rows: [] }; // 소프트 삭제된 행은 여기서 걸러진다
    const info = infosByUserId[row.id] || {};
    return { rows: [{ id: row.id, status: row.status, ...info, created_at: NOW, updated_at: NOW, deleted_at: row.deleted_at }] };
  }
  // UserDAO.updateLastActivity
  if (s.startsWith('UPDATE users') && s.includes('latest_activity_at = NOW()') && s.includes('firebase_uid = $1')) {
    updateLastActivityCalls.push(params[0]);
    return { rows: [] };
  }
  // UserSettingsDAO.get
  if (s.startsWith('SELECT language_code') && s.includes('FROM user_settings')) {
    const row = settingsByUserId[params[0]];
    return { rows: row ? [row] : [] };
  }
  // UserDAO.findByEmail
  if (s.startsWith('SELECT') && s.includes('FROM users u') && s.includes('u.email = $1')) {
    const [email] = params;
    const row = Object.values(usersByUid).find((u) => u.email === email && !u.deleted_at);
    return { rows: row ? [{ ...row }] : [] };
  }
  // UserDAO.create — users INSERT
  if (s.startsWith('INSERT INTO users') && s.includes('RETURNING id, firebase_uid, email, provider, status')) {
    const [id, uid, email, provider, status] = params;
    const row = { id, firebase_uid: uid, email, provider, status: status || 0, created_at: NOW, updated_at: NOW, latest_activity_at: NOW };
    insertedUsers.push(row);
    return { rows: [row] };
  }
  // UserDAO.create — user_infos INSERT
  if (s.startsWith('INSERT INTO user_infos') && s.includes('RETURNING user_code, display_name')) {
    const [user_id, user_code, display_name, bio, image_url, thumbnail_url] = params;
    const row = { user_code, display_name, bio, image_url, thumbnail_url };
    insertedInfos.push({ user_id, ...row });
    return { rows: [row] };
  }
  // UserSettingsDAO.createDefault
  if (s.startsWith('INSERT INTO user_settings')) {
    insertedSettings.push(params[0]);
    return { rows: [{ user_id: params[0], language_code: 'ko' }] };
  }
  // UserDAO.createDevice
  if (s.startsWith('INSERT INTO user_devices')) {
    insertedDevices.push(params);
    return { rows: [{ id: params[0], user_id: params[1], device_uuid: params[2] }] };
  }
  // ⚠️ RLY-20260806-229 — register가 같은 트랜잭션에서 기본 바인더를 만든다
  // (BinderService.createBinderTx). 아래 5개 INSERT가 그 흐름이며, 하나라도 사라지면
  // 클라 `BinderCreateResponse` 파싱이 깨진다 — 그래서 각각을 기록해 아래에서 단언한다.
  if (s.startsWith('INSERT INTO binders')) {
    insertedBinders.push({ id: params[0], name: params[1] });
    return { rows: [{ id: params[0], name: params[1], description: null, image_url: null, thumbnail_url: null, member_count: 1, last_activity_at: NOW, created_at: NOW, updated_at: NOW, deleted_at: null }] };
  }
  if (s.startsWith('INSERT INTO binder_settings')) {
    return { rows: [{ binder_id: params[0], is_public: false, is_searchable: false, require_approval: false, updated_at: NOW }] };
  }
  if (s.startsWith('INSERT INTO binder_members')) {
    insertedMembers.push({ binder_id: params[0], user_id: params[1], role: params[2] });
    return { rows: [{ binder_id: params[0], user_id: params[1], role: params[2], joined_at: NOW, created_at: NOW, updated_at: NOW }] };
  }
  if (s.startsWith('INSERT INTO calendars')) {
    return { rows: [{ id: params[0], binder_id: params[1], title: params[2], created_at: NOW, updated_at: NOW }] };
  }
  if (s.startsWith('INSERT INTO sections')) {
    insertedSections.push({ id: params[0], binder_id: params[1], is_default: params[4] });
    return { rows: [{ id: params[0], binder_id: params[1], title: params[2], access_scope: params[3], is_default: params[4], created_at: NOW, updated_at: NOW }] };
  }
  // UserDAO.cleanupFailedRegistration — user 4개 DELETE + ⚠️ 229 이후 binder 5개 DELETE.
  // 바인더 쪽이 빠지면 FK 위반으로 DELETE FROM users가 실패해 롤백 자체가 깨진다.
  if (s.startsWith('DELETE FROM user_devices') || s.startsWith('DELETE FROM user_settings')
    || s.startsWith('DELETE FROM user_infos') || s.startsWith('DELETE FROM users')
    || s.startsWith('DELETE FROM sections') || s.startsWith('DELETE FROM calendars')
    || s.startsWith('DELETE FROM binder_settings') || s.startsWith('DELETE FROM binder_members')
    || s.startsWith('DELETE FROM binders')) {
    cleanupCalls.push({ sql: s, userId: params[0] });
    return { rowCount: 1 };
  }
  // UserDAO.deactivateDevice
  if (s.startsWith('UPDATE user_devices') && s.includes('is_active = FALSE')) {
    deactivateDeviceCalls.push({ userId: params[0], deviceUuid: params[1] });
    return { rowCount: 1 };
  }
  // UserDAO.listDevices
  if (s.startsWith('SELECT id, device_uuid') && s.includes('FROM user_devices')) {
    return { rows: [] };
  }
  // UserDAO.reactivate — ⚠️ RLY-20260806-212: WHERE에 status=1·deleted_at IS NULL을 둘 다
  // 요구한다(SQL 텍스트로 확인 — 이 절이 사라지면 아래 브랜치가 매칭되지 않아 "Unhandled
  // query"로 실패한다, RLY-20260806-135 교훈). SET에서 deleted_at은 더 이상 건드리지 않는다.
  if (s.startsWith('UPDATE users') && s.includes('SET status = 0') && s.includes('WHERE firebase_uid = $1 AND status = 1 AND deleted_at IS NULL')) {
    const row = usersByUid[params[0]];
    if (!row || row.status !== 1 || row.deleted_at) return { rows: [] }; // 가드에 안 걸리면 0 rows(실제 UPDATE ... WHERE와 동일)
    reactivateCalls.push(params[0]);
    row.status = 0;
    return { rows: [{ id: row.id, firebase_uid: row.firebase_uid, email: row.email, provider: row.provider, status: row.status, created_at: NOW, updated_at: NOW }] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const authService = require('./authService');
const eventBus = require('../events/eventBus');

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond, detail) { if (cond) pass++; else { fail++; failures.push(detail ? `${desc}: ${detail}` : desc); } }

async function expectRejected(desc, fn, { statusCode, errorCode } = {}) {
  try {
    await fn();
    fail++;
    failures.push(`${desc}: 거부를 기대했지만 통과해버림`);
  } catch (err) {
    const statusOk = statusCode === undefined || err.statusCode === statusCode;
    const codeOk = errorCode === undefined || err.errorCode === errorCode;
    if (statusOk && codeOk) pass++;
    else { fail++; failures.push(`${desc}: 예상 status=${statusCode} code=${errorCode}, 실제 status=${err.statusCode} code=${err.errorCode} msg=${err.message}`); }
  }
}

async function run() {
  // ============ ① getMe — 활성 사용자, {user, settings, status} 반환 + updateLastActivity 호출 ============
  reset();
  {
    const result = await authService.getMe('uid-active');
    check('① getMe가 활성 사용자를 반환한다', !!result && result.status === 0, `실제=${JSON.stringify(result)}`);
    check('① status가 user 객체 밖으로 분리돼 있다(user에 status 없음)', result && result.user && result.user.status === undefined);
    check('① settings가 함께 반환된다', result && result.settings && result.settings.language_code === 'ko');
    check('① updateLastActivity가 호출된다', updateLastActivityCalls.includes('uid-active'));
  }

  // ============ ② getMe — 소프트 삭제(영구 차단)된 사용자는 null(§1-4·E2, 핵심) ============
  reset();
  {
    const result = await authService.getMe('uid-deleted');
    check('② 소프트 삭제된 사용자는 getMe가 null을 반환한다(존재를 위장)', result === null, `실제=${JSON.stringify(result)}`);
  }

  // ============ ③ getMe — 미가입 사용자도 null(신규 가입 유도, H1·E9) ============
  reset();
  {
    const result = await authService.getMe('uid-new');
    check('③ 미가입 사용자도 null(신규 가입과 동일하게 보인다)', result === null);
  }

  // ============ ④ register — 정상 가입: INSERT 3종 + claim 발급 + user:registered emit ============
  reset();
  {
    let emitted = null;
    const onRegistered = (payload) => { emitted = payload; };
    eventBus.on('user:registered', onRegistered);
    // RLY-20260806-229 — createBinder 경로와 같은 이벤트를 가입 경로에서도 낸다.
    let joined = null;
    const onJoined = (payload) => { joined = payload; };
    eventBus.on('member:joined', onJoined);
    try {
      const result = await authService.register(
        { uid: 'uid-new', email: 'new@x.com', name: 'New User', firebase: { sign_in_provider: 'google' } },
        { device_info: { device_uuid: 'dev-1', device_type: 'ios' } }
      );
      check('④ user 반환', !!result.user);
      check('④ users INSERT 1건', insertedUsers.length === 1 && insertedUsers[0].email === 'new@x.com');
      check('④ user_infos INSERT 1건', insertedInfos.length === 1);
      check('④ user_settings INSERT 1건(기본 설정)', insertedSettings.length === 1);
      check('④ device_info이 있으면 user_devices도 INSERT된다', insertedDevices.length === 1);
      check('④ setCustomUserClaims가 db_user_id로 호출된다', claimCalls.length === 1 && claimCalls[0].uid === 'uid-new' && !!claimCalls[0].claims.db_user_id);
      check("④ eventBus.emit('user:registered')가 발생한다", !!emitted && emitted.provider === 'google');
      check('④ cleanupFailedRegistration은 호출되지 않는다(성공 경로)', cleanupCalls.length === 0);

      // ⚠️ RLY-20260806-229 — 이 블록이 없어서 가입 직후 첫 실행이 반드시 에러로 끝났다.
      // 클라 `auth_repository.userInitialize`는 응답에 binder가 없으면 예외를 던지는데
      // (auth_repository.dart:330) 서버는 {user, settings}만 돌려주고 있었다.
      // ⚠️ "user가 반환된다"만 보면 이 결함을 못 본다 — 가입 자체는 성공했기 때문이다.
      check('④ ⚠️ register 응답에 binder가 포함된다(없으면 클라 첫 실행이 예외로 끝난다)', !!result.binder);
      // ⚠️ 형태 전체가 계약이다 — 클라 BinderCreateResponse의 6개 필드는 전부 required라
      // 하나만 빠져도 파싱 단계에서 터진다. 존재만 보지 않고 필드를 열어서 확인한다.
      check('④ ⚠️ binder 응답이 BinderCreateResponse 6개 필드를 모두 갖춘다',
        !!result.binder && ['binder', 'settings', 'calendar', 'section', 'members', 'preferences']
          .every((k) => result.binder[k] !== undefined && result.binder[k] !== null),
        `실제 키=${result.binder ? JSON.stringify(Object.keys(result.binder)) : 'null'}`);
      check('④ 기본 바인더가 같은 트랜잭션에서 1건 생성된다', insertedBinders.length === 1);
      check('④ 가입자가 그 바인더의 master(role 0)로 들어간다',
        insertedMembers.length === 1 && insertedMembers[0].user_id === insertedUsers[0].id && insertedMembers[0].role === 0,
        `실제=${JSON.stringify(insertedMembers)}`);
      // RLY-20260806-087 — 바인더당 유일한 is_default=true INSERT 지점(삭제 차단·마지막 섹션 보호가 이 플래그에 의존).
      check('④ 기본 섹션이 is_default=true로 함께 생성된다',
        insertedSections.length === 1 && insertedSections[0].is_default === true,
        `실제=${JSON.stringify(insertedSections)}`);
      check("④ eventBus.emit('member:joined')가 가입 바인더에 대해서도 발생한다",
        !!joined && joined.binder_id === insertedBinders[0].id && joined.user_id === insertedUsers[0].id,
        `실제=${JSON.stringify(joined)}`);
    } finally {
      eventBus.off('user:registered', onRegistered);
      eventBus.off('member:joined', onJoined);
    }
  }

  // ============ ⑤ register — 이미 가입된 이메일은 거부(E8 "또는 ConflictException") ============
  reset();
  await expectRejected(
    '⑤ 이미 가입된 이메일은 ConflictError',
    () => authService.register({ uid: 'uid-dup', email: 'active@x.com', name: 'Dup' }, {}),
    { statusCode: 409 }
  );

  // ============ ⑥ register — setCustomUserClaims 실패 시 가입 롤백 + 503(§1-3·1-4 다이어그램의 핵심 설계) ============
  reset();
  claimShouldFail = true;
  await expectRejected(
    '⑥ claim 발급 실패 시 503/CLAIM_ISSUANCE_FAILED',
    () => authService.register({ uid: 'uid-claimfail', email: 'claimfail@x.com', name: 'ClaimFail' }, {}),
    { statusCode: 503, errorCode: 'CLAIM_ISSUANCE_FAILED' }
  );
  check('⑥ users INSERT는 됐다가(가입 시도 자체는 성공)', insertedUsers.length === 1 && insertedUsers[0].email === 'claimfail@x.com');
  // ⚠️ RLY-20260806-229 — 4개에서 9개로 늘었다. register가 같은 트랜잭션에서 기본 바인더를
  // 만들게 되면서 롤백도 그만큼 넓어져야 한다. 바인더 쪽 5개가 빠지면 FK ON DELETE CASCADE가
  // 없어 `DELETE FROM users`가 FK 위반으로 실패하고, "롤백도 실패" 경로로 떨어져 반쯤
  // 만들어진 계정이 남는다 — 되돌리기가 아니라 수동 정리 대상이 된다.
  check('⑥ cleanupFailedRegistration이 9개 테이블 모두에 대해 호출된다(hard delete 롤백)',
    cleanupCalls.length === 9
      && ['sections', 'calendars', 'binder_settings', 'binder_members', 'binders',
        'user_devices', 'user_settings', 'user_infos', 'users']
        .every((t) => cleanupCalls.some((c) => c.sql.includes(`DELETE FROM ${t} `))),
    `실제=${JSON.stringify(cleanupCalls.map((c) => c.sql))}`);
  // ⚠️ 순서가 계약이다 — 자식이 부모보다 먼저 지워져야 FK 위반이 안 난다.
  check('⑥ 자식 → 부모 순으로 지운다(binders는 그 자식들 뒤, users는 맨 뒤)',
    (() => {
      const at = (t) => cleanupCalls.findIndex((c) => c.sql.includes(`DELETE FROM ${t} `));
      return ['sections', 'calendars', 'binder_settings', 'binder_members'].every((t) => at(t) < at('binders'))
        && ['user_devices', 'user_settings', 'user_infos'].every((t) => at(t) < at('users'))
        && at('binder_members') < at('users');
    })(),
    `실제=${JSON.stringify(cleanupCalls.map((c) => c.sql))}`);
  check('⑥ 사용자 쪽 DELETE는 새로 만든 user.id를 대상으로 한다(다른 사용자 오염 아님)',
    cleanupCalls.filter((c) => c.sql.includes('WHERE user_id = $1') || c.sql.includes('FROM users '))
      .every((c) => c.userId === insertedUsers[0].id));
  check('⑥ 바인더 쪽 DELETE는 이번에 만든 binder.id를 대상으로 한다',
    insertedBinders.length === 1
      && cleanupCalls.filter((c) => c.sql.includes('WHERE binder_id = $1') || c.sql.includes('FROM binders '))
        .every((c) => c.userId === insertedBinders[0].id));

  // ============ ⑦a reactivate — inactive(status=1) 사용자를 active로 복귀(E1 happy path) ============
  reset();
  {
    const result = await authService.reactivate('uid-inactive', {});
    check('⑦a reactivate 후 status=0(active)', result && result.status === 0, `실제=${JSON.stringify(result)}`);
    check('⑦a reactivate가 실제 DAO를 호출했다', reactivateCalls.includes('uid-inactive'));
    usersByUid['uid-inactive'].status = 1; // 다음 시나리오를 위해 원복(픽스처는 mutable)
  }

  // ============ ⑦b reactivate — 소프트 삭제(자진 탈퇴·영구 차단)된 계정은 거부(핵심 보안 수정) ============
  // §16-6: 자진 탈퇴도 30일 내 복원 미지원(V2). §1-4: 영구 차단도 같은 deleted_at을 쓴다 —
  // 유효한 Firebase 토큰 하나로 스스로 차단을 풀 수 있던 구멍(RLY-20260806-208 발견)이 막혔는지 확인.
  reset();
  await expectRejected('⑦b 소프트 삭제된 계정의 reactivate는 거부된다(404 — 이유를 밝히지 않는다)',
    () => authService.reactivate('uid-deleted', {}), { statusCode: 404 });
  check('⑦b 소프트 삭제된 계정은 실제로 되살아나지 않는다(deleted_at 유지)', !!usersByUid['uid-deleted'].deleted_at);
  check('⑦b DAO가 실제로 이 계정을 갱신하지 않았다', !reactivateCalls.includes('uid-deleted'));

  // ============ ⑦c reactivate — 이미 active인 계정도 거부(휴면이 아니므로 해당 없음) ============
  reset();
  await expectRejected('⑦c 이미 active인 계정의 reactivate는 거부된다(404)',
    () => authService.reactivate('uid-active', {}), { statusCode: 404 });

  // ============ ⑦d reactivate — 존재하지 않는 uid도 같은 404(존재 여부를 흘리지 않는다) ============
  reset();
  await expectRejected('⑦d 존재하지 않는 uid도 ⑦b·⑦c와 같은 404',
    () => authService.reactivate('uid-does-not-exist', {}), { statusCode: 404 });

  // ============ ⑧ logout — deviceUuid 있으면 deactivateDevice, 미가입 사용자는 조용히 종료(예외 없음) ============
  reset();
  {
    await authService.logout('uid-active', 'dev-1');
    check('⑧ logout이 deactivateDevice를 호출한다', deactivateDeviceCalls.length === 1 && deactivateDeviceCalls[0].deviceUuid === 'dev-1');
  }
  reset();
  {
    let threw = false;
    try { await authService.logout('uid-not-registered', 'dev-1'); } catch { threw = true; }
    check('⑧ 미가입 사용자의 logout은 예외를 던지지 않는다(조용히 종료)', !threw);
    check('⑧ 미가입 사용자면 deactivateDevice를 호출하지 않는다', deactivateDeviceCalls.length === 0);
  }

  // ============ ⑨ removeDevice — 미가입 사용자는 false(크래시·사용자 열거 없음) ============
  reset();
  {
    const result = await authService.removeDevice('uid-not-registered', 'dev-1');
    check('⑨ 미가입 사용자의 removeDevice는 false(예외 아님)', result === false);
  }

  console.log(`\n[authServiceRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[authServiceRegression] 실행 실패:', error);
  process.exitCode = 1;
});
