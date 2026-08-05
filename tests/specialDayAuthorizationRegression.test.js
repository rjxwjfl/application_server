const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const days = new Map([
  ['active-day', { id: 'active-day', calendar_id: 'active-calendar', name: '생일' }],
  ['outsider-day', { id: 'outsider-day', calendar_id: 'outsider-calendar', name: '기념일' }],
  ['former-member-day', { id: 'former-member-day', calendar_id: 'former-member-calendar', name: '기일' }],
]);

const calendars = new Map([
  ['active-calendar', { id: 'active-calendar', binder_id: 'active-binder' }],
  ['outsider-calendar', { id: 'outsider-calendar', binder_id: 'outsider-binder' }],
  ['former-member-calendar', { id: 'former-member-calendar', binder_id: 'former-member-binder' }],
]);

const calls = {
  specialDayIds: [],
  calendarIds: [],
  memberships: [],
};

const stubs = {
  '../daos/specialDayDAO': {
    SpecialDayDAO: {
      async findById(_conn, id) {
        calls.specialDayIds.push(id);
        return days.get(id) || null;
      },
    },
  },
  '../daos/calendarDAO': {
    CalendarDAO: {
      async findById(_conn, id) {
        calls.calendarIds.push(id);
        return calendars.get(id) || null;
      },
    },
  },
  '../daos/binderDAO': {
    BinderDAO: {
      async getMember(_conn, binderId, userId) {
        calls.memberships.push([binderId, userId]);
        if (binderId === 'active-binder' && userId === 'active-user') {
          return { binder_id: binderId, user_id: userId, role: 3, deleted_at: null };
        }
        if (binderId === 'former-member-binder' && userId === 'former-member') {
          return { binder_id: binderId, user_id: userId, role: 3, deleted_at: '2026-08-01T00:00:00Z' };
        }
        return null;
      },
    },
  },
  '../utils/uuid': { generateUUID: () => 'generated-id' },
  '../events/eventBus': { emit() {} },
  '../core/withTransaction': async (callback) => callback({}),
  '../../config/db': { name: 'test-pool' },
  '../utils/typeDefinitions': { TargetType: {}, ActionType: {} },
};

const originalLoad = Module._load;
Module._load = function loadWithStubs(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};

let SpecialDayService;
try {
  ({ SpecialDayService } = require('../src/services/specialDayService'));
} finally {
  Module._load = originalLoad;
}

test('active binder member can read a SpecialDay', async () => {
  const day = await SpecialDayService.getById('active-day', 'active-user');

  assert.deepEqual(day, days.get('active-day'));
  assert.deepEqual(calls.memberships.at(-1), ['active-binder', 'active-user']);
});

test('non-member cannot read a SpecialDay from another binder', async () => {
  await assert.rejects(
    SpecialDayService.getById('outsider-day', 'outsider-user'),
    (error) => error.statusCode === 403
  );
  assert.deepEqual(calls.memberships.at(-1), ['outsider-binder', 'outsider-user']);
});

test('soft-deleted membership is not active membership', async () => {
  await assert.rejects(
    SpecialDayService.getById('former-member-day', 'former-member'),
    (error) => error.statusCode === 403
  );
});

test('nonexistent SpecialDay preserves 404 before parent or membership lookup', async () => {
  const calendarCallCount = calls.calendarIds.length;
  const membershipCallCount = calls.memberships.length;

  await assert.rejects(
    SpecialDayService.getById('missing-day', 'active-user'),
    (error) => error.statusCode === 404 && error.message === '기념일을 찾을 수 없습니다'
  );

  assert.equal(calls.calendarIds.length, calendarCallCount);
  assert.equal(calls.memberships.length, membershipCallCount);
});

test('controller forwards req.user_id to SpecialDayService.getById', async () => {
  const originalGetById = SpecialDayService.getById;
  let received;
  SpecialDayService.getById = async (...args) => {
    received = args;
    return { id: 'controller-day' };
  };

  try {
    const controller = require('../src/api/specialDays/specialDayController');
    let responseBody;
    await controller.getById(
      { params: { id: 'controller-day' }, user_id: 'controller-user' },
      { json(body) { responseBody = body; } },
      (error) => { throw error; }
    );

    assert.deepEqual(received, ['controller-day', 'controller-user']);
    assert.deepEqual(responseBody, {
      success: true,
      data: { id: 'controller-day' },
    });
  } finally {
    SpecialDayService.getById = originalGetById;
  }
});
