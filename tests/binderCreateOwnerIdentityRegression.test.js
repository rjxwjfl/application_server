const assert = require('assert');
const Module = require('module');

// 회귀 테스트: 바인더 생성 시 요청 본문의 user_id를 신원으로 신뢰하지 않고,
// 인증된 요청자(req.user_id -> BinderService.createBinder의 두 번째 인자)가
// 항상 마스터(role=0)로 등록되는지 검증한다. (RLY-20260806-010 #1)

const ATTACKER_SUPPLIED_ID = 'attacker-supplied-victim-id';
const AUTHENTICATED_USER_ID = 'authenticated-caller-id';

const addMemberCalls = [];
const emittedEvents = [];

const stubs = {
  '../daos': {
    BinderDAO: {
      async create(_client, data) {
        return { id: 'binder-1', name: data.name, member_count: 1 };
      },
      async createSettings(_client, binderId) {
        return { binder_id: binderId };
      },
      async addMember(_client, binderId, userId, role) {
        addMemberCalls.push({ binderId, userId, role });
        return { binder_id: binderId, user_id: userId, role };
      },
    },
    SectionDAO: {
      async create(_client, data) {
        return { id: data.id, binder_id: data.binder_id, title: data.title };
      },
    },
    CalendarDAO: {
      async create(_client, data) {
        return { id: data.id, binder_id: data.binder_id, title: data.title };
      },
    },
  },
  '../utils/uuid': { generateUUID: () => 'generated-id' },
  '../events/eventBus': {
    emit(event, payload) {
      emittedEvents.push({ event, payload });
    },
  },
  '../../config/db': {},
  '../core/withTransaction': async (fn) => fn({}),
  '../core/errors': {
    BadRequestError: class BadRequestError extends Error {},
    NotFoundError: class NotFoundError extends Error {},
    ForbiddenError: class ForbiddenError extends Error {},
    ConflictError: class ConflictError extends Error {},
  },
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

    // 공격 시나리오: 요청 본문에 타인의 user_id를 실어 보낸다.
    const maliciousRequestBody = {
      id: 'binder-1',
      name: 'Test Binder',
      user_id: ATTACKER_SUPPLIED_ID,
    };

    const result = await BinderService.createBinder(
      maliciousRequestBody,
      AUTHENTICATED_USER_ID,
      'device-uuid-1'
    );

    assert.strictEqual(addMemberCalls.length, 1, 'addMember는 정확히 1회 호출되어야 한다');
    assert.strictEqual(
      addMemberCalls[0].userId,
      AUTHENTICATED_USER_ID,
      '마스터로 등록되는 user_id는 인증된 요청자여야 한다'
    );
    assert.notStrictEqual(
      addMemberCalls[0].userId,
      ATTACKER_SUPPLIED_ID,
      '요청 본문의 user_id가 마스터로 등록되면 안 된다'
    );
    assert.strictEqual(addMemberCalls[0].role, 0, '생성자는 master(role=0)로 등록되어야 한다');

    assert.strictEqual(result.members[0].user_id, AUTHENTICATED_USER_ID);

    const joinedEvent = emittedEvents.find((e) => e.event === 'member:joined');
    assert.ok(joinedEvent, 'member:joined 이벤트가 발행되어야 한다');
    assert.strictEqual(joinedEvent.payload.user_id, AUTHENTICATED_USER_ID);
    assert.notStrictEqual(joinedEvent.payload.user_id, ATTACKER_SUPPLIED_ID);

    console.log('OK: binderCreateOwnerIdentityRegression');
  } finally {
    Module._load = originalLoad;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
