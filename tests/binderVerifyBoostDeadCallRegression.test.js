const assert = require('assert');
const Module = require('module');

// 회귀 테스트: BinderService.verifyBoost는 존재하지 않는
// BillingService.verifyBinderBoost를 호출해 500(TypeError)을 내던 대신,
// 미구현 기능임을 명시하는 501/BINDER_BOOST_VERIFY_NOT_IMPLEMENTED를 던져야 한다.
// (RLY-20260806-010 #3)

const stubs = {
  '../daos': { BinderDAO: {}, SectionDAO: {}, CalendarDAO: {} },
  '../utils/uuid': { generateUUID: () => 'generated-id' },
  '../events/eventBus': { emit() {} },
  '../../config/db': {},
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

    console.log('OK: binderVerifyBoostDeadCallRegression');
  } finally {
    Module._load = originalLoad;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
