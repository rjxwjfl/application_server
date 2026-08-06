/**
 * src/services/userProfileExposureRegression.test.js
 * =========================================
 * RLY-20260806-066 — GET /users/:id · GET /users/code/:code · GET /binders/:binderId/members가
 * 조회 대상의 계정 식별·인증·활동 기록(email·firebase_uid·provider·status·latest_activity_at)을
 * 그대로 반환해, 인증된 아무나 id/코드만 알면 타인의 이 필드들을 얻을 수 있었던 과다노출의 회귀.
 *
 * 기준: 본인이 프로필로 공개한 정보(user_code·display_name·bio·image_url·thumbnail_url) +
 * 조회에 필요한 식별자(id)·시간정보(created_at·updated_at)는 누구에게나, 계정 식별·인증·
 * 활동 기록은 본인에게만.
 *
 * 이 저장소엔 테스트 프레임워크가 없다(authzRegression.test.js·userUpdateIdorRegression.test.js와
 * 동일 관행) — plain assert + `node <file>.js` 직접 실행, 가짜 DB connection으로 실제 서비스
 * 코드를 구동한다.
 *
 * 실행: node src/services/userProfileExposureRegression.test.js
 */

const assert = require('assert');

const dbPath = require.resolve('../../config/db');
const NOW = new Date().toISOString();

const db = {
  users: {
    self1: { id: 'self1', firebase_uid: 'uid-self1', email: 'self1@test.com', provider: 'google', status: 0, created_at: NOW, updated_at: NOW, latest_activity_at: NOW, deleted_at: null },
    victim1: { id: 'victim1', firebase_uid: 'uid-victim1', email: 'victim1@test.com', provider: 'apple', status: 0, created_at: NOW, updated_at: NOW, latest_activity_at: NOW, deleted_at: null },
  },
  user_infos: {
    self1: { user_id: 'self1', user_code: 'U0001', display_name: 'Self', bio: 'self-bio', image_url: null, thumbnail_url: null },
    victim1: { user_id: 'victim1', user_code: 'U0002', display_name: 'Victim', bio: 'victim-bio', image_url: null, thumbnail_url: null },
  },
  binder_members: {
    'bnd1:self1': { binder_id: 'bnd1', user_id: 'self1', role: 3, notification_level: 1, nickname_in_binder: null, joined_at: NOW, deleted_at: null },
    'bnd1:victim1': { binder_id: 'bnd1', user_id: 'victim1', role: 3, notification_level: 1, nickname_in_binder: null, joined_at: NOW, deleted_at: null },
  },
};

const queryLog = [];

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  queryLog.push({ sql: s, params });

  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // UserDAO.findById
  if (s.includes('FROM users u') && s.includes('WHERE u.id = $1 AND u.deleted_at IS NULL')) {
    const u = db.users[params[0]];
    if (!u || u.deleted_at) return { rows: [] };
    const ui = db.user_infos[params[0]] || {};
    return {
      rows: [{
        id: u.id, firebase_uid: u.firebase_uid, email: u.email, provider: u.provider, status: u.status,
        created_at: u.created_at, updated_at: u.updated_at, latest_activity_at: u.latest_activity_at,
        user_code: ui.user_code, display_name: ui.display_name, bio: ui.bio, image_url: ui.image_url, thumbnail_url: ui.thumbnail_url,
      }],
    };
  }

  // UserDAO.findByUserCode
  if (s.includes('FROM user_infos ui') && s.includes('WHERE ui.user_code = $1')) {
    const entry = Object.values(db.user_infos).find((x) => x.user_code === params[0]);
    if (!entry) return { rows: [] };
    const u = db.users[entry.user_id];
    if (!u || u.deleted_at) return { rows: [] };
    return {
      rows: [{
        id: u.id, firebase_uid: u.firebase_uid, email: u.email, status: u.status,
        created_at: u.created_at, latest_activity_at: u.latest_activity_at,
        user_code: entry.user_code, display_name: entry.display_name, bio: entry.bio, image_url: entry.image_url, thumbnail_url: entry.thumbnail_url,
      }],
    };
  }

  // UserDAO.findByUid — 이 티켓에서 손대지 않는 내부 인증 경로. 원래도 email·firebase_uid를
  // 선택하지 않는다(수리 전부터 최소 노출).
  if (s.includes('FROM users u') && s.includes('WHERE u.firebase_uid = $1')) {
    const u = Object.values(db.users).find((x) => x.firebase_uid === params[0]);
    if (!u || u.deleted_at) return { rows: [] };
    const ui = db.user_infos[u.id] || {};
    return {
      rows: [{
        id: u.id, status: u.status, user_code: ui.user_code, display_name: ui.display_name, bio: ui.bio,
        image_url: ui.image_url, thumbnail_url: ui.thumbnail_url, created_at: u.created_at, updated_at: u.updated_at, deleted_at: u.deleted_at,
      }],
    };
  }

  // BinderDAO.getMember (requireBinderMember)
  if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
    const row = db.binder_members[`${params[0]}:${params[1]}`];
    return { rows: row ? [row] : [] };
  }

  // BinderDAO.getMembers(로스터) — u.email 제거 후 `JOIN users u`도 함께 빠졌다.
  if (s.includes('FROM binder_members dm') && s.includes('LEFT JOIN user_infos ui')) {
    const rows = Object.values(db.binder_members)
      .filter((m) => m.binder_id === params[0] && !m.deleted_at && m.role >= 0)
      .map((m) => {
        const ui = db.user_infos[m.user_id] || {};
        return {
          binder_id: m.binder_id, user_id: m.user_id, role: m.role, notification_level: m.notification_level,
          nickname_in_binder: m.nickname_in_binder, joined_at: m.joined_at,
          display_name: ui.display_name, user_code: ui.user_code, image_url: ui.image_url,
        };
      });
    return { rows };
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
const { BinderService: binderService } = require('./binderService');

let pass = 0;
let fail = 0;
const failures = [];

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

const ACCOUNT_FIELDS = ['email', 'firebase_uid', 'provider', 'status', 'latest_activity_at'];

async function run() {
  // ============ ① GET /users/:id — 타인 조회: 계정 식별·인증·활동 기록이 없다 ============
  await expectResolved(
    '타인 id로 GET /users/:id — email·firebase_uid·provider·status·latest_activity_at 없음',
    () => userService.getUserById('victim1', 'self1'),
    (result) => {
      ACCOUNT_FIELDS.forEach((f) => assert.ok(!(f in result), `${f}가 없어야 한다`));
      assert.strictEqual(result.id, 'victim1');
      assert.strictEqual(result.user_code, 'U0002');
      assert.strictEqual(result.display_name, 'Victim');
      assert.strictEqual(result.bio, 'victim-bio');
    }
  );

  // ============ ② GET /users/:id — 본인 조회: 계정 식별·인증·활동 기록이 있다(불변) ============
  await expectResolved(
    '본인 id로 GET /users/:id — email·firebase_uid·provider·status·latest_activity_at 있음',
    () => userService.getUserById('self1', 'self1'),
    (result) => {
      assert.strictEqual(result.email, 'self1@test.com');
      assert.strictEqual(result.firebase_uid, 'uid-self1');
      assert.strictEqual(result.provider, 'google');
      assert.strictEqual(result.status, 0);
      assert.ok('latest_activity_at' in result);
      assert.strictEqual(result.display_name, 'Self');
    }
  );

  // ============ ③ GET /users/code/:code — 타인 조회: 계정 식별·인증·활동 기록이 없다 ============
  await expectResolved(
    '타인 코드로 GET /users/code/:code — email·firebase_uid·status·latest_activity_at 없음',
    () => userService.getUserByUserCode('U0002', 'self1'),
    (result) => {
      ['email', 'firebase_uid', 'status', 'latest_activity_at'].forEach((f) => assert.ok(!(f in result), `${f}가 없어야 한다`));
      assert.strictEqual(result.display_name, 'Victim');
      assert.strictEqual(result.user_code, 'U0002');
    }
  );

  // ============ ④ GET /users/code/:code — 본인 조회: 계정 식별·인증·활동 기록이 있다(불변) ============
  await expectResolved(
    '본인 코드로 GET /users/code/:code — email·firebase_uid·status·latest_activity_at 있음',
    () => userService.getUserByUserCode('U0001', 'self1'),
    (result) => {
      assert.strictEqual(result.email, 'self1@test.com');
      assert.strictEqual(result.firebase_uid, 'uid-self1');
      assert.strictEqual(result.status, 0);
      assert.ok('latest_activity_at' in result);
    }
  );

  // ============ ⑤ 인증 경로(findByUid 기반 getUserByUid) — 이 티켓으로 손대지 않음, 그대로 동작 ============
  await expectResolved(
    'getUserByUid(내부 인증 경로) — 수리 대상 아님, 그대로 동작',
    () => userService.getUserByUid('uid-self1'),
    (result) => {
      assert.strictEqual(result.id, 'self1');
      assert.strictEqual(result.display_name, 'Self');
      assert.strictEqual(result.status, 0);
    }
  );

  // ============ ⑥ GET /binders/:binderId/members — 어느 행에도 email이 없다 ============
  await expectResolved(
    'GET /binders/:binderId/members — 로스터 어느 행에도 email이 없다(본인 행 포함)',
    () => binderService.getBinderMembers('bnd1', 'self1'),
    (rows) => {
      assert.strictEqual(rows.length, 2);
      rows.forEach((r) => assert.ok(!('email' in r), 'email이 없어야 한다'));
      const displayNames = rows.map((r) => r.display_name).sort();
      assert.deepStrictEqual(displayNames, ['Self', 'Victim']);
    }
  );

  // ============ ⑦ GET /binders/:binderId/members — 비멤버는 여전히 거부된다(authz 불변) ============
  await expectResolved(
    '비멤버가 로스터 조회 시도 — 여전히 ForbiddenError로 거부(권한 경계 불변)',
    async () => {
      try {
        await binderService.getBinderMembers('bnd1', 'outsider1');
        return 'RESOLVED';
      } catch (err) {
        return { rejected: true, statusCode: err.statusCode };
      }
    },
    (result) => {
      assert.deepStrictEqual(result, { rejected: true, statusCode: 403 });
    }
  );

  console.log(`\n[userProfileExposureRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[userProfileExposureRegression] 실행 실패:', error);
  process.exitCode = 1;
});
