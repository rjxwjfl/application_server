/**
 * src/services/reminderGenerationRegression.test.js
 * =========================================
 * RLY-20260806-026 리마인더 서브시스템 세대 불일치 수리 회귀 스위트.
 *
 * binderJoinApprovalRegression.test.js와 동일한 관행: 테스트 프레임워크 없이 plain assert +
 * `node <file>.js` 직접 실행, 가짜 DB connection으로 실제 서비스 코드를 구동한다. 실제 Postgres가
 * 없어 SQL 자체의 문법 오류는 mock으로 못 잡는다 — 그래서 ⑤(스키마 컬럼 대조)는 mock 실행이
 * 아니라 config/schema.sql의 실제 CREATE TABLE 정의를 파싱해 DAO 소스가 참조하는 컬럼명과
 * 정적으로 대조한다. 이 결함(reminders.user_id 등 존재하지 않는 컬럼 INSERT)이 여기까지 온
 * 이유가 정확히 "mock은 컬럼 존재를 검증 못 한다"였다 — ⑤는 그 구멍을 막는다.
 *
 * 실행: node src/services/reminderGenerationRegression.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
// RLY-20260806-035 — 이 파서는 저장소 전체 DAO 정적 대조로 확장되며 공용 모듈로 뽑혔다
// (schemaColumnCheck.js). 동작은 원본(RLY-20260806-026)과 동일 — 여기서는 그 모듈을 쓴다.
const { readSchemaSql, extractTableColumns: extractTableColumnsRaw, stripJsComments } = require('../daos/schemaColumnCheck');

let pass = 0;
let fail = 0;
const failures = [];

function check(desc, condition) {
  if (condition) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${desc}: 단언 실패`);
  }
}

async function expectOk(desc, fn) {
  try {
    const result = await fn();
    pass += 1;
    return result;
  } catch (err) {
    fail += 1;
    failures.push(`${desc}: 정상 통과를 기대했지만 에러 — ${err.statusCode || ''} ${err.message}\n${err.stack}`);
    return undefined;
  }
}

// ════════════════════════════════════════════════════════════════════════
// ⑤ 없는 컬럼을 쓰지 않음 — config/schema.sql 실 정의를 파싱해 DAO 소스와 정적 대조
// ════════════════════════════════════════════════════════════════════════

const schemaSql = readSchemaSql();
const extractTableColumns = (tableName) => extractTableColumnsRaw(schemaSql, tableName);

// 소스 파일 텍스트에서 "실제 컬럼처럼 쓰인" 식별자 후보를 이런 식으로 전부 뽑아내는 범용
// SQL 파서는 짓지 않는다(과공학) — 대신 각 DAO가 실제로 참조하는 컬럼 목록을 코드를 읽고
// 직접 선언해, "이 목록이 실 스키마 안에 있는가"를 대조한다. 목록 자체가 코드와 어긋나면
// (컬럼을 빠뜨리거나 새 컬럼을 넣고 여기 갱신을 안 하면) 그건 이 회귀의 관심사가 아니라
// 리뷰 대상이다 — 이 단언의 책임은 "여기 적은 컬럼이 실존하는가"다.
function assertColumnsExist(desc, tableName, columns) {
  const real = new Set(extractTableColumns(tableName));
  columns.forEach((col) => {
    check(`⑤ ${desc}: ${tableName}.${col} 존재`, real.has(col));
  });
}

function assertColumnsAbsent(desc, tableName, columns) {
  const real = new Set(extractTableColumns(tableName));
  columns.forEach((col) => {
    check(`⑤ ${desc}: ${tableName}.${col} 부재(구 컬럼 재도입 회귀 방지)`, !real.has(col));
  });
}

function assertSourceDoesNotReference(desc, filePath, forbiddenIdentifiers) {
  const raw = fs.readFileSync(path.join(__dirname, '..', '..', filePath), 'utf8');
  const src = stripJsComments(raw);
  forbiddenIdentifiers.forEach((ident) => {
    const re = new RegExp(`\\b${ident}\\b`);
    check(`⑤ ${desc}: ${filePath}가 (주석 제외) ${ident}를 참조하지 않음`, !re.test(src));
  });
}

// reminders — 13컬럼 그 자체. ReminderDAO가 실제로 SELECT/INSERT/UPDATE하는 컬럼 전부.
assertColumnsExist('ReminderDAO', 'reminders', [
  'id', 'target_type', 'target_id', 'trigger_offset', 'trigger_at', 'timezone',
  'claim_token', 'claimed_at', 'attempt_count', 'next_attempt_at', 'sent_at',
  'created_at', 'updated_at',
]);
assertColumnsAbsent('ReminderDAO', 'reminders', ['user_id', 'base_time', 'is_sent', 'deleted_at', 'source_template_id', 'is_override']);
assertSourceDoesNotReference('ReminderDAO', 'src/daos/reminderDAO.js', ['base_time', 'is_sent']);
// user_id는 위 두 컬럼과 달리 파일 전체에서 금지할 수 없다 — RLY-20260806-032가 getRecipients에서
// binder_members·event_participants·task_participants(전부 실제 user_id 컬럼 보유)를 조인해
// 수신자를 구한다. 금지 대상은 정확히 "reminders 테이블 자신의 user_id 컬럼"이던 옛 패턴이다 —
// reminders의 별칭(r) 또는 테이블명 그대로에 user_id를 붙여 참조하는 형태만 좁게 잡는다.
(function assertReminderDaoDoesNotReferenceOwnUserId() {
  const src = stripJsComments(fs.readFileSync(path.join(__dirname, '../daos/reminderDAO.js'), 'utf8'));
  check(
    '⑤ ReminderDAO: reminders 테이블 자신의 user_id 컬럼을 참조하지 않음(r.user_id·reminders.user_id·INSERT INTO reminders(...user_id...) 없음)',
    !/\br\.user_id\b/.test(src) && !/reminders\.user_id\b/.test(src) && !/INSERT INTO reminders \([^)]*\buser_id\b/.test(src)
  );
})();

// special_days — SpecialDayDAO.create/update가 실제로 다루는 전체 컬럼(구 is_yearly 제외).
assertColumnsExist('SpecialDayDAO', 'special_days', [
  'id', 'calendar_id', 'author_id', 'name', 'base_date', 'r_rule', 'is_lunar',
  'lunar_month', 'lunar_day', 'lunar_is_leap_month', 'show_dday', 'count_from_one',
  'show_every_day', 'sticker', 'color', 'reminder_offsets', 'created_at', 'updated_at',
]);
assertColumnsAbsent('SpecialDayDAO', 'special_days', ['is_yearly']);
assertSourceDoesNotReference('SpecialDayDAO', 'src/daos/specialDayDAO.js', ['is_yearly']);

// events·tasks — 이번에 이식한 reminder_offsets가 실제로 실 스키마에 있는지(마이그레이션 성공 확인).
assertColumnsExist('events 컬럼 이식', 'events', ['reminder_offsets']);
assertColumnsExist('tasks 컬럼 이식', 'tasks', ['reminder_offsets']);

// user_settings.timezone — specialDayService.resolveOwnerTimezone이 참조하는 컬럼.
assertColumnsExist('specialDayService.resolveOwnerTimezone', 'user_settings', ['timezone']);

// eventDAO.js·taskDAO.js — 027 경계가 풀린 뒤(team-lead 승인) createEvent/updateEvent·
// createTask/updateTask가 owner row에 reminder_offsets를 실제로 쓴다. "역산 경로가 남아있지
// 않다"도 함께 고정한다 — ReminderDAO.syncTarget이 기존 reminders 행의 trigger_offset을
// 읽어 오프셋을 추론하는 코드(offsets===undefined 분기)가 재도입되면 이 단언이 잡는다.
assertColumnsExist('EventDAO.createEvent/updateEvent', 'events', ['reminder_offsets']);
assertColumnsExist('TaskDAO.createTask/updateTask', 'tasks', ['reminder_offsets']);
(function assertEventTaskDaoPersistsReminderOffsets() {
  const eventDaoSrc = fs.readFileSync(path.join(__dirname, '../daos/eventDao.js'), 'utf8');
  const taskDaoSrc = fs.readFileSync(path.join(__dirname, '../daos/taskDAO.js'), 'utf8');
  const reminderDaoSrc = fs.readFileSync(path.join(__dirname, '../daos/reminderDAO.js'), 'utf8');
  check('⑤ eventDAO.js가 이제 reminder_offsets를 씀(owner row 왕복 배선)', /reminder_offsets/.test(eventDaoSrc));
  check('⑤ taskDAO.js가 이제 reminder_offsets를 씀(owner row 왕복 배선)', /reminder_offsets/.test(taskDaoSrc));
  check(
    '⑤ ReminderDAO.syncTarget에 역산(offsets===undefined) 경로가 없음(오프셋 출처는 컬럼 하나)',
    !/offsets\s*===\s*undefined/.test(stripJsComments(reminderDaoSrc))
  );
})();

// event_participants·task_participants — RLY-20260806-031 결함 1: inviter_id는 실 컬럼이
// 아니다(2026-07-20 결정, schema.md changelog — "참가자 테이블의 초대자 추적은 원 설계에
// 없던 오염"). DAO가 그 컬럼을 INSERT/UPDATE/RETURNING에서 참조하면 참가자를 포함한
// 일정·할일 생성이 전부 SQL 에러다(이 결함이 여기까지 온 이유이기도 하다 — mock DB는 컬럼
// 존재를 검증 못 한다). binder_invitations.inviter_id(초대 링크 생성자)는 별개 엔티티라 대상이
// 아니다. src/daos/allDaoSchemaColumnRegression.test.js(RLY-20260806-035)도 이 두 파일을
// EXCLUDED_FILES로 잡아 두고 이 결함을 알고 있다 — 이 fix가 병합되면 그 목록에서 빠진다.
assertColumnsExist('EventDAO 참가자', 'event_participants', [
  'instance_id', 'user_id', 'state', 'memo', 'created_at', 'updated_at', 'deleted_at',
]);
assertColumnsAbsent('EventDAO 참가자', 'event_participants', ['inviter_id']);
assertSourceDoesNotReference('EventDAO', 'src/daos/eventDao.js', ['inviter_id']);

assertColumnsExist('TaskDAO 참가자', 'task_participants', [
  'instance_id', 'user_id', 'state', 'memo', 'completed_at', 'created_at', 'updated_at', 'deleted_at',
]);
assertColumnsAbsent('TaskDAO 참가자', 'task_participants', ['inviter_id']);
assertSourceDoesNotReference('TaskDAO', 'src/daos/taskDAO.js', ['inviter_id']);

// 서비스 레이어도 함께 확인 — eventService.js·taskService.js가 DAO에 inviter_id를 실어
// 넘기던 구 호출부(context.sender_id를 invitedBy로 전달)를 정리했는지.
assertSourceDoesNotReference('EventService', 'src/services/eventService.js', ['inviter_id']);
assertSourceDoesNotReference('TaskService', 'src/services/taskService.js', ['inviter_id']);

// ════════════════════════════════════════════════════════════════════════
// 서비스 레이어 — mock DB로 실제 코드 구동
// ════════════════════════════════════════════════════════════════════════

const dbPath = require.resolve('../../config/db');
const NOW = new Date().toISOString();

const db = {
  binders: { b1: { id: 'b1', name: 'B', description: null, image_url: null, thumbnail_url: null, member_count: 1, last_activity_at: NOW, created_at: NOW, updated_at: NOW, deleted_at: null } },
  calendars: { cal1: { id: 'cal1', binder_id: 'b1', title: 'C', description: null, color: 0, is_public: false, created_at: NOW, updated_at: NOW, deleted_at: null } },
  binder_members: {
    'b1:author1': { binder_id: 'b1', user_id: 'author1', role: 0, notification_level: 1, nickname_in_binder: null, joined_at: NOW, deleted_at: null },
    'b1:user2': { binder_id: 'b1', user_id: 'user2', role: 3, notification_level: 1, nickname_in_binder: null, joined_at: NOW, deleted_at: null },
  },
  events: {},
  event_instances: {},
  event_participants: {}, // key: `${instance_id}:${user_id}` — RLY-20260806-031
  event_sections: {}, // key: `${event_id}:${section_id}` — RLY-20260806-041
  tasks: {},
  task_instances: {},
  task_participants: {}, // key: `${instance_id}:${user_id}` — RLY-20260806-031
  task_sections: {}, // key: `${task_id}:${section_id}` — RLY-20260806-041
  special_days: {},
  reminders: {}, // key: id
  user_settings: { author1: { user_id: 'author1', timezone: 'Asia/Seoul' } },
};

function findReminders(targetType, targetId) {
  return Object.values(db.reminders).filter((r) => r.target_type === targetType && r.target_id === targetId);
}

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();

  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // CalendarDAO.findById
  if (s.startsWith('SELECT id, binder_id, title, description, color, is_public') && s.includes('FROM calendars')) {
    const row = db.calendars[params[0]];
    return { rows: row ? [row] : [] };
  }

  // BinderDAO.findById (SpecialDayService.getById 존재 오라클 방어 체인)
  if (s.startsWith('SELECT id, name, description, image_url, thumbnail_url, member_count') && s.includes('FROM binders')) {
    const row = db.binders[params[0]];
    return { rows: row && !row.deleted_at ? [row] : [] };
  }

  // BinderDAO.getMember
  if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
    const row = db.binder_members[`${params[0]}:${params[1]}`];
    if (!row) return { rows: [] };
    if (row.role < 0) return { rows: [] };
    return { rows: [row] };
  }

  // ── events / event_instances ──────────────────────────────────────────
  if (s.startsWith('INSERT INTO events (')) {
    const [id, calendar_id, author_id, event_type, summary, description, color, r_rule, locations, forked_from, recurrence_timezone, reminder_offsets, created_at, updated_at] = params;
    const row = {
      id, calendar_id, author_id, event_type, summary, description, color, r_rule,
      locations, forked_from, recurrence_timezone, reminder_offsets,
      created_at: created_at || NOW, updated_at: updated_at || NOW, deleted_at: null,
    };
    db.events[id] = row;
    return { rows: [row] };
  }
  if (s.startsWith('SELECT id, calendar_id, author_id, event_type, summary') && s.includes('FROM events')) {
    const row = db.events[params[0]];
    return { rows: row && !row.deleted_at ? [row] : [] };
  }
  if (s.startsWith('UPDATE events') && s.includes('SET summary')) {
    const [summary, description, color, r_rule, locations, hasRecurrenceTimezone, recurrence_timezone, reminder_offsets, eventId] = params;
    const row = db.events[eventId];
    if (row) {
      if (summary != null) row.summary = summary;
      if (description != null) row.description = description;
      if (color != null) row.color = color;
      if (r_rule != null) row.r_rule = r_rule;
      if (locations != null) row.locations = locations;
      if (hasRecurrenceTimezone) row.recurrence_timezone = recurrence_timezone;
      if (reminder_offsets != null) row.reminder_offsets = reminder_offsets;
      row.updated_at = NOW;
    }
    return { rows: row ? [row] : [] };
  }
  // RLY-20260806-041 — EventDAO.addSection(createEvent가 이미 호출하던 것). 대칭 확인용 기준선.
  if (s.startsWith('INSERT INTO event_sections')) {
    const [event_id, section_id] = params;
    db.event_sections[`${event_id}:${section_id}`] = { event_id, section_id, deleted_at: null };
    return { rows: [] };
  }
  // RLY-20260806-041 — TaskDAO.addSection(createTask에 새로 배선). 결함 ①의 직접 재현 대상.
  if (s.startsWith('INSERT INTO task_sections')) {
    const [task_id, section_id] = params;
    db.task_sections[`${task_id}:${section_id}`] = { task_id, section_id, deleted_at: null };
    return { rows: [] };
  }
  if (s.startsWith('SELECT id, start_date FROM event_instances')) {
    const rows = Object.values(db.event_instances).filter((r) => r.event_id === params[0] && !r.deleted_at);
    return { rows: rows.map((r) => ({ id: r.id, start_date: r.start_date })) };
  }
  if (s.startsWith('INSERT INTO event_instances (')) {
    const [id, event_id, instance_type, parent_id, summary, description, color, locations, is_all_day, original_date, start_date, end_date, created_at, updated_at] = params;
    const row = {
      id, event_id, instance_type, parent_id, summary, description, color, locations,
      is_all_day, original_date, start_date, end_date,
      created_at: created_at || NOW, updated_at: updated_at || NOW, deleted_at: null,
    };
    db.event_instances[id] = row;
    return { rows: [row] };
  }
  if (s.includes('FROM event_instances ei') && s.includes('JOIN events e') && s.includes('JOIN calendars c')) {
    const [instanceId, eventId] = params;
    const inst = db.event_instances[instanceId];
    const ev = inst && db.events[inst.event_id];
    const cal = ev && db.calendars[ev.calendar_id];
    if (!inst || inst.event_id !== eventId || inst.deleted_at || !ev || ev.deleted_at || !cal || cal.deleted_at) return { rows: [] };
    return { rows: [{ id: inst.id, deleted_at: inst.deleted_at, calendar_id: ev.calendar_id, author_id: ev.author_id, binder_id: cal.binder_id, reminder_offsets: ev.reminder_offsets }] };
  }
  // EventDAO.findInstanceById — updateParticipantState 경로용(join 없는 단독 조회).
  if (s.startsWith('SELECT id, event_id, instance_type, parent_id') && s.includes('FROM event_instances')) {
    const row = db.event_instances[params[0]];
    return { rows: row && !row.deleted_at ? [row] : [] };
  }

  // event_participants — RLY-20260806-031 결함 1 회귀용(inviter_id 컬럼 없음).
  // addParticipantRaw: INSERT INTO event_participants (instance_id, user_id, state, memo, ...)
  if (s.startsWith('INSERT INTO event_participants (instance_id, user_id, state, memo')) {
    const [instance_id, user_id, state, memo] = params;
    const key = `${instance_id}:${user_id}`;
    db.event_participants[key] = { instance_id, user_id, state, memo, deleted_at: null };
    return { rows: [] };
  }
  // addParticipant: INSERT INTO event_participants (instance_id, user_id, state, created_at, ...) VALUES ($1,$2,1,...)
  if (s.startsWith('INSERT INTO event_participants (instance_id, user_id, state, created_at')) {
    const [instance_id, user_id] = params;
    const key = `${instance_id}:${user_id}`;
    db.event_participants[key] = { instance_id, user_id, state: 1, memo: null, deleted_at: null };
    return { rows: [{ instance_id, user_id, state: 1 }] };
  }
  if (s.startsWith('SELECT instance_id, user_id, state, memo, created_at, updated_at, deleted_at') && s.includes('FROM event_participants')) {
    const [instanceId, userId] = params;
    const row = db.event_participants[`${instanceId}:${userId}`];
    return { rows: row && !row.deleted_at ? [row] : [] };
  }
  if (s.startsWith('UPDATE event_participants') && s.includes('SET state = $1')) {
    const [state, instanceId, userId] = params;
    const row = db.event_participants[`${instanceId}:${userId}`];
    if (row) { row.state = state; row.updated_at = NOW; }
    return { rows: [] };
  }
  if (s.startsWith('UPDATE event_instances') && s.includes('SET summary')) {
    const [summary, description, color, locations, is_all_day, start_date, end_date, instanceId] = params;
    const row = db.event_instances[instanceId];
    if (row) {
      if (summary != null) row.summary = summary;
      if (description != null) row.description = description;
      if (color != null) row.color = color;
      if (locations != null) row.locations = locations;
      if (is_all_day != null) row.is_all_day = is_all_day;
      if (start_date != null) row.start_date = start_date;
      if (end_date != null) row.end_date = end_date;
      row.updated_at = NOW;
    }
    return { rows: row ? [row] : [] };
  }

  // ── tasks / task_instances ───────────────────────────────────────────
  if (s.startsWith('INSERT INTO tasks (')) {
    const [id, calendar_id, author_id, task_type, summary, description, priority, locations, r_rule, forked_from, recurrence_timezone, reminder_offsets] = params;
    const row = {
      id, calendar_id, author_id, task_type, summary, description, priority, locations,
      r_rule, forked_from, recurrence_timezone, reminder_offsets, created_at: NOW, updated_at: NOW, deleted_at: null,
    };
    db.tasks[id] = row;
    return { rows: [row] };
  }
  if (s.startsWith('SELECT id, calendar_id, author_id, task_type') && s.includes('FROM tasks')) {
    const row = db.tasks[params[0]];
    return { rows: row && !row.deleted_at ? [row] : [] };
  }
  if (s.startsWith('UPDATE tasks') && s.includes('SET summary')) {
    const [summary, description, priority, locations, r_rule, hasRecurrenceTimezone, recurrence_timezone, reminder_offsets, taskId] = params;
    const row = db.tasks[taskId];
    if (row) {
      if (summary != null) row.summary = summary;
      if (description != null) row.description = description;
      if (priority != null) row.priority = priority;
      if (locations != null) row.locations = locations;
      if (r_rule != null) row.r_rule = r_rule;
      if (hasRecurrenceTimezone) row.recurrence_timezone = recurrence_timezone;
      if (reminder_offsets != null) row.reminder_offsets = reminder_offsets;
      row.updated_at = NOW;
    }
    return { rows: row ? [row] : [] };
  }
  if (s.startsWith('SELECT id, due_date FROM task_instances')) {
    const rows = Object.values(db.task_instances).filter((r) => r.task_id === params[0] && !r.deleted_at);
    return { rows: rows.map((r) => ({ id: r.id, due_date: r.due_date })) };
  }
  if (s.startsWith('INSERT INTO task_instances (')) {
    const [id, task_id, instance_type, parent_id, summary, description, priority, locations, is_all_day, completion_rule, original_date, start_date, due_date] = params;
    const row = {
      id, task_id, instance_type, parent_id, summary, description, priority, locations,
      is_all_day, completion_rule, original_date, start_date, due_date,
      created_at: NOW, updated_at: NOW, deleted_at: null,
    };
    db.task_instances[id] = row;
    return { rows: [row] };
  }
  if (s.includes('FROM task_instances ti') && s.includes('JOIN tasks t') && s.includes('JOIN calendars c')) {
    const [instanceId, taskId] = params;
    const inst = db.task_instances[instanceId];
    const tk = inst && db.tasks[inst.task_id];
    const cal = tk && db.calendars[tk.calendar_id];
    if (!inst || inst.task_id !== taskId || inst.deleted_at || !tk || tk.deleted_at || !cal || cal.deleted_at) return { rows: [] };
    return { rows: [{ id: inst.id, completion_rule: inst.completion_rule, deleted_at: inst.deleted_at, calendar_id: tk.calendar_id, author_id: tk.author_id, binder_id: cal.binder_id, reminder_offsets: tk.reminder_offsets }] };
  }

  // task_participants — RLY-20260806-031 결함 1 회귀용(inviter_id 컬럼 없음).
  // addParticipantRaw: INSERT INTO task_participants (instance_id, user_id, state, created_at, ...) VALUES ($1,$2,$3,...)
  if (s.startsWith('INSERT INTO task_participants') && s.includes('VALUES ($1, $2, $3,')) {
    const [instance_id, user_id, state] = params;
    const key = `${instance_id}:${user_id}`;
    db.task_participants[key] = { instance_id, user_id, state, memo: null, completed_at: null, deleted_at: null };
    return { rows: [] };
  }
  // addParticipant: INSERT INTO task_participants (instance_id, user_id, state, created_at, ...) VALUES ($1,$2,0,...)
  if (s.startsWith('INSERT INTO task_participants') && s.includes('VALUES ($1, $2, 0,')) {
    const [instance_id, user_id] = params;
    const key = `${instance_id}:${user_id}`;
    const row = { instance_id, user_id, state: 0, memo: null, completed_at: null, deleted_at: null };
    db.task_participants[key] = row;
    return { rows: [row] };
  }
  if (s.startsWith('SELECT instance_id, user_id, state, memo, completed_at, deleted_at') && s.includes('FROM task_participants')) {
    const [instanceId, userId] = params;
    const row = db.task_participants[`${instanceId}:${userId}`];
    return { rows: row ? [row] : [] };
  }
  if (s.startsWith('UPDATE task_participants') && s.includes('SET state = $3')) {
    const [instanceId, userId, state, memo] = params;
    const row = db.task_participants[`${instanceId}:${userId}`];
    if (row) {
      row.state = state;
      row.memo = memo;
      row.completed_at = state === 3 ? NOW : null;
      row.updated_at = NOW;
    }
    return { rows: row ? [row] : [] };
  }
  // TaskDAO.reevaluateInstanceCompletion — 이 회귀의 관심사가 아니므로(참가자 CRUD만 검증)
  // no-op으로 흡수한다.
  if (s.startsWith('WITH counts AS')) {
    return { rows: [{ completed_at: null }] };
  }

  if (s.startsWith('UPDATE task_instances') && s.includes('SET summary')) {
    const [summary, description, priority, locations, is_all_day, completion_rule, start_date, due_date, instanceId] = params;
    const row = db.task_instances[instanceId];
    if (row) {
      if (summary != null) row.summary = summary;
      if (description != null) row.description = description;
      if (priority != null) row.priority = priority;
      if (locations != null) row.locations = locations;
      if (is_all_day != null) row.is_all_day = is_all_day;
      if (completion_rule != null) row.completion_rule = completion_rule;
      if (start_date != null) row.start_date = start_date;
      if (due_date != null) row.due_date = due_date;
      row.updated_at = NOW;
    }
    return { rows: row ? [row] : [] };
  }

  // ── special_days ─────────────────────────────────────────────────────
  if (s.startsWith('INSERT INTO special_days')) {
    const [id, calendar_id, author_id, name, base_date, r_rule, is_lunar, lunar_month, lunar_day,
      lunar_is_leap_month, show_dday, count_from_one, show_every_day, sticker, color,
      reminder_offsets, created_at, updated_at] = params;
    const row = {
      id, calendar_id, author_id, name, base_date, r_rule, is_lunar, lunar_month, lunar_day,
      lunar_is_leap_month, show_dday, count_from_one, show_every_day, sticker, color,
      reminder_offsets, created_at: created_at || NOW, updated_at: updated_at || NOW, deleted_at: null,
    };
    db.special_days[id] = row;
    return { rows: [row] };
  }
  if (s.startsWith('SELECT * FROM special_days')) {
    const row = db.special_days[params[0]];
    return { rows: row && !row.deleted_at ? [row] : [] };
  }
  if (s.startsWith('UPDATE special_days') && s.includes('SET name')) {
    const [name, base_date, r_rule, is_lunar, lunar_month, lunar_day, lunar_is_leap_month,
      show_dday, count_from_one, show_every_day, sticker, color, reminder_offsets, id] = params;
    const row = db.special_days[id];
    if (row) {
      if (name != null) row.name = name;
      if (base_date != null) row.base_date = base_date;
      if (r_rule != null) row.r_rule = r_rule;
      if (is_lunar != null) row.is_lunar = is_lunar;
      if (lunar_month != null) row.lunar_month = lunar_month;
      if (lunar_day != null) row.lunar_day = lunar_day;
      if (lunar_is_leap_month != null) row.lunar_is_leap_month = lunar_is_leap_month;
      if (show_dday != null) row.show_dday = show_dday;
      if (count_from_one != null) row.count_from_one = count_from_one;
      if (show_every_day != null) row.show_every_day = show_every_day;
      if (sticker != null) row.sticker = sticker;
      if (color != null) row.color = color;
      if (reminder_offsets != null) row.reminder_offsets = reminder_offsets;
      row.updated_at = NOW;
    }
    return { rows: row ? [row] : [] };
  }
  if (s.startsWith('UPDATE special_days SET deleted_at')) {
    const row = db.special_days[params[0]];
    if (row) row.deleted_at = NOW;
    return { rows: [] };
  }

  // ── user_settings ────────────────────────────────────────────────────
  if (s.startsWith('SELECT timezone FROM user_settings')) {
    const row = db.user_settings[params[0]];
    return { rows: row ? [{ timezone: row.timezone }] : [] };
  }

  // ── reminders (ReminderDAO.syncTarget / deleteByTarget) ────────────────
  if (s.startsWith('UPDATE reminders') && s.includes('trigger_at = $1::timestamptz')) {
    // "무변동" 분기 — 기존 trigger_offset 유지, baseTime만 반영
    const [baseTime, timezone, targetType, targetId] = params;
    findReminders(targetType, targetId).forEach((r) => {
      r.trigger_at = new Date(new Date(baseTime).getTime() - r.trigger_offset * 1000);
      if (timezone != null) r.timezone = timezone;
      r.updated_at = NOW;
    });
    return { rows: [] };
  }
  if (s.startsWith('DELETE FROM reminders WHERE target_type = $1 AND target_id = $2') && !s.includes('trigger_offset')) {
    const [targetType, targetId] = params;
    Object.keys(db.reminders).forEach((id) => {
      const r = db.reminders[id];
      if (r.target_type === targetType && r.target_id === targetId) delete db.reminders[id];
    });
    return { rows: [] };
  }
  if (s.startsWith('INSERT INTO reminders')) {
    const [id, target_type, target_id, trigger_offset, trigger_at, timezone] = params;
    const existing = Object.values(db.reminders).find(
      (r) => r.target_type === target_type && r.target_id === target_id && r.trigger_offset === trigger_offset
    );
    const row = existing || { id, target_type, target_id, trigger_offset, sent_at: null, created_at: NOW };
    row.trigger_at = trigger_at;
    row.timezone = timezone;
    row.updated_at = NOW;
    db.reminders[row.id] = row;
    return { rows: [row] };
  }
  if (s.startsWith('DELETE FROM reminders WHERE target_type = $1 AND target_id = $2 AND trigger_offset != ALL')) {
    const [targetType, targetId, keepList] = params;
    Object.keys(db.reminders).forEach((id) => {
      const r = db.reminders[id];
      if (r.target_type === targetType && r.target_id === targetId && !keepList.includes(r.trigger_offset)) {
        delete db.reminders[id];
      }
    });
    return { rows: [] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
}

const mockDb = {
  query: mockQuery,
  connect: async () => ({ query: mockQuery, release() {} }),
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { EventService } = require('./eventService');
const { TaskService } = require('./taskService');
const { SpecialDayService } = require('./specialDayService');

async function run() {
  const ctx = { sender_id: 'author1', device_uuid: 'dev1' };

  // ① 리마인더가 붙은 이벤트 생성이 성공한다(더 이상 롤백되지 않는다) — 최우선 AC.
  const ev = await expectOk('① 리마인더 있는 이벤트 생성', () => EventService.createEvent({
    id: 'ev1', calendar_id: 'cal1', author_id: 'author1', summary: '팀 회의',
    reminder_offsets: [1800, 86400], // 30분 전 · 1일 전
    instances: [
      { id: 'evi1', original_date: '2026-09-01T05:00:00Z', start_date: '2026-09-01T05:00:00Z', end_date: '2026-09-01T06:00:00Z' },
    ],
  }, ctx));
  check('① 이벤트 마스터 행 생성됨', ev && ev.id === 'ev1');
  check('① 리마인더 2건 저장됨(30분 전·1일 전)', findReminders(0, 'evi1').length === 2);
  const evOffsets = findReminders(0, 'evi1').map((r) => r.trigger_offset).sort((a, b) => a - b);
  check('① 저장된 오프셋이 요청과 일치', JSON.stringify(evOffsets) === JSON.stringify([1800, 86400]));
  const evReminder30 = findReminders(0, 'evi1').find((r) => r.trigger_offset === 1800);
  check('① trigger_at = start_date - offset', new Date(evReminder30.trigger_at).getTime() === new Date('2026-09-01T05:00:00Z').getTime() - 1800000);
  check('① Event 리마인더의 timezone은 NULL(§2-B, 수신자 다수)', evReminder30.timezone == null);

  // 왕복 — 저장 → 조회 → 같은 값. 오프셋 출처가 컬럼 하나임을 검증(역산 경로 없음, team-lead 지시).
  const evReadBack = await expectOk('① 이벤트 재조회(GET)', () => EventService.getEvent('ev1', 'author1'));
  check('① GET 응답의 reminder_offsets가 저장한 값과 동일(왕복)', JSON.stringify((evReadBack.reminder_offsets || []).slice().sort()) === JSON.stringify([1800, 86400]));

  // updateEvent(마스터 레벨)로 reminder_offsets만 교체 — 역산 없이 컬럼이 갱신되고, 모든 회차가 재파생된다.
  // ev1/evi1과 별개인 전용 이벤트를 써서 아래 ④(ev1/evi1 시각 변경) 픽스처와 간섭하지 않는다.
  const evForOffsetUpdate = await expectOk('전용 이벤트 생성(updateEvent 오프셋 교체용)', () => EventService.createEvent({
    id: 'ev9', calendar_id: 'cal1', author_id: 'author1', summary: '오프셋 교체 테스트',
    reminder_offsets: [1800],
    instances: [{ id: 'evi9', original_date: '2026-09-03T00:00:00Z', start_date: '2026-09-03T00:00:00Z', end_date: '2026-09-03T01:00:00Z' }],
  }, ctx));
  check('전용 이벤트 생성 성공', !!evForOffsetUpdate);
  await expectOk('updateEvent로 reminder_offsets 교체', () => EventService.updateEvent('ev9', { reminder_offsets: [3600] }, ctx));
  const evAfterOffsetUpdate = await expectOk('오프셋 교체 후 재조회', () => EventService.getEvent('ev9', 'author1'));
  check('updateEvent 왕복 — 조회 값이 새 오프셋과 일치', JSON.stringify(evAfterOffsetUpdate.reminder_offsets) === JSON.stringify([3600]));
  check('updateEvent가 회차의 리마인더도 같이 재파생함(옛 오프셋 제거)', findReminders(0, 'evi9').length === 1 && findReminders(0, 'evi9')[0].trigger_offset === 3600);

  // ⑥ 반복 항목 — 회차 여러 개면 회차마다 원장이 붙는다(같은 오프셋 세트가 인스턴스별 독립 행으로).
  const evRecur = await expectOk('⑥ 반복 이벤트 생성(회차 2개)', () => EventService.createEvent({
    id: 'ev2', calendar_id: 'cal1', author_id: 'author1', summary: '주간 스탠드업',
    reminder_offsets: [600],
    instances: [
      { id: 'evi2a', original_date: '2026-09-02T00:00:00Z', start_date: '2026-09-02T00:00:00Z', end_date: '2026-09-02T00:30:00Z' },
      { id: 'evi2b', original_date: '2026-09-09T00:00:00Z', start_date: '2026-09-09T00:00:00Z', end_date: '2026-09-09T00:30:00Z' },
    ],
  }, ctx));
  check('⑥ 이벤트 생성 성공', !!evRecur);
  check('⑥ 회차 evi2a에 리마인더 1건', findReminders(0, 'evi2a').length === 1);
  check('⑥ 회차 evi2b에 리마인더 1건(독립)', findReminders(0, 'evi2b').length === 1);
  check('⑥ 두 회차의 리마인더 id가 서로 다름(별개 행)', findReminders(0, 'evi2a')[0].id !== findReminders(0, 'evi2b')[0].id);

  // ④ 항목 시각 변경 시 원장 재파생(Event 인스턴스).
  await expectOk('④ 이벤트 인스턴스 시각 변경', () => EventService.updateEventInstance('ev1', 'evi1', {
    start_date: '2026-09-01T06:00:00Z', // 1시간 뒤로
  }, ctx));
  const movedReminder = findReminders(0, 'evi1').find((r) => r.trigger_offset === 1800);
  check('④ 시각 변경 후 trigger_at도 새 시각 기준으로 재계산됨', new Date(movedReminder.trigger_at).getTime() === new Date('2026-09-01T06:00:00Z').getTime() - 1800000);
  check('④ 시각만 바뀌고 오프셋 집합은 그대로(2건 유지)', findReminders(0, 'evi1').length === 2);

  // ② 태스크 리마인더가 저장된다(조용히 버려지지 않는다) — 이전엔 TaskService가 ReminderDAO를 아예 호출 안 했다.
  const tk = await expectOk('② 리마인더 있는 태스크 생성', () => TaskService.createTask({
    id: 'tk1', calendar_id: 'cal1', summary: '보고서 마감',
    reminder_offsets: [86400],
    instances: [
      { id: 'tki1', original_date: '2026-09-05T09:00:00Z', due_date: '2026-09-05T09:00:00Z' },
    ],
  }, ctx));
  check('② 태스크 마스터 행 생성됨', tk && tk.id === 'tk1');
  check('② 태스크 리마인더 1건 저장됨(더 이상 조용히 버려지지 않음)', findReminders(1, 'tki1').length === 1);
  const tkReminder = findReminders(1, 'tki1')[0];
  check('② trigger_at = due_date - offset', new Date(tkReminder.trigger_at).getTime() === new Date('2026-09-05T09:00:00Z').getTime() - 86400000);

  // 왕복 — Task도 저장 → 조회 → 같은 값.
  const tkReadBack = await expectOk('② 태스크 재조회(GET)', () => TaskService.getTask('tk1', 'author1'));
  check('② GET 응답의 reminder_offsets가 저장한 값과 동일(왕복)', JSON.stringify(tkReadBack.reminder_offsets) === JSON.stringify([86400]));

  // ④ Task 축도 동일하게 재파생.
  await expectOk('④ 태스크 인스턴스 마감일 변경', () => TaskService.updateTaskInstance('tk1', 'tki1', {
    due_date: '2026-09-06T09:00:00Z',
  }, ctx));
  const movedTkReminder = findReminders(1, 'tki1')[0];
  check('④ 태스크 마감일 변경 후 trigger_at 재계산됨', new Date(movedTkReminder.trigger_at).getTime() === new Date('2026-09-06T09:00:00Z').getTime() - 86400000);

  // ③ 기념일 리마인더가 저장된다 — 이전엔 SpecialDayDAO.create 자체가 is_yearly로 100% SQL 에러였다.
  const sd = await expectOk('③ 리마인더 있는 기념일 생성', () => SpecialDayService.create({
    id: 'sd1', calendar_id: 'cal1', name: '엄마 생신', base_date: '2026-04-15',
    r_rule: 'FREQ=YEARLY', reminder_offsets: [604800], // 1주 전
  }, ctx));
  check('③ 기념일 행 생성됨(is_yearly 없이도 성공)', sd && sd.id === 'sd1');
  check('③ author_id가 인증된 요청자로 채워짐', sd.author_id === 'author1');
  check('③ 기념일 리마인더 1건 저장됨', findReminders(2, 'sd1').length === 1);
  const sdReminder = findReminders(2, 'sd1')[0];
  check('③ SpecialDay 리마인더는 timezone이 채워짐(NOT NULL, ck_rem_tz)', sdReminder.timezone === 'Asia/Seoul');
  // base_date 2026-04-15 09:00 Asia/Seoul(UTC+9) = 2026-04-15T00:00:00Z. offset 1주(604800초) 차감.
  const expectedSdTrigger = new Date(Date.UTC(2026, 3, 15, 0, 0, 0) - 604800 * 1000);
  check('③ trigger_at = base_date 09:00 로컬(author timezone) - offset', new Date(sdReminder.trigger_at).getTime() === expectedSdTrigger.getTime());

  // 왕복 — SpecialDay도 저장 → 조회 → 같은 값.
  const sdReadBack = await expectOk('③ 기념일 재조회(GET)', () => SpecialDayService.getById('sd1', 'author1'));
  check('③ GET 응답의 reminder_offsets가 저장한 값과 동일(왕복)', JSON.stringify(sdReadBack.reminder_offsets) === JSON.stringify([604800]));

  // ④ 기념일도 시각(base_date)·오프셋 변경 시 재파생된다.
  await expectOk('④ 기념일 base_date·오프셋 변경', () => SpecialDayService.update('sd1', {
    base_date: '2026-04-16', reminder_offsets: [3600], // 1시간 전으로 교체
  }, ctx));
  check('④ 옛 오프셋(1주 전) 행은 제거됨', findReminders(2, 'sd1').length === 1);
  const sdReminderAfter = findReminders(2, 'sd1')[0];
  check('④ 새 오프셋(1시간 전)으로 교체됨', sdReminderAfter.trigger_offset === 3600);
  const expectedSdTrigger2 = new Date(Date.UTC(2026, 3, 16, 0, 0, 0) - 3600 * 1000);
  check('④ 새 base_date 기준으로 trigger_at 재계산됨', new Date(sdReminderAfter.trigger_at).getTime() === expectedSdTrigger2.getTime());

  // 기념일 삭제 시 발송 원장도 정리된다(SC-reminder 액션D — special_days는 027 경계 밖이라 직접 배선).
  await expectOk('기념일 삭제', () => SpecialDayService.delete('sd1', ctx));
  check('기념일 삭제 시 리마인더도 hard delete됨', findReminders(2, 'sd1').length === 0);

  // reminder_offsets가 빈 배열이면(§7-1 "존재(빈 배열 포함) → 항목 전체 replace") 전량 해제된다.
  const sd2 = await expectOk('빈 배열로 기념일 생성(리마인더 없음)', () => SpecialDayService.create({
    id: 'sd2', calendar_id: 'cal1', name: '수능 D-Day', base_date: '2026-11-12',
    reminder_offsets: [],
  }, ctx));
  check('빈 reminder_offsets는 리마인더 0건', findReminders(2, sd2.id).length === 0);

  // ======================= RLY-20260806-031 (결함 1 — 참가자 inviter_id) =======================

  // ⑦ 참가자를 포함한 이벤트 생성이 성공한다 — 존재하지 않는 inviter_id 컬럼 INSERT로
  //   참가자 포함 생성이 전부 SQL 에러였던 결함의 직접 재현.
  const evWithParticipant = await expectOk('⑦ 참가자 포함 이벤트 생성', () => EventService.createEvent({
    id: 'ev-p1', calendar_id: 'cal1', author_id: 'author1', summary: '기획 회의',
    instances: [
      {
        id: 'evi-p1', original_date: '2026-09-10T05:00:00Z', start_date: '2026-09-10T05:00:00Z', end_date: '2026-09-10T06:00:00Z',
        participants: [{ user_id: 'author1', state: 0 }, { user_id: 'user2', state: 1 }],
      },
    ],
  }, ctx));
  check('⑦ 이벤트 생성 성공(과거: inviter_id 컬럼 없음 SQL 에러)', !!evWithParticipant);
  check('⑦ 참가자 2명이 저장됨', !!db.event_participants['evi-p1:author1'] && !!db.event_participants['evi-p1:user2']);

  // ⑧ 태스크도 동일하게 참가자 포함 생성이 성공한다.
  const tkWithParticipant = await expectOk('⑧ 참가자 포함 태스크 생성', () => TaskService.createTask({
    id: 'tk-p1', calendar_id: 'cal1', summary: '검수',
    instances: [
      {
        id: 'tki-p1', original_date: '2026-09-11T09:00:00Z', due_date: '2026-09-11T09:00:00Z',
        participants: [{ user_id: 'author1', state: 0 }],
      },
    ],
  }, ctx));
  check('⑧ 태스크 생성 성공', !!tkWithParticipant);
  check('⑧ 참가자 1명이 저장됨', !!db.task_participants['tki-p1:author1']);

  // ⑨ 참가자 상태 갱신이 성공한다(생성 → 단건 추가 → 본인 RSVP/상태 전이 왕복).
  const evForState = await expectOk('⑨ 상태 갱신용 이벤트 생성(참가자 없이)', () => EventService.createEvent({
    id: 'ev-p2', calendar_id: 'cal1', author_id: 'author1', summary: '워크숍',
    instances: [{ id: 'evi-p2', original_date: '2026-09-12T05:00:00Z', start_date: '2026-09-12T05:00:00Z', end_date: '2026-09-12T06:00:00Z' }],
  }, ctx));
  check('⑨ 이벤트 생성 성공', !!evForState);
  await expectOk('⑨ 이벤트 참가자 추가(user2, invite)', () => EventService.addParticipant('ev-p2', 'evi-p2', { user_id: 'user2' }, ctx));
  check('⑨ 추가 직후 상태는 invite(1)', db.event_participants['evi-p2:user2']?.state === 1);
  const ctxUser2 = { sender_id: 'user2', device_uuid: 'dev1' };
  await expectOk('⑨ 본인 RSVP: invite → accept', () => EventService.updateParticipantState('evi-p2', 'user2', { state: 3 }, ctxUser2));
  check('⑨ 상태 갱신 반영됨(accept=3)', db.event_participants['evi-p2:user2']?.state === 3);

  const tkForState = await expectOk('⑨ 상태 갱신용 태스크 생성(참가자 없이)', () => TaskService.createTask({
    id: 'tk-p2', calendar_id: 'cal1', summary: '검토',
    instances: [{ id: 'tki-p2', original_date: '2026-09-13T09:00:00Z', due_date: '2026-09-13T09:00:00Z' }],
  }, ctx));
  check('⑨ 태스크 생성 성공', !!tkForState);
  await expectOk('⑨ 태스크 참가자 추가(user2, ready)', () => TaskService.addParticipant('tk-p2', 'tki-p2', { user_id: 'user2' }, ctx));
  check('⑨ 추가 직후 상태는 ready(0)', db.task_participants['tki-p2:user2']?.state === 0);
  await expectOk('⑨ 본인 상태 전이: ready → inProgress', () => TaskService.updateParticipantState('tk-p2', 'tki-p2', 'user2', { state: 1 }, ctxUser2));
  check('⑨ 상태 갱신 반영됨(inProgress=1)', db.task_participants['tki-p2:user2']?.state === 1);

  // ======================= RLY-20260806-041 (결함 ① — 태스크 섹션 연결) =======================

  // ⑩ 섹션을 지정해 이벤트를 만들면(기존 동작) 그 섹션에 연결된다 — 대칭 비교의 기준선.
  const evWithSection = await expectOk('⑩ 섹션 지정 이벤트 생성', () => EventService.createEvent({
    id: 'ev-sec1', calendar_id: 'cal1', author_id: 'author1', summary: '섹션 연결 이벤트',
    section_id: 'sec1',
    instances: [{ id: 'evi-sec1', original_date: '2026-09-14T00:00:00Z', start_date: '2026-09-14T00:00:00Z', end_date: '2026-09-14T01:00:00Z' }],
  }, ctx));
  check('⑩ 이벤트 생성 성공', !!evWithSection);
  check('⑩ 이벤트가 지정한 섹션에 연결됨', !!db.event_sections['ev-sec1:sec1']);

  // ⑪ 섹션을 지정해 태스크를 만들면 그 섹션에 연결된다 — 결함 ①의 직접 재현(과거: 호출부
  //   0건이라 연결 안 됨). ⑩과 완전히 대칭인 시나리오로 만들어 "이벤트와 대칭"을 함께 고정한다.
  const tkWithSection = await expectOk('⑪ 섹션 지정 태스크 생성', () => TaskService.createTask({
    id: 'tk-sec1', calendar_id: 'cal1', summary: '섹션 연결 태스크',
    section_id: 'sec1',
    instances: [{ id: 'tki-sec1', original_date: '2026-09-14T00:00:00Z', due_date: '2026-09-14T00:00:00Z' }],
  }, ctx));
  check('⑪ 태스크 생성 성공', !!tkWithSection);
  check('⑪ 태스크가 지정한 섹션에 연결됨(결함 ① 재현·수리 확인)', !!db.task_sections['tk-sec1:sec1']);

  console.log(`\n[reminderGenerationRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[reminderGenerationRegression] 실행 실패:', error);
  process.exitCode = 1;
});
