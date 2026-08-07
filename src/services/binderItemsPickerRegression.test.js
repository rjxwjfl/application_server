/**
 * src/services/binderItemsPickerRegression.test.js
 * =========================================
 * RLY-20260806-128 — SC-messaging.md §20-4 "GET /binders/{binderId}/items?type={ts} — L1
 * 캘린더 항목 picker". 100이 메시지 링크 카드 쓰기 경로(EMBED_TARGET_VALIDATORS)를 열면서
 * 이 endpoint 부재를 등재했다 — 사용자가 어떤 이벤트·태스크·기념일·캐스트를 카드로 링크할지
 * 고를 목록 자체가 없었다.
 *
 * ⚠️ 차단만 단언하면 전부 막아도 통과한다 — 4개 target_type(EVENT_INSTANCE·TASK_INSTANCE·
 * SPECIAL_DAY·CAST) 전부에 대해 **비멤버 차단·멤버 통과·다른 binder 항목 비노출** 세 가지를
 * 쌍으로 확인한다. "다른 binder 항목 비노출"이 인가의 실질 위험이다 — EMBED_TARGET_VALIDATORS와
 * 같은 JOIN(calendars.binder_id)을 쓰므로 그 검증과 같은 경계를 목록에도 적용했는지가 핵심.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`, authzRegression.test.js와
 * 동일하게 config/db를 가짜 connection으로 교체해 실제 서비스 코드(BinderService.getItems)를
 * 그대로 구동한다.
 *
 * 실행: node src/services/binderItemsPickerRegression.test.js
 */

const assert = require('assert');

const dbPath = require.resolve('../../config/db');
const NOW = new Date('2026-08-07T00:00:00Z').toISOString();

// ── 픽스처 ──────────────────────────────────────────────────────────────
// b1 = picker를 호출하는 binder. b2 = 무관한 다른 binder(같은 종류의 항목을 가지고 있지만
// b1의 picker 응답에 섞이면 안 된다 — 인가 경계 확인용).
const binderMembers = {};
function setMember(binderId, userId, role) {
  binderMembers[`${binderId}:${userId}`] = {
    binder_id: binderId, user_id: userId, role, deleted_at: null,
  };
}
setMember('b1', 'member1', 3);
setMember('b1', 'master1', 0);
// outsider는 b1/b2 어디에도 없음.

const calendars = {
  cal1: { id: 'cal1', binder_id: 'b1' },
  cal2: { id: 'cal2', binder_id: 'b2' }, // 무관한 binder
};

const events = { e1: { id: 'e1', calendar_id: 'cal1' }, e2: { id: 'e2', calendar_id: 'cal2' } };
const eventInstances = [
  // b1 소속 — 커서 테스트용으로 시각이 다른 2건
  { id: 'ei1-new', event_id: 'e1', summary: '이번 주 회의', description: null, color: 0, is_all_day: false, start_date: '2026-08-10T05:00:00.000Z', end_date: '2026-08-10T06:00:00.000Z', deleted_at: null },
  { id: 'ei1-old', event_id: 'e1', summary: '지난 회의', description: null, color: 0, is_all_day: false, start_date: '2026-08-01T05:00:00.000Z', end_date: '2026-08-01T06:00:00.000Z', deleted_at: null },
  // b2 소속(무관 binder) — b1 picker 응답에 섞이면 안 됨
  { id: 'ei2', event_id: 'e2', summary: '남의 바인더 이벤트', description: null, color: 0, is_all_day: false, start_date: '2026-08-10T05:00:00.000Z', end_date: '2026-08-10T06:00:00.000Z', deleted_at: null },
  // soft-delete된 b1 인스턴스 — 목록에서 제외돼야 함
  { id: 'ei1-deleted', event_id: 'e1', summary: '삭제된 회차', description: null, color: 0, is_all_day: false, start_date: '2026-08-05T05:00:00.000Z', end_date: '2026-08-05T06:00:00.000Z', deleted_at: NOW },
];

const tasks = { t1: { id: 't1', calendar_id: 'cal1' }, t2: { id: 't2', calendar_id: 'cal2' } };
const taskInstances = [
  { id: 'ti1', task_id: 't1', summary: '보고서 제출', description: null, priority: 0, is_all_day: false, start_date: null, due_date: '2026-08-12T00:00:00.000Z', completed_at: null, deleted_at: null },
  { id: 'ti2', task_id: 't2', summary: '남의 바인더 태스크', description: null, priority: 0, is_all_day: false, start_date: null, due_date: '2026-08-12T00:00:00.000Z', completed_at: null, deleted_at: null },
];

const specialDays = [
  { id: 'sd1', calendar_id: 'cal1', name: '생일', base_date: '2026-08-15', deleted_at: null },
  { id: 'sd2', calendar_id: 'cal2', name: '남의 바인더 기념일', base_date: '2026-08-15', deleted_at: null },
];

const casts = [
  { id: 'ca1', calendar_id: 'cal1', title: '공지', deleted_at: null, created_at: '2026-08-10T00:00:00.000Z' },
  { id: 'ca2', calendar_id: 'cal2', title: '남의 바인더 캐스트', deleted_at: null, created_at: '2026-08-10T00:00:00.000Z' },
];

function filterJoinedByBinder(rows, calById, binderId, cursorField, cursorAt) {
  return rows
    .filter((r) => !r.deleted_at)
    .filter((r) => {
      const calId = r.event_id ? events[r.event_id]?.calendar_id
        : r.task_id ? tasks[r.task_id]?.calendar_id
        : r.calendar_id;
      const cal = calById[calId];
      return cal && cal.binder_id === binderId;
    })
    .filter((r) => !cursorAt || r[cursorField] < cursorAt)
    .sort((a, b) => (a[cursorField] < b[cursorField] ? 1 : -1));
}

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // BinderDAO.getMember
  if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
    const row = binderMembers[`${params[0]}:${params[1]}`];
    return { rows: row ? [row] : [] };
  }

  // EventDAO.findInstancesByBinder
  if (s.includes('FROM event_instances ei') && s.includes('JOIN events e')) {
    const [binderId, limit, cursorAt] = params;
    const rows = filterJoinedByBinder(eventInstances, calendars, binderId, 'start_date', cursorAt).slice(0, limit);
    return { rows };
  }

  // TaskDAO.findInstancesByBinder
  if (s.includes('FROM task_instances ti') && s.includes('JOIN tasks t')) {
    const [binderId, limit, cursorAt] = params;
    const rows = filterJoinedByBinder(taskInstances, calendars, binderId, 'due_date', cursorAt).slice(0, limit);
    return { rows };
  }

  // SpecialDayDAO.findByBinder
  if (s.includes('FROM special_days sd')) {
    const [binderId, limit, cursorAt] = params;
    const rows = filterJoinedByBinder(specialDays, calendars, binderId, 'base_date', cursorAt).slice(0, limit);
    return { rows };
  }

  // CastDAO.findByBinder
  if (s.includes('FROM casts ca') && s.includes('JOIN calendars c')) {
    const [binderId, limit, cursorAt] = params;
    const rows = filterJoinedByBinder(casts, calendars, binderId, 'created_at', cursorAt).slice(0, limit);
    return { rows };
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
    if (err.statusCode === expectedStatus) pass++;
    else { fail++; failures.push(`${desc}: 예상 ${expectedStatus}, 실제 ${err.statusCode || '(non-AppError) ' + err.message}`); }
  }
}

function expectIds(desc, actual, expectedIds) {
  const actualIds = actual.map((r) => r.id);
  if (JSON.stringify(actualIds) === JSON.stringify(expectedIds)) pass++;
  else { fail++; failures.push(`${desc}: 예상 ${JSON.stringify(expectedIds)}, 실제 ${JSON.stringify(actualIds)}`); }
}

async function run() {
  // ============ 비멤버 차단 — 4종 전부 ============
  await expectStatus('getItems EVENT_INSTANCE 비멤버는 403', () => BinderService.getItems('b1', { type: 'EVENT_INSTANCE' }, 'outsider'), 403);
  await expectStatus('getItems TASK_INSTANCE 비멤버는 403', () => BinderService.getItems('b1', { type: 'TASK_INSTANCE' }, 'outsider'), 403);
  await expectStatus('getItems SPECIAL_DAY 비멤버는 403', () => BinderService.getItems('b1', { type: 'SPECIAL_DAY' }, 'outsider'), 403);
  await expectStatus('getItems CAST 비멤버는 403', () => BinderService.getItems('b1', { type: 'CAST' }, 'outsider'), 403);

  // ============ type 누락·미지값은 400 ============
  await expectStatus('getItems type 누락은 400', () => BinderService.getItems('b1', {}, 'member1'), 400);
  await expectStatus('getItems 미지 type(POST)은 400 — picker 대상 아님(§20-2 L3 별도 화면)', () => BinderService.getItems('b1', { type: 'POST' }, 'member1'), 400);
  await expectStatus('getItems 미지 type(SECTION_MESSAGE)은 400', () => BinderService.getItems('b1', { type: 'SECTION_MESSAGE' }, 'member1'), 400);

  // ============ 멤버 통과 + 다른 binder 항목 비노출 + soft-delete 제외 + 정렬 ============
  {
    const rows = await BinderService.getItems('b1', { type: 'EVENT_INSTANCE' }, 'member1');
    expectIds('EVENT_INSTANCE — b1 것만, start_date DESC, 삭제·타 binder 제외', rows, ['ei1-new', 'ei1-old']);
  }
  {
    const rows = await BinderService.getItems('b1', { type: 'TASK_INSTANCE' }, 'member1');
    expectIds('TASK_INSTANCE — b1 것만', rows, ['ti1']);
  }
  {
    const rows = await BinderService.getItems('b1', { type: 'SPECIAL_DAY' }, 'member1');
    expectIds('SPECIAL_DAY — b1 것만', rows, ['sd1']);
  }
  {
    const rows = await BinderService.getItems('b1', { type: 'CAST' }, 'member1');
    expectIds('CAST — b1 것만', rows, ['ca1']);
  }
  // master도 통과(대조군 — 권한이 role로 제한되지 않는 조회, 멤버면 누구나)
  {
    const rows = await BinderService.getItems('b1', { type: 'CAST' }, 'master1');
    expectIds('CAST — master도 조회 가능(role 무관)', rows, ['ca1']);
  }

  // ============ cursor_at 페이지네이션 ============
  {
    const rows = await BinderService.getItems('b1', { type: 'EVENT_INSTANCE', cursor_at: '2026-08-10T05:00:00.000Z' }, 'member1');
    expectIds('EVENT_INSTANCE cursor_at — 그 이전 것만', rows, ['ei1-old']);
  }

  // ============ limit 상한(50) ============
  {
    const rows = await BinderService.getItems('b1', { type: 'CAST', limit: 999 }, 'member1');
    if (rows.length <= 1) pass++; else { fail++; failures.push('limit 999 요청이 상한(50)로 캡되지 않은 것으로 의심됨'); }
  }

  console.log(`\n[binderItemsPickerRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[binderItemsPickerRegression] 실행 실패:', error);
  process.exitCode = 1;
});
