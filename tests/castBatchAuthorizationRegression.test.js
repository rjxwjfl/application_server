const assert = require('assert');
const Module = require('module');
const test = require('node:test');

class TestHttpError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

class NotFoundError extends TestHttpError {
  constructor(message) {
    super(message, 404);
  }
}

class ForbiddenError extends TestHttpError {
  constructor(message) {
    super(message, 403);
  }
}

const state = {
  calendars: new Map(),
  binders: new Map(),
  members: new Map(),
  calendarLookups: [],
  binderLookups: [],
  memberLookups: [],
  createCalls: [],
  syncEvents: [],
  transactionCalls: 0,
  generatedId: 0,
};

function memberKey(binderId, userId) {
  return `${binderId}:${userId}`;
}

function resetState() {
  state.calendars.clear();
  state.binders.clear();
  state.members.clear();
  state.calendarLookups = [];
  state.binderLookups = [];
  state.memberLookups = [];
  state.createCalls = [];
  state.syncEvents = [];
  state.transactionCalls = 0;
  state.generatedId = 0;
}

function addAuthorizedCalendar(calendarId, binderId, userId, role = 3) {
  state.calendars.set(calendarId, { id: calendarId, binder_id: binderId, deleted_at: null });
  state.binders.set(binderId, { id: binderId, deleted_at: null });
  state.members.set(memberKey(binderId, userId), {
    binder_id: binderId,
    user_id: userId,
    role,
    deleted_at: null,
  });
}

const CastDAO = {
  async create(_client, data) {
    state.createCalls.push(data);
    return { ...data };
  },
};

const CalendarDAO = {
  async findById(_conn, calendarId) {
    state.calendarLookups.push(calendarId);
    return state.calendars.get(calendarId) || null;
  },
};

const BinderDAO = {
  async findById(_conn, binderId) {
    state.binderLookups.push(binderId);
    return state.binders.get(binderId) || null;
  },
  async getMember(_conn, binderId, userId) {
    state.memberLookups.push([binderId, userId]);
    return state.members.get(memberKey(binderId, userId)) || null;
  },
};

const stubs = {
  '../daos/castDAO': { CastDAO },
  '../daos/calendarDAO': { CalendarDAO },
  '../daos/binderDAO': { BinderDAO },
  '../utils/uuid': { generateUUID: () => `generated-${++state.generatedId}` },
  '../events/eventBus': {
    emit(name, payload) {
      state.syncEvents.push({ name, payload });
    },
  },
  '../core/withTransaction': async (callback) => {
    state.transactionCalls += 1;
    return callback({ transaction: true });
  },
  '../../config/db': { pool: true },
  '../core/errors': { NotFoundError, ForbiddenError },
  '../utils/typeDefinitions': {
    TargetType: { CAST: 'CAST' },
    ActionType: { CREATE: 'CREATE' },
  },
};

const originalLoad = Module._load;
Module._load = function loadWithStubs(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};

const { CastService } = require('../src/services/castService');
Module._load = originalLoad;

const context = { sender_id: 'user-1', device_uuid: 'device-1' };

async function assertRejectedWithoutWrites(casts, statusCode) {
  await assert.rejects(
    () => CastService.create({ casts }, context),
    (error) => error.statusCode === statusCode
  );
  assert.strictEqual(state.transactionCalls, 0);
  assert.strictEqual(state.createCalls.length, 0);
  assert.strictEqual(state.syncEvents.length, 0);
}

test.beforeEach(resetState);

test('rejects a foreign second calendar before the transaction with zero writes', async () => {
  addAuthorizedCalendar('calendar-own', 'binder-own', context.sender_id);
  state.calendars.set('calendar-foreign', {
    id: 'calendar-foreign',
    binder_id: 'binder-foreign',
    deleted_at: null,
  });
  state.binders.set('binder-foreign', { id: 'binder-foreign', deleted_at: null });

  await assertRejectedWithoutWrites([
    { id: 'cast-1', calendar_id: 'calendar-own', title: 'allowed' },
    { id: 'cast-2', calendar_id: 'calendar-foreign', title: 'forbidden' },
  ], 403);
});

test('rejects an invalid second calendar before the transaction with zero writes', async () => {
  addAuthorizedCalendar('calendar-own', 'binder-own', context.sender_id);

  await assertRejectedWithoutWrites([
    { id: 'cast-1', calendar_id: 'calendar-own', title: 'allowed' },
    { id: 'cast-2', calendar_id: 'calendar-missing', title: 'missing' },
  ], 404);
});

test('rejects deleted calendar, binder, and membership parents before writing', async (t) => {
  await t.test('deleted calendar', async () => {
    state.calendars.set('calendar-deleted', {
      id: 'calendar-deleted',
      binder_id: 'binder-1',
      deleted_at: '2026-08-06T00:00:00.000Z',
    });
    await assertRejectedWithoutWrites([
      { id: 'cast-1', calendar_id: 'calendar-deleted', title: 'deleted calendar' },
    ], 404);
  });

  await t.test('deleted binder', async () => {
    resetState();
    state.calendars.set('calendar-1', {
      id: 'calendar-1',
      binder_id: 'binder-deleted',
      deleted_at: null,
    });
    state.binders.set('binder-deleted', {
      id: 'binder-deleted',
      deleted_at: '2026-08-06T00:00:00.000Z',
    });
    await assertRejectedWithoutWrites([
      { id: 'cast-1', calendar_id: 'calendar-1', title: 'deleted binder' },
    ], 404);
  });

  await t.test('deleted membership', async () => {
    resetState();
    addAuthorizedCalendar('calendar-1', 'binder-1', context.sender_id);
    state.members.set(memberKey('binder-1', context.sender_id), {
      binder_id: 'binder-1',
      user_id: context.sender_id,
      role: 3,
      deleted_at: '2026-08-06T00:00:00.000Z',
    });
    await assertRejectedWithoutWrites([
      { id: 'cast-1', calendar_id: 'calendar-1', title: 'deleted member' },
    ], 403);
  });
});

test('allows every active binder member role to create a cast', async (t) => {
  for (const role of [0, 1, 2, 3]) {
    await t.test(`role ${role}`, async () => {
      resetState();
      addAuthorizedCalendar('calendar-1', 'binder-1', context.sender_id, role);

      const created = await CastService.create({
        casts: [{ calendar_id: 'calendar-1', title: `role ${role}` }],
      }, context);

      assert.strictEqual(created.length, 1);
      assert.strictEqual(created[0].author_id, context.sender_id);
      assert.strictEqual(created[0].id, 'generated-1');
      assert.strictEqual(state.createCalls.length, 1);
    });
  }
});

test('keeps repeated casts independent while validating their calendar once', async () => {
  addAuthorizedCalendar('calendar-1', 'binder-1', context.sender_id);

  const created = await CastService.create({
    casts: [
      { id: 'cast-1', calendar_id: 'calendar-1', title: 'week 1' },
      { id: 'cast-2', calendar_id: 'calendar-1', title: 'week 2' },
    ],
  }, context);

  assert.deepStrictEqual(created.map((cast) => cast.id), ['cast-1', 'cast-2']);
  assert.deepStrictEqual(state.calendarLookups, ['calendar-1']);
  assert.deepStrictEqual(state.binderLookups, ['binder-1']);
  assert.deepStrictEqual(state.memberLookups, [['binder-1', context.sender_id]]);
  assert.strictEqual(state.transactionCalls, 1);
  assert.strictEqual(state.createCalls.length, 2);
  assert.deepStrictEqual(
    state.syncEvents.map(({ payload }) => payload.binder_id),
    ['binder-1', 'binder-1']
  );
});

test('maps each created cast sync event to its own calendar binder', async () => {
  addAuthorizedCalendar('calendar-a', 'binder-a', context.sender_id);
  addAuthorizedCalendar('calendar-b', 'binder-b', context.sender_id);

  const created = await CastService.create({
    casts: [
      { id: 'cast-a', calendar_id: 'calendar-a', title: 'binder A' },
      { id: 'cast-b', calendar_id: 'calendar-b', title: 'binder B' },
      { id: 'cast-a-2', calendar_id: 'calendar-a', title: 'binder A again' },
    ],
  }, context);

  assert.deepStrictEqual(created.map((cast) => cast.id), ['cast-a', 'cast-b', 'cast-a-2']);
  assert.deepStrictEqual(state.calendarLookups, ['calendar-a', 'calendar-b']);
  assert.deepStrictEqual(
    state.syncEvents.map(({ payload }) => [payload.target_id, payload.binder_id]),
    [
      ['cast-a', 'binder-a'],
      ['cast-b', 'binder-b'],
      ['cast-a-2', 'binder-a'],
    ]
  );
});
