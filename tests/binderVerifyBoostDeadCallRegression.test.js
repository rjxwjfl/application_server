const assert = require('assert');
const Module = require('module');

// 회귀 테스트: BinderService.verifyBoost는 존재하지 않는
// BillingService.verifyBinderBoost를 호출해 500(TypeError)을 내던 대신,
// 미구현 기능임을 명시하는 501/BINDER_BOOST_VERIFY_NOT_IMPLEMENTED를 던져야 한다.
// (RLY-20260806-010 #3)
//
// 59c0a81(인가 30+2)이 verifyBoost 앞에 requireBinderMember를 붙였다 — 비멤버가 501
// 자체로 진입점 존재를 알면 안 된다는 정당한 강화다. requireBinderMember는 core/authz.js가
// '../daos/binderDAO'를 직접 require해 쓰는데, 이 mock은 barrel('../daos')만 스텁하고
// 그 직접 경로를 안 스텁했었다 — 그래서 core/authz.js가 실제 binderDAO를 로드했고, 거기서
// 부르는 pool(스텁된 '../../config/db' — .query 없는 빈 객체)에 .query()가 없어 TypeError가
// 났다(실 프로덕션 pool에는 .query가 있어 재현되지 않았다). RLY-20260806-020에서 두 경로를
// 모두 스텁하도록 고쳤다 — 이 테스트가 지키려는 명제(비구현 진입점은 501) 자체는 안 바꿨다.

const memberships = new Map([['binder-1:user-1', { role: 3, deleted_at: null }]]);

const binderDAOStub = {
  BinderDAO: {
    async getMember(_conn, binderId, userId) {
      const row = memberships.get(`${binderId}:${userId}`);
      return row ? { binder_id: binderId, user_id: userId, ...row } : null;
    },
  },
};

const stubs = {
  '../daos': { BinderDAO: binderDAOStub.BinderDAO, SectionDAO: {}, CalendarDAO: {} },
  '../daos/binderDAO': binderDAOStub, // core/authz.js가 barrel이 아니라 이 직접 경로로 require한다
  '../utils/uuid': { generateUUID: () => 'generated-id' },
  '../events/eventBus': { emit() {} },
  '../../config/db': { query: async () => ({ rows: [] }) },
  '../core/withTransaction': async (fn) => fn({}),
  '../utils/typeDefinitions': { TargetType: {}, ActionType: {} },
};

const originalLoad = Module._load;
Module._load = function loadWithStubs(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};

async function run() {
  try {
    const { BinderService } = require('../src/services/binderService');

    let caught = null;
    try {
      await BinderService.verifyBoost('binder-1', 'user-1', { store_type: 'apple' });
    } catch (error) {
      caught = error;
    }

    assert.ok(caught, 'verifyBoost는 에러를 던져야 한다');
    assert.notStrictEqual(
      caught.constructor.name,
      'TypeError',
      '존재하지 않는 메서드 호출로 인한 TypeError(=500)여서는 안 된다'
    );
    assert.strictEqual(caught.statusCode, 501, 'HTTP 상태는 501(Not Implemented)이어야 한다');
    assert.strictEqual(caught.errorCode, 'BINDER_BOOST_VERIFY_NOT_IMPLEMENTED');

    // 59c0a81이 심은 강화의 본체 — 비멤버는 501이 아니라 403을 받아야 한다(진입점 존재 비노출).
    let outsiderCaught = null;
    try {
      await BinderService.verifyBoost('binder-1', 'outsider', { store_type: 'apple' });
    } catch (error) {
      outsiderCaught = error;
    }

    assert.ok(outsiderCaught, '비멤버 호출도 에러를 던져야 한다');
    assert.strictEqual(outsiderCaught.statusCode, 403, '비멤버는 501이 아니라 403을 받아야 한다');

    console.log('OK: binderVerifyBoostDeadCallRegression');
  } finally {
    Module._load = originalLoad;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
