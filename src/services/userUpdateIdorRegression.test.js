/**
 * src/services/userUpdateIdorRegression.test.js
 * =========================================
 * RLY-20260806-054 — PATCH /users/:id(userService.updateUserById)가 req.params.id를
 * 인증 신원(req.user_id)과 대조하지 않아, 로그인한 아무나 타인의 display_name·bio를
 * 바꿀 수 있었던 IDOR의 회귀.
 *
 * 이 저장소엔 테스트 프레임워크가 없다(authzRegression.test.js와 동일 관행) — plain assert +
 * `node <file>.js` 직접 실행, 가짜 DB connection으로 실제 서비스 코드를 구동한다.
 *
 * 실행: node src/services/userUpdateIdorRegression.test.js
 *
 * 결함 요약(수리 전): userService.updateUserById(userId, updateData) — 세 번째 인자(요청자
 * 신원)가 아예 없어 어떤 조건도 걸 수 없었다. userController.updateUser가 req.params.id를
 * 그대로 넘겼다.
 */

const assert = require('assert');

const dbPath = require.resolve('../../config/db');
const NOW = new Date().toISOString();

const db = {
  user_infos: {
    self1: { user_id: 'self1', user_code: 'U0001', display_name: 'self-old', bio: 'self-bio-old', image_url: null, thumbnail_url: null },
    victim1: { user_id: 'victim1', user_code: 'U0002', display_name: 'victim-old', bio: 'victim-bio-old', image_url: null, thumbnail_url: null },
  },
};

const queryLog = [];

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  queryLog.push({ sql: s, params });

  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // UserDAO.updateById — user_infos 테이블 부분 (COALESCE 그대로 흉내)
  if (s.startsWith('UPDATE user_infos') && s.includes('WHERE user_id = $5')) {
    const [display_name, bio, image_url, thumbnail_url, userId] = params;
    const row = db.user_infos[userId];
    if (!row) return { rows: [] };
    row.display_name = display_name ?? row.display_name;
    row.bio = bio ?? row.bio;
    row.image_url = image_url ?? row.image_url;
    row.thumbnail_url = thumbnail_url ?? row.thumbnail_url;
    return { rows: [{ user_code: row.user_code, display_name: row.display_name, bio: row.bio, image_url: row.image_url, thumbnail_url: row.thumbnail_url }] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const mockDb = {
  query: mockQuery,
  connect: async () => ({ query: mockQuery, release() {} }),
};

require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

// ── 실제 서비스 로드(가짜 DB가 주입된 뒤) ─────────────────────────────────
const userService = require('./userService');

let pass = 0;
let fail = 0;
const failures = [];

async function expectRejected(desc, fn, { statusCode, errorCode } = {}) {
  try {
    await fn();
    fail++;
    failures.push(`${desc}: 거부를 기대했지만 통과해버림`);
  } catch (err) {
    const statusOk = statusCode === undefined || err.statusCode === statusCode;
    const codeOk = errorCode === undefined || err.errorCode === errorCode;
    if (statusOk && codeOk) {
      pass++;
    } else {
      fail++;
      failures.push(`${desc}: 예상 status=${statusCode} code=${errorCode}, 실제 status=${err.statusCode} code=${err.errorCode} msg=${err.message}`);
    }
  }
}

async function expectResolved(desc, fn, assertResult) {
  try {
    const result = await fn();
    if (assertResult) assertResult(result);
    pass++;
  } catch (err) {
    fail++;
    failures.push(`${desc}: 통과를 기대했지만 거부됨 — status=${err.statusCode} code=${err.errorCode} msg=${err.message}`);
  }
}

async function run() {
  // ============ ① 타인 id로 이름 변경 시도 → 거부(어떤 조건인지까지 단언) ============
  await expectRejected(
    '타인 id로 display_name 변경 — params.id !== 인증 신원이면 403 USER_UPDATE_FORBIDDEN',
    () => userService.updateUserById('victim1', { display_name: 'hacked' }, 'attacker1'),
    { statusCode: 403, errorCode: 'USER_UPDATE_FORBIDDEN' }
  );
  assert.strictEqual(db.user_infos.victim1.display_name, 'victim-old', '거부됐는데 실제로 DB가 바뀌면 안 된다');

  // ============ ② 타인 id로 자기소개 변경 → 거부(동일 조건) ============
  await expectRejected(
    '타인 id로 bio 변경 — params.id !== 인증 신원이면 403 USER_UPDATE_FORBIDDEN',
    () => userService.updateUserById('victim1', { bio: 'hacked-bio' }, 'attacker1'),
    { statusCode: 403, errorCode: 'USER_UPDATE_FORBIDDEN' }
  );
  assert.strictEqual(db.user_infos.victim1.bio, 'victim-bio-old', '거부됐는데 실제로 DB가 바뀌면 안 된다');

  // ============ ③ 본인 수정은 종전대로 동작 ============
  await expectResolved(
    '본인 id로 display_name·bio 변경 — params.id === 인증 신원이면 통과',
    () => userService.updateUserById('self1', { display_name: 'self-new', bio: 'self-bio-new' }, 'self1'),
    (result) => {
      assert.strictEqual(result.display_name, 'self-new');
      assert.strictEqual(result.bio, 'self-bio-new');
    }
  );
  assert.strictEqual(db.user_infos.self1.display_name, 'self-new');

  // ============ ④ 이미지 필드 검증 불변 — 인가 통과 후 여전히 서버 전용 필드 검증에 걸린다.
  // RLY-20260806-084 — 052의 assertOwnedMediaReference(INVALID_IMAGE_REFERENCE)는 폐기되고
  // assertServerOnlyImageFields(SERVER_ONLY_IMAGE_FIELD)로 대체됐다(값 자체를 안 받는 더 강한
  // 방어 — media.md §4-4 Step5). 054의 IDOR 방어 순서(요청자 대조가 먼저)는 불변이다.
  await expectRejected(
    '본인 id인데 임의 URL — 인가는 통과하지만 서버 전용 필드 검증(SERVER_ONLY_IMAGE_FIELD)에 걸린다',
    () => userService.updateUserById('self1', { image_url: 'https://evil.example.com/x.png' }, 'self1'),
    { statusCode: 400, errorCode: 'SERVER_ONLY_IMAGE_FIELD' }
  );
  await expectRejected(
    '타인 id + 임의 URL — 서버 전용 필드 검증까지 가지도 못하고 054의 403이 먼저 걸린다(방어 순서)',
    () => userService.updateUserById('victim1', { image_url: 'https://evil.example.com/x.png' }, 'attacker1'),
    { statusCode: 403, errorCode: 'USER_UPDATE_FORBIDDEN' }
  );

  console.log(`\n[userUpdateIdorRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[userUpdateIdorRegression] 실행 실패:', error);
  process.exitCode = 1;
});
