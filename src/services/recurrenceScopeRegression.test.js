/**
 * src/services/recurrenceScopeRegression.test.js
 * =========================================
 * RLY-20260806-034 범위 편집(fork) 재구현 회귀 스위트 — 결정 64(domain.md §3-14).
 *
 * 결함: EventService.splitEvent/TaskService.splitTask가 클라가 보낸 새 내용(summary·r_rule·
 * 새 회차·참가자)을 통째로 버리고 원본 필드를 그대로 복사했다 — 구 EventDAO.splitEvent가
 * "SELECT 원본 필드 INTO 새 행" + "UPDATE event_instances SET event_id"(소유권 이동, 참가자
 * 승계)였다(결정 64가 폐기한 그 동작). 이번 재구현은 삭제 후 재생성 + 명단 초기화로 바꾼다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js` 직접 실행, config/db.js를
 * require.cache로 가짜 connection 교체 후 실제 EventService/TaskService를 구동한다
 * (authzRegression.test.js와 동일 패턴). mock의 각 분기는 실제로 전달된 SQL 텍스트/파라미터
 * 순서로 판정한다(RLY-20260806-023/025에서 확인한 원칙 — 하드코딩하면 소스가 깨져도 회귀가
 * 안 깨진다).
 *
 * ⚠️ 과거 재평가(system.md §4-3 step5)가 실제 wall-clock `new Date()`를 쓰므로, fixture의
 * 모든 날짜는 오늘(이 세션 기준 2026-08-06)보다 미래인 2026-09 구간을 쓴다 — 과거 날짜를 쓰면
 * "지금" 방어선이 fixture 전체를 삼켜버려 경계 테스트 자체가 성립하지 않는다.
 *
 * 실행: node src/services/recurrenceScopeRegression.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dbPath = require.resolve('../../config/db');

const D = (day) => new Date(Date.UTC(2026, 8, day, 9, 0, 0)).toISOString(); // 2026-09-{day}

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond) {
  if (cond) pass++;
  else { fail++; failures.push(desc); }
}
// ════════════════════════════════════════════════════════════════════════
// ⑨ SQL↔스키마 정적 대조 — config/schema.sql 실 정의와 새 DAO 메서드가 참조하는 컬럼명을
// 대조한다(reminderGenerationRegression.test.js의 기법을 그대로 재사용 — 팀리드 지시).
// mock 실행만으로는 "존재하지 않는 컬럼을 쓰는" 결함(RLY-20260806-026이 겪은 종류)을 못 잡는다.
// ════════════════════════════════════════════════════════════════════════
const schemaSql = fs.readFileSync(path.join(__dirname, '../../config/schema.sql'), 'utf8');

function stripCheckBlocks(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const idx = text.indexOf('CHECK', i);
    if (idx === -1) { out += text.slice(i); break; }
    out += text.slice(i, idx);
    let j = idx + 5;
    while (j < text.length && /\s/.test(text[j])) j += 1;
    if (text[j] !== '(') { out += text.slice(idx, j); i = j; continue; }
    let depth = 1; j += 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '(') depth += 1;
      else if (text[j] === ')') depth -= 1;
      j += 1;
    }
    i = j;
  }
  return out;
}

function extractTableColumns(tableName) {
  const re = new RegExp(`CREATE TABLE ${tableName} \\(`);
  const m = re.exec(schemaSql);
  if (!m) throw new Error(`[schema] 테이블을 찾을 수 없음: ${tableName}`);
  const start = m.index + m[0].length;
  let depth = 1;
  let j = start;
  while (j < schemaSql.length && depth > 0) {
    if (schemaSql[j] === '(') depth += 1;
    else if (schemaSql[j] === ')') depth -= 1;
    j += 1;
  }
  const body = schemaSql.slice(start, j - 1);
  const cleaned = stripCheckBlocks(body);
  const cols = [];
  cleaned.split('\n').forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('--')) return;
    const kw = line.split(/\s+/)[0].toUpperCase();
    if (['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN'].includes(kw)) return;
    const colMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s/);
    if (colMatch) cols.push(colMatch[1]);
  });
  return cols;
}

function assertColumnsExist(desc, tableName, columns) {
  const real = new Set(extractTableColumns(tableName));
  columns.forEach((col) => {
    check(`⑨ ${desc}: ${tableName}.${col} 존재`, real.has(col));
  });
}

// events/event_instances — createForkEvent·insertInstancesBulk·findByIdForUpdate가 실제로
// SELECT/INSERT하는 컬럼 전부.
assertColumnsExist('EventDAO 범위 편집(fork)', 'events', [
  'id', 'calendar_id', 'author_id', 'event_type', 'summary', 'description', 'color',
  'r_rule', 'recurrence_timezone', 'locations', 'forked_from', 'created_at', 'updated_at', 'deleted_at',
]);
assertColumnsExist('EventDAO 범위 편집(fork)', 'event_instances', [
  'id', 'event_id', 'instance_type', 'parent_id', 'summary', 'description', 'color',
  'locations', 'is_all_day', 'original_date', 'start_date', 'end_date', 'created_at', 'updated_at', 'deleted_at',
]);
assertColumnsExist('TaskDAO 범위 편집(fork)', 'tasks', [
  'id', 'calendar_id', 'author_id', 'task_type', 'summary', 'description', 'priority',
  'r_rule', 'recurrence_timezone', 'locations', 'forked_from', 'created_at', 'updated_at', 'deleted_at',
]);
assertColumnsExist('TaskDAO 범위 편집(fork)', 'task_instances', [
  'id', 'task_id', 'instance_type', 'parent_id', 'summary', 'description', 'priority', 'locations',
  'is_all_day', 'completion_rule', 'original_date', 'start_date', 'due_date', 'created_at', 'updated_at', 'deleted_at',
]);

// ⚠️ 026/027 경계 — 이 Task(034) 최초 구현 시점엔 eventDao.js·taskDAO.js가 알림 오프셋 컬럼을
// 안 썼다(그때는 "안 쓴다"를 고정했다). RLY-20260806-026 후속(8216884)이 createEvent/updateEvent/
// createTask/updateTask에 그 컬럼을 배선해 owner row에 저장하고 GET 응답에 싣는다 — 이제 "쓴다"가
// 참이다. 단언을 지우지 않고 방향만 뒤집는다(team-lead 지시) — 이 배선이 나중에(리팩터 등으로)
// 사라지면 그것도 이 회귀가 잡아야 한다.
//
// 내 새 메서드(findByIdForUpdate·createForkEvent·insertInstancesBulk)는 여전히 그 컬럼을 직접
// 다루지 않는다(fork 시 알림은 patch.reminder_offsets를 그대로 파생하지 origin에서 물려받지
// 않는다 — 구현보고서 후속 섹션에 "origin 상속 미구현" 후속 과제로 명시했다). 이 단언은 "파일
// 전체에 그 식별자가 있는가"만 보므로 createEvent/updateEvent 쪽 배선만으로도 참이 된다.
(function assertReminderOffsetsWiredIntoOwnerRow() {
  const eventDaoSrc = fs.readFileSync(path.join(__dirname, '../daos/eventDao.js'), 'utf8');
  const taskDaoSrc = fs.readFileSync(path.join(__dirname, '../daos/taskDAO.js'), 'utf8');
  check('⑨ eventDao.js가 알림 오프셋 컬럼을 씀(026 후속 배선)', /reminder_offsets/.test(eventDaoSrc));
  check('⑨ taskDAO.js가 알림 오프셋 컬럼을 씀(026 후속 배선)', /reminder_offsets/.test(taskDaoSrc));
})();

async function expectOk(desc, fn) {
  try {
    const result = await fn();
    pass++;
    return result;
  } catch (err) {
    fail++;
    failures.push(`${desc}: 정상 통과를 기대했지만 에러 — ${err.statusCode || ''} ${err.message}`);
    return undefined;
  }
}

// ── 인메모리 DB ──────────────────────────────────────────────────────────
const db = {
  binders: {}, calendars: {}, binder_members: {},
  events: {}, event_instances: {}, event_participants: {},
  tasks: {}, task_instances: {}, task_participants: {},
};

function norm(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

async function mockQuery(sql, params = []) {
  const s = norm(sql);
  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // CalendarDAO.findById
  if (s.includes('FROM calendars') && s.includes('WHERE id = $1')) {
    const row = db.calendars[params[0]];
    return { rows: row && !row.deleted_at ? [row] : [] };
  }
  // BinderDAO.getMember
  if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
    const row = db.binder_members[`${params[0]}:${params[1]}`];
    if (!row || row.role < 0) return { rows: [] };
    return { rows: [row] };
  }

  // ── Event ──────────────────────────────────────────────────────────────
  if (s.startsWith('SELECT id, calendar_id, author_id, event_type') && s.includes('FROM events') && s.includes('FOR UPDATE')) {
    const row = db.events[params[0]];
    return { rows: row && !row.deleted_at ? [row] : [] };
  }
  if (s.includes('FROM events') && s.includes('WHERE id = $1') && !s.includes('JOIN') && !s.includes('FOR UPDATE')) {
    const row = db.events[params[0]];
    return { rows: row && !row.deleted_at ? [row] : [] };
  }
  if (s.includes('FROM event_instances') && s.includes('WHERE id = $1') && !s.includes('JOIN')) {
    const row = db.event_instances[params[0]];
    return { rows: row && !row.deleted_at ? [row] : [] };
  }
  if (s.startsWith('UPDATE event_instances') && s.includes('RETURNING id')) {
    const [eventId, boundary] = params;
    const hasBoundaryFilter = s.includes('original_date >= $2');
    const rows = Object.values(db.event_instances).filter(
      (r) => r.event_id === eventId && !r.deleted_at
        && (!hasBoundaryFilter || new Date(r.original_date) >= new Date(boundary))
    );
    rows.forEach((r) => { r.deleted_at = 'DELETED'; r.updated_at = 'DELETED'; });
    return { rows: rows.map((r) => ({ id: r.id })) };
  }
  if (s.startsWith('SELECT COUNT(*)::int AS count FROM event_instances')) {
    const count = Object.values(db.event_instances).filter((r) => r.event_id === params[0] && !r.deleted_at).length;
    return { rows: [{ count }] };
  }
  // RLY-20260806-037 — EventDAO.findEarliestActiveInstance(all_upcoming RRULE 대조 DTSTART).
  if (s.startsWith('SELECT id, original_date, is_all_day') && s.includes('FROM event_instances')) {
    const rows = Object.values(db.event_instances)
      .filter((r) => r.event_id === params[0] && !r.deleted_at)
      .sort((a, b) => new Date(a.original_date) - new Date(b.original_date));
    return { rows: rows.length ? [rows[0]] : [] };
  }
  if (s.startsWith('INSERT INTO events')) {
    const [id, calendar_id, author_id, event_type, summary, description, color, r_rule, locations, forked_from, recurrence_timezone] = params;
    if (db.events[id]) return { rows: [] }; // ON CONFLICT DO NOTHING
    const row = {
      id, calendar_id, author_id, event_type, summary, description, color, r_rule,
      locations: locations ? JSON.parse(locations) : null, forked_from, recurrence_timezone,
      created_at: 'NOW', updated_at: 'NOW', deleted_at: null,
    };
    db.events[id] = row;
    return { rows: [row] };
  }
  if (s.startsWith('INSERT INTO event_instances')) {
    const created = [];
    for (let i = 0; i < params.length; i += 12) {
      const [id, event_id, instance_type, parent_id, summary, description, color, locations, is_all_day, original_date, start_date, end_date] = params.slice(i, i + 12);
      if (db.event_instances[id]) continue; // ON CONFLICT DO NOTHING
      const row = {
        id, event_id, instance_type, parent_id, summary, description, color,
        locations: locations ? JSON.parse(locations) : null, is_all_day, original_date, start_date, end_date,
        created_at: 'NOW', updated_at: 'NOW', deleted_at: null,
      };
      db.event_instances[id] = row;
      created.push(row);
    }
    return { rows: created };
  }
  if (s.startsWith('UPDATE events') && s.includes('SET summary')) {
    // RLY-20260806-026 후속(8216884)이 reminder_offsets 컬럼을 이 UPDATE의 SET 목록에 추가하며
    // 파라미터가 8→9개로 늘었다 — id는 항상 마지막 파라미터라는 불변만 믿고 위치를 고정하지 않는다
    // (다음에 컬럼이 또 늘어도 이 mock이 안 깨지게).
    const [summary, description, color, r_rule, locations, hasTz, tz] = params;
    const eventId = params[params.length - 1];
    const row = db.events[eventId];
    if (row && !row.deleted_at) {
      if (summary !== null && summary !== undefined) row.summary = summary;
      if (description !== null && description !== undefined) row.description = description;
      if (color !== null && color !== undefined) row.color = color;
      if (r_rule !== null && r_rule !== undefined) row.r_rule = r_rule;
      if (locations !== null && locations !== undefined) row.locations = JSON.parse(locations);
      if (hasTz) row.recurrence_timezone = tz;
      row.updated_at = 'NOW';
      return { rows: [row] };
    }
    return { rows: [] };
  }
  if (s.startsWith('UPDATE event_participants')) {
    const [instanceIds] = params;
    Object.values(db.event_participants).forEach((r) => {
      if (instanceIds.includes(r.instance_id) && !r.deleted_at) r.deleted_at = 'DELETED';
    });
    return { rows: [] };
  }

  // ── Task ───────────────────────────────────────────────────────────────
  if (s.startsWith('SELECT id, calendar_id, author_id, task_type') && s.includes('FROM tasks') && s.includes('FOR UPDATE')) {
    const row = db.tasks[params[0]];
    return { rows: row && !row.deleted_at ? [row] : [] };
  }
  if (s.includes('FROM tasks') && s.includes('WHERE id = $1') && !s.includes('JOIN') && !s.includes('FOR UPDATE')) {
    const row = db.tasks[params[0]];
    return { rows: row && !row.deleted_at ? [row] : [] };
  }
  if (s.includes('FROM task_instances') && s.includes('WHERE id = $1') && !s.includes('JOIN')) {
    const row = db.task_instances[params[0]];
    return { rows: row && !row.deleted_at ? [row] : [] };
  }
  if (s.startsWith('UPDATE task_instances') && s.includes('RETURNING id')) {
    const [taskId, boundary] = params;
    const hasBoundaryFilter = s.includes('original_date >= $2');
    const rows = Object.values(db.task_instances).filter(
      (r) => r.task_id === taskId && !r.deleted_at
        && (!hasBoundaryFilter || new Date(r.original_date) >= new Date(boundary))
    );
    rows.forEach((r) => { r.deleted_at = 'DELETED'; r.updated_at = 'DELETED'; });
    return { rows: rows.map((r) => ({ id: r.id })) };
  }
  if (s.startsWith('SELECT COUNT(*)::int AS count FROM task_instances')) {
    const count = Object.values(db.task_instances).filter((r) => r.task_id === params[0] && !r.deleted_at).length;
    return { rows: [{ count }] };
  }
  // RLY-20260806-037 — TaskDAO.findEarliestActiveInstance(all_upcoming RRULE 대조 DTSTART).
  if (s.startsWith('SELECT id, original_date, is_all_day') && s.includes('FROM task_instances')) {
    const rows = Object.values(db.task_instances)
      .filter((r) => r.task_id === params[0] && !r.deleted_at)
      .sort((a, b) => new Date(a.original_date) - new Date(b.original_date));
    return { rows: rows.length ? [rows[0]] : [] };
  }
  if (s.startsWith('INSERT INTO tasks')) {
    const [id, calendar_id, author_id, task_type, summary, description, priority, locations, r_rule, forked_from, recurrence_timezone] = params;
    if (db.tasks[id]) return { rows: [] };
    const row = {
      id, calendar_id, author_id, task_type, summary, description, priority,
      locations: locations ? JSON.parse(locations) : null, r_rule, forked_from, recurrence_timezone,
      created_at: 'NOW', updated_at: 'NOW', deleted_at: null,
    };
    db.tasks[id] = row;
    return { rows: [row] };
  }
  if (s.startsWith('INSERT INTO task_instances')) {
    const created = [];
    for (let i = 0; i < params.length; i += 13) {
      const [id, task_id, instance_type, parent_id, summary, description, priority, locations, is_all_day, completion_rule, original_date, start_date, due_date] = params.slice(i, i + 13);
      if (db.task_instances[id]) continue;
      const row = {
        id, task_id, instance_type, parent_id, summary, description, priority,
        locations: locations ? JSON.parse(locations) : null, is_all_day, completion_rule,
        original_date, start_date, due_date, created_at: 'NOW', updated_at: 'NOW', deleted_at: null,
      };
      db.task_instances[id] = row;
      created.push(row);
    }
    return { rows: created };
  }
  if (s.startsWith('UPDATE tasks') && s.includes('SET summary')) {
    // RLY-20260806-026 후속과 동일 사유(위 UPDATE events 분기 주석 참조) — id는 마지막 파라미터로 읽는다.
    const [summary, description, priority, locations, r_rule, hasTz, tz] = params;
    const taskId = params[params.length - 1];
    const row = db.tasks[taskId];
    if (row && !row.deleted_at) {
      if (summary !== null && summary !== undefined) row.summary = summary;
      if (description !== null && description !== undefined) row.description = description;
      if (priority !== null && priority !== undefined) row.priority = priority;
      if (locations !== null && locations !== undefined) row.locations = JSON.parse(locations);
      if (r_rule !== null && r_rule !== undefined) row.r_rule = r_rule;
      if (hasTz) row.recurrence_timezone = tz;
      row.updated_at = 'NOW';
      return { rows: [row] };
    }
    return { rows: [] };
  }
  if (s.startsWith('UPDATE task_participants')) {
    const [instanceIds] = params;
    Object.values(db.task_participants).forEach((r) => {
      if (instanceIds.includes(r.instance_id) && !r.deleted_at) r.deleted_at = 'DELETED';
    });
    return { rows: [] };
  }
  if (s.startsWith('WITH counts AS') && s.includes('task_instances')) {
    return { rows: [{ completed_at: null }] };
  }

  // ── 리마인더(§2 offsets=undefined "무변동" 분기만 — 이 회귀는 reminder_offsets를 안 보낸다) ──
  if (s.startsWith('UPDATE reminders')) return { rows: [] };
  if (s.startsWith('DELETE FROM reminders')) return { rows: [] };

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { EventService } = require('./eventService');
const { TaskService } = require('./taskService');

// ── 공통 fixture ────────────────────────────────────────────────────────
db.binders.b1 = { id: 'b1', deleted_at: null };
db.calendars.c1 = { id: 'c1', binder_id: 'b1', title: 'Cal', description: null, color: 0, is_public: false, deleted_at: null };
db.binder_members['b1:editor1'] = { binder_id: 'b1', user_id: 'editor1', role: 2, deleted_at: null };
db.binder_members['b1:author1'] = { binder_id: 'b1', user_id: 'author1', role: 3, deleted_at: null };

function makeSeries(prefix, count, ownerFields, table, instTable, dueOrEnd) {
  db[table][prefix] = {
    id: prefix, calendar_id: 'c1', author_id: 'author1',
    ...ownerFields, forked_from: null, created_at: 'NOW', updated_at: 'NOW', deleted_at: null,
  };
  for (let i = 1; i <= count; i++) {
    const id = `${prefix}-i${i}`;
    const base = {
      id, [table === 'events' ? 'event_id' : 'task_id']: prefix,
      instance_type: 0, parent_id: null, summary: null, description: null,
      locations: null, is_all_day: false, original_date: D(i), start_date: D(i),
      created_at: 'NOW', updated_at: 'NOW', deleted_at: null,
    };
    if (table === 'events') { base.color = null; base.end_date = D(i); }
    else { base.priority = 0; base.completion_rule = 0; base.due_date = D(i); base.start_date = D(i); }
    db[instTable][id] = base;
  }
}

const ctx = (userId) => ({ sender_id: userId, device_uuid: 'dev-1' });

function submittedInstances(prefix, fromDay, toDay, table) {
  const arr = [];
  for (let i = fromDay; i <= toDay; i++) {
    const row = {
      id: `${prefix}-new-i${i}`, original_date: D(i), start_date: D(i),
      summary: null, description: null, locations: null, is_all_day: false,
    };
    if (table === 'events') row.end_date = D(i);
    else { row.due_date = D(i); row.priority = 0; row.completion_rule = 0; }
    arr.push(row);
  }
  return arr;
}

async function run() {
  // ═══════════════════════════════════════════════════════════════════
  // ①②③⑤ this_and_future — POST split alias
  // ═══════════════════════════════════════════════════════════════════
  makeSeries('evA', 10, { event_type: 0, summary: 'Old', description: 'OldDesc', color: 1, r_rule: 'FREQ=DAILY;COUNT=10', recurrence_timezone: null, locations: null }, 'events', 'event_instances');
  db.event_participants['evA-i5:author1'] = { instance_id: 'evA-i5', user_id: 'author1', state: 0, deleted_at: null };

  await expectOk('splitEvent(this_and_future)', () => EventService.splitEvent({
    event_id: 'evA', instance_id: 'evA-i5', new_event_id: 'evA-fork',
    instances: submittedInstances('evA', 5, 10, 'events'),
    summary: 'New', description: 'NewDesc', color: 9, r_rule: 'FREQ=DAILY;COUNT=6',
  }, ctx('editor1')));

  // ① 핵심 — 저장된 값이 클라가 보낸 새 내용인가(옛 값 복사 아님)
  check('① fork 이벤트의 summary가 클라가 보낸 새 값', db.events['evA-fork'] && db.events['evA-fork'].summary === 'New');
  check('① fork 이벤트의 description이 클라가 보낸 새 값', db.events['evA-fork'] && db.events['evA-fork'].description === 'NewDesc');
  check('① fork 이벤트의 r_rule이 클라가 보낸 새 값', db.events['evA-fork'] && db.events['evA-fork'].r_rule === 'FREQ=DAILY;COUNT=6');
  check('① fork 이벤트의 forked_from이 원본을 가리킴', db.events['evA-fork'] && db.events['evA-fork'].forked_from === 'evA');
  check('① 새 회차(evA-new-i5)가 새 event_id 아래 실제로 생성됨', !!db.event_instances['evA-new-i5'] && db.event_instances['evA-new-i5'].event_id === 'evA-fork');

  // ② 경계 이전(i1~i4) 불변
  check('② 경계 이전 회차(evA-i4)는 살아있음', db.event_instances['evA-i4'] && !db.event_instances['evA-i4'].deleted_at);
  check('② 경계 이전 회차는 원본 event_id 그대로', db.event_instances['evA-i4'].event_id === 'evA');
  check('② 경계 이후 옛 회차(evA-i5)는 soft delete됨', db.event_instances['evA-i5'] && !!db.event_instances['evA-i5'].deleted_at);
  check('② 원본 이벤트 자신은(요약 등) 안 바뀜(fork만 새 내용을 가짐)', db.events.evA.summary === 'Old');

  // "구간은 서로소" — 원본 r_rule의 COUNT가 남은 회차 수(4)로 조정됐는가
  check('② 원본 r_rule의 COUNT가 잔여 회차 수로 조정됨', db.events.evA.r_rule === 'FREQ=DAILY;COUNT=4');

  // ③ 명단 초기화 — 새로 생성된 회차엔 참가자가 없다(승계 안 됨)
  const forkParticipants = Object.values(db.event_participants).filter((p) => p.instance_id.startsWith('evA-new-') && !p.deleted_at);
  check('③ 새로 생성된 회차엔 참가자가 없음(승계 안 됨)', forkParticipants.length === 0);
  check('③ 경계 이후 삭제된 옛 회차(evA-i5)의 옛 참가자도 soft delete됨', db.event_participants['evA-i5:author1'].deleted_at === 'DELETED');

  // ═══════════════════════════════════════════════════════════════════
  // ⑤ split과 PATCH this_and_future가 같은 처리를 타는가 — 별도 fixture로 동형 검증
  // ═══════════════════════════════════════════════════════════════════
  makeSeries('evB', 10, { event_type: 0, summary: 'Old', description: 'OldDesc', color: 1, r_rule: 'FREQ=DAILY;COUNT=10', recurrence_timezone: null, locations: null }, 'events', 'event_instances');

  await expectOk('updateEvent(scope=this_and_future) — PATCH 경로', () => EventService.updateEvent('evB', {
    scope: 'this_and_future', new_event_id: 'evB-fork',
    instances: submittedInstances('evB', 5, 10, 'events'),
    summary: 'New', description: 'NewDesc', color: 9, r_rule: 'FREQ=DAILY;COUNT=6',
  }, ctx('editor1')));

  check('⑤ PATCH scope=this_and_future도 split과 동일하게 새 내용을 저장', db.events['evB-fork'] && db.events['evB-fork'].summary === 'New' && db.events['evB-fork'].r_rule === 'FREQ=DAILY;COUNT=6');
  check('⑤ PATCH 경로도 경계 이전은 불변', db.event_instances['evB-i4'] && !db.event_instances['evB-i4'].deleted_at);
  check('⑤ PATCH 경로도 원본 r_rule COUNT 조정', db.events.evB.r_rule === 'FREQ=DAILY;COUNT=4');

  // ═══════════════════════════════════════════════════════════════════
  // ⑥⑦ scope=all_upcoming — 같은 이벤트 행, 새 owner 없음, 규칙 변경 재전개
  // ═══════════════════════════════════════════════════════════════════
  makeSeries('evC', 10, { event_type: 0, summary: 'Old', description: 'OldDesc', color: 1, r_rule: 'FREQ=DAILY;COUNT=10', recurrence_timezone: null, locations: null }, 'events', 'event_instances');

  await expectOk('updateEvent(scope=all_upcoming)', () => EventService.updateEvent('evC', {
    scope: 'all_upcoming',
    instances: submittedInstances('evC', 1, 10, 'events'), // "지금"부터 전개하지만 재평가로 과거는 걸러짐(여기선 전부 미래라 전부 유지)
    summary: 'AllNew', r_rule: 'FREQ=DAILY;COUNT=10',
  }, ctx('editor1')));

  check('⑥ scope=all_upcoming은 새 event 행을 만들지 않음(같은 evC)', !db.events['evC-fork']);
  check('⑥ 같은 이벤트(evC) 자체의 필드가 갱신됨', db.events.evC.summary === 'AllNew');
  check('⑦ 옛 회차(evC-i1)는 재전개로 소멸(soft delete)', !!db.event_instances['evC-i1'].deleted_at);
  check('⑦ 새 회차(evC-new-i1)가 같은 event_id 아래 생성됨', !!db.event_instances['evC-new-i1'] && db.event_instances['evC-new-i1'].event_id === 'evC');

  // ═══════════════════════════════════════════════════════════════════
  // ④ Task 동일 — this_and_future
  // ═══════════════════════════════════════════════════════════════════
  makeSeries('tkA', 10, { task_type: 0, summary: 'Old', description: 'OldDesc', priority: 1, r_rule: 'FREQ=DAILY;COUNT=10', recurrence_timezone: null, locations: null }, 'tasks', 'task_instances');
  db.task_participants['tkA-i5:author1'] = { instance_id: 'tkA-i5', user_id: 'author1', state: 0, deleted_at: null };

  await expectOk('splitTask(this_and_future)', () => TaskService.splitTask({
    task_id: 'tkA', instance_id: 'tkA-i5', new_task_id: 'tkA-fork',
    instances: submittedInstances('tkA', 5, 10, 'tasks'),
    summary: 'New', description: 'NewDesc', priority: 3, r_rule: 'FREQ=DAILY;COUNT=6',
  }, ctx('editor1')));

  check('④ Task: fork의 summary가 클라가 보낸 새 값', db.tasks['tkA-fork'] && db.tasks['tkA-fork'].summary === 'New');
  check('④ Task: fork의 r_rule이 클라가 보낸 새 값', db.tasks['tkA-fork'] && db.tasks['tkA-fork'].r_rule === 'FREQ=DAILY;COUNT=6');
  check('④ Task: 경계 이전(tkA-i4) 불변', db.task_instances['tkA-i4'] && !db.task_instances['tkA-i4'].deleted_at);
  check('④ Task: 명단 초기화(새 회차에 참가자 없음)', Object.values(db.task_participants).filter((p) => p.instance_id.startsWith('tkA-new-') && !p.deleted_at).length === 0);
  check('④ Task: 원본 r_rule COUNT 조정', db.tasks.tkA.r_rule === 'FREQ=DAILY;COUNT=4');

  // ═══════════════════════════════════════════════════════════════════
  // ⑧ 상한 365
  // ═══════════════════════════════════════════════════════════════════
  makeSeries('evD', 2, { event_type: 0, summary: 'Old', description: null, color: 0, r_rule: null, recurrence_timezone: null, locations: null }, 'events', 'event_instances');
  const tooMany = [];
  for (let i = 1; i <= 366; i++) {
    tooMany.push({ id: `evD-huge-i${i}`, original_date: D(i), start_date: D(i), end_date: D(i), summary: null, description: null, locations: null, is_all_day: false });
  }
  let capError = null;
  try {
    await EventService.splitEvent({ event_id: 'evD', instance_id: 'evD-i1', new_event_id: 'evD-fork', instances: tooMany, summary: 'X' }, ctx('editor1'));
  } catch (err) {
    capError = err;
  }
  check('⑧ 366개 제출 시 400(occurrence_limit_exceeded)으로 거부', !!capError && capError.statusCode === 400 && capError.errorCode === 'occurrence_limit_exceeded');
  check('⑧ 거부됐으므로 fork 이벤트가 생성되지 않음(트랜잭션 롤백)', !db.events['evD-fork']);
  check('⑧ 거부됐으므로 원본 회차도 그대로(evD-i1 안 지워짐)', db.event_instances['evD-i1'] && !db.event_instances['evD-i1'].deleted_at);

  console.log(`\n[recurrenceScopeRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[recurrenceScopeRegression] 실행 실패:', error);
  process.exitCode = 1;
});
