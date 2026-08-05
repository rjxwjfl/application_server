const assert = require('assert');
const Module = require('module');

// 회귀 테스트: 폐기된 GET /:calId/shift-stats 경로는 조용히 404 처리되지 않고
// SHIFT_NOT_SUPPORTED(410)로 명시 거부되어야 한다. (RLY-20260806-010 #2, api.md §4)

const stubs = {
  '../../services/calendarService': { CalendarService: {} },
};

const originalLoad = Module._load;
Module._load = function loadWithStubs(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};

async function run() {
  try {
    const calendarController = require('../src/api/calendars/calendarController');

    assert.strictEqual(
      typeof calendarController.getShiftStats,
      'undefined',
      '폐기된 getShiftStats 컨트롤러 메서드는 제거되어야 한다'
    );

    let capturedError = null;
    const req = { params: { calId: 'cal-1' }, query: {}, user_id: 'user-1' };
    const res = {};
    const next = (err) => {
      capturedError = err;
    };

    await calendarController.shiftNotSupported(req, res, next);

    assert.ok(capturedError, '에러가 next로 전달되어야 한다');
    assert.strictEqual(capturedError.statusCode, 410, 'HTTP 상태는 410이어야 한다');
    assert.strictEqual(capturedError.errorCode, 'SHIFT_NOT_SUPPORTED', 'errorCode는 SHIFT_NOT_SUPPORTED여야 한다');

    console.log('OK: calendarShiftStatsGoneRegression');
  } finally {
    Module._load = originalLoad;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
