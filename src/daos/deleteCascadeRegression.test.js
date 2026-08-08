/**
 * src/daos/deleteCascadeRegression.test.js
 * =========================================
 * RLY-20260806-025 삭제 전파(cascade soft delete) 회귀 스위트.
 *
 * 이 저장소에는 테스트 프레임워크가 없다(`npm test`는 실패하는 placeholder). 기존 관행(plain assert +
 * `node <file>.js` 직접 실행, 가짜 DB connection으로 실제 DAO/서비스 코드를 구동)을 그대로 따른다.
 * 실 Postgres가 없어 SQL 문법 자체(FROM절 UPDATE·서브쿼리)는 검증하지 못한다 — 이 스위트가 검증하는
 * 것은 "그 쿼리가 실제로 어떤 행에 어떤 효과를 내는가"다: mock은 각 쿼리의 정규화된 SQL 접두어로
 * 분기하고, 그 안에서 실제 관계형 의미(FROM/JOIN/WHERE)를 인메모리 fixture에 대해 재현한다.
 *
 * 실행: node src/daos/deleteCascadeRegression.test.js
 */

const fs = require('fs');
const path = require('path');
const { CalendarDAO } = require('./calendarDAO');
const { BinderDAO } = require('./binderDAO');
const { SyncDAO } = require('./syncDAO');

let pass = 0;
let fail = 0;
const failures = [];

function check(desc, cond) {
  if (cond) pass++;
  else { fail++; failures.push(desc); }
}

function norm(sql) {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── 가짜 시계 — 실행마다 다른(단조 증가) 타임스탬프를 부여해 "새로 지워짐" vs "이미 지워져 있던
// 값 그대로"를 값 동일성으로 구분한다 ──────────────────────────────────────────────
let clock = 0;
function fakeNow() {
  clock += 1;
  return `T${clock}`;
}

// ── 인메모리 fixture DB + 쿼리 디스패처 ──────────────────────────────────────────
// CalendarDAO.cascadeSoftDelete·BinderDAO.cascadeSoftDelete(내부에서 전자를 재사용)가 실제로
// 내보내는 SQL 정규화 접두어로 분기한다. FROM절 UPDATE·서브쿼리 DELETE의 관계형 의미를 그대로
// 재현해서, 실제 DAO 코드가 이 mock 위에서 구동된다.
function makeDb() {
  return {
    events: [],
    tasks: [],
    specialDays: [],
    casts: [], // RLY-20260806-138 — events·tasks·special_days와 같은 축인데 cascade에서 빠져 있던 것
    eventInstances: [],
    taskInstances: [],
    eventParticipants: [],
    taskParticipants: [],
    reminders: [],
    calendarSubscriptions: [],
    calendars: [],
    binderMembers: [],
    sections: [],
    binders: [],
  };
}

function makeConn(db) {
  return {
    async query(sql, params = []) {
      const s = norm(sql);
      const [p0] = params;

      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

      // 멱등성 가드(AND ...deleted_at IS NULL)는 하드코딩하지 않는다 — 실제로 전달된 SQL 텍스트에
      // 그 조건이 있는지로 판정한다(RLY-20260806-023에서 확인한 원칙: 지우면 이 mock도 같이 지워져야
      // 회귀 ④가 실제로 지킨다). 없으면 이미 삭제된 행까지 덮어써서 시각이 밀린다 — 그게 정확히
      // 재현해야 하는 결함이다.
      if (s.startsWith('UPDATE events SET deleted_at')) {
        const guarded = s.includes('deleted_at IS NULL');
        db.events.filter((r) => r.calendar_id === p0 && (!guarded || !r.deleted_at))
          .forEach((r) => { r.deleted_at = fakeNow(); r.updated_at = r.deleted_at; });
        return { rows: [] };
      }
      if (s.startsWith('UPDATE tasks SET deleted_at')) {
        const guarded = s.includes('deleted_at IS NULL');
        db.tasks.filter((r) => r.calendar_id === p0 && (!guarded || !r.deleted_at))
          .forEach((r) => { r.deleted_at = fakeNow(); r.updated_at = r.deleted_at; });
        return { rows: [] };
      }
      if (s.startsWith('UPDATE special_days SET deleted_at')) {
        const guarded = s.includes('deleted_at IS NULL');
        db.specialDays.filter((r) => r.calendar_id === p0 && (!guarded || !r.deleted_at))
          .forEach((r) => { r.deleted_at = fakeNow(); r.updated_at = r.deleted_at; });
        return { rows: [] };
      }
      // RLY-20260806-138 — cascadeSoftDelete가 casts도 이제 지운다(events·tasks·special_days와
      // 같은 모양). 이 mock 분기가 없으면 실제 DAO가 낸 UPDATE casts 쿼리가 "Unhandled query"로
      // 튕겨 이 스위트 전체가 죽는다 — 즉 이 분기 자체가 "cascade가 실제로 그 쿼리를 낸다"의 증거다.
      if (s.startsWith('UPDATE casts SET deleted_at')) {
        const guarded = s.includes('deleted_at IS NULL');
        db.casts.filter((r) => r.calendar_id === p0 && (!guarded || !r.deleted_at))
          .forEach((r) => { r.deleted_at = fakeNow(); r.updated_at = r.deleted_at; });
        return { rows: [] };
      }
      if (s.startsWith('UPDATE event_instances ei SET')) {
        const guarded = s.includes('ei.deleted_at IS NULL');
        const eventIds = new Set(db.events.filter((e) => e.calendar_id === p0).map((e) => e.id));
        db.eventInstances.filter((r) => eventIds.has(r.event_id) && (!guarded || !r.deleted_at))
          .forEach((r) => { r.deleted_at = fakeNow(); r.updated_at = r.deleted_at; });
        return { rows: [] };
      }
      if (s.startsWith('UPDATE task_instances ti SET')) {
        const guarded = s.includes('ti.deleted_at IS NULL');
        const taskIds = new Set(db.tasks.filter((t) => t.calendar_id === p0).map((t) => t.id));
        db.taskInstances.filter((r) => taskIds.has(r.task_id) && (!guarded || !r.deleted_at))
          .forEach((r) => { r.deleted_at = fakeNow(); r.updated_at = r.deleted_at; });
        return { rows: [] };
      }
      if (s.startsWith('UPDATE event_participants ep SET')) {
        const guarded = s.includes('ep.deleted_at IS NULL');
        const eventIds = new Set(db.events.filter((e) => e.calendar_id === p0).map((e) => e.id));
        const instanceIds = new Set(db.eventInstances.filter((i) => eventIds.has(i.event_id)).map((i) => i.id));
        db.eventParticipants.filter((r) => instanceIds.has(r.instance_id) && (!guarded || !r.deleted_at))
          .forEach((r) => { r.deleted_at = fakeNow(); r.updated_at = r.deleted_at; });
        return { rows: [] };
      }
      if (s.startsWith('UPDATE task_participants tp SET')) {
        const guarded = s.includes('tp.deleted_at IS NULL');
        const taskIds = new Set(db.tasks.filter((t) => t.calendar_id === p0).map((t) => t.id));
        const instanceIds = new Set(db.taskInstances.filter((i) => taskIds.has(i.task_id)).map((i) => i.id));
        db.taskParticipants.filter((r) => instanceIds.has(r.instance_id) && (!guarded || !r.deleted_at))
          .forEach((r) => { r.deleted_at = fakeNow(); r.updated_at = r.deleted_at; });
        return { rows: [] };
      }
      if (s.startsWith('DELETE FROM reminders WHERE target_type = 0')) {
        const eventIds = new Set(db.events.filter((e) => e.calendar_id === p0).map((e) => e.id));
        const instanceIds = new Set(db.eventInstances.filter((i) => eventIds.has(i.event_id)).map((i) => i.id));
        db.reminders = db.reminders.filter((r) => !(r.target_type === 0 && instanceIds.has(r.target_id)));
        return { rows: [] };
      }
      if (s.startsWith('DELETE FROM reminders WHERE target_type = 1')) {
        const taskIds = new Set(db.tasks.filter((t) => t.calendar_id === p0).map((t) => t.id));
        const instanceIds = new Set(db.taskInstances.filter((i) => taskIds.has(i.task_id)).map((i) => i.id));
        db.reminders = db.reminders.filter((r) => !(r.target_type === 1 && instanceIds.has(r.target_id)));
        return { rows: [] };
      }
      if (s.startsWith('DELETE FROM reminders WHERE target_type = 2')) {
        const sdIds = new Set(db.specialDays.filter((sd) => sd.calendar_id === p0).map((sd) => sd.id));
        db.reminders = db.reminders.filter((r) => !(r.target_type === 2 && sdIds.has(r.target_id)));
        return { rows: [] };
      }
      if (s.startsWith('UPDATE calendar_subscriptions SET')) {
        const guarded = s.includes('deleted_at IS NULL');
        db.calendarSubscriptions.filter((r) => r.calendar_id === p0 && (!guarded || !r.deleted_at))
          .forEach((r) => { r.deleted_at = fakeNow(); r.updated_at = r.deleted_at; });
        return { rows: [] };
      }
      if (s.startsWith('UPDATE calendars SET deleted_at')) {
        const guarded = s.includes('deleted_at IS NULL');
        db.calendars.filter((r) => r.id === p0 && (!guarded || !r.deleted_at))
          .forEach((r) => { r.deleted_at = fakeNow(); r.updated_at = r.deleted_at; });
        return { rows: [] };
      }
      if (s.startsWith('SELECT COUNT(*)::int AS count FROM calendars')) {
        const count = db.calendars.filter((r) => r.binder_id === p0 && !r.deleted_at).length;
        return { rows: [{ count }] };
      }
      if (s.startsWith('UPDATE binder_members SET deleted_at')) {
        const guarded = s.includes('deleted_at IS NULL');
        db.binderMembers.filter((r) => r.binder_id === p0 && (!guarded || !r.deleted_at))
          .forEach((r) => { r.deleted_at = fakeNow(); r.updated_at = r.deleted_at; });
        return { rows: [] };
      }
      if (s.startsWith('SELECT id FROM calendars WHERE binder_id')) {
        const rows = db.calendars.filter((r) => r.binder_id === p0 && !r.deleted_at).map((r) => ({ id: r.id }));
        return { rows };
      }
      if (s.startsWith('UPDATE sections SET deleted_at')) {
        const guarded = s.includes('deleted_at IS NULL');
        db.sections.filter((r) => r.binder_id === p0 && (!guarded || !r.deleted_at))
          .forEach((r) => { r.deleted_at = fakeNow(); r.updated_at = r.deleted_at; });
        return { rows: [] };
      }
      if (s.startsWith('UPDATE binders SET deleted_at')) {
        const guarded = s.includes('deleted_at IS NULL');
        db.binders.filter((r) => r.id === p0 && (!guarded || !r.deleted_at))
          .forEach((r) => { r.deleted_at = fakeNow(); r.updated_at = r.deleted_at; });
        return { rows: [] };
      }

      throw new Error(`[mock] Unhandled query: ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
    },
  };
}

// ── ① 캘린더 삭제 → H13 전 테이블에 deleted_at ──────────────────────────────────
async function testCalendarCascadeAllTables() {
  const db = makeDb();
  db.calendars.push({ id: 'cal1', binder_id: 'b1', deleted_at: null });
  db.events.push({ id: 'ev1', calendar_id: 'cal1', deleted_at: null });
  db.tasks.push({ id: 'tk1', calendar_id: 'cal1', deleted_at: null });
  db.specialDays.push({ id: 'sd1', calendar_id: 'cal1', deleted_at: null });
  db.casts.push({ id: 'ca1', calendar_id: 'cal1', deleted_at: null });
  db.eventInstances.push({ id: 'ei1', event_id: 'ev1', deleted_at: null });
  db.taskInstances.push({ id: 'ti1', task_id: 'tk1', deleted_at: null });
  db.eventParticipants.push({ instance_id: 'ei1', user_id: 'u1', deleted_at: null });
  db.taskParticipants.push({ instance_id: 'ti1', user_id: 'u1', deleted_at: null });
  db.reminders.push({ id: 'r1', target_type: 0, target_id: 'ei1' });
  db.reminders.push({ id: 'r2', target_type: 1, target_id: 'ti1' });
  db.reminders.push({ id: 'r3', target_type: 2, target_id: 'sd1' });
  db.calendarSubscriptions.push({ user_id: 'sub1', calendar_id: 'cal1', deleted_at: null });

  await CalendarDAO.cascadeSoftDelete(makeConn(db), 'cal1');

  check('① events.deleted_at 세팅', !!db.events[0].deleted_at);
  check('① tasks.deleted_at 세팅', !!db.tasks[0].deleted_at);
  check('① special_days.deleted_at 세팅', !!db.specialDays[0].deleted_at);
  check('① casts.deleted_at 세팅(RLY-20260806-138 — search()·getItems·EMBED_TARGET_VALIDATORS가 이 컬럼만 보고 판정하므로 여기서 안 지워지면 셋 다 새는 지점이었다)', !!db.casts[0].deleted_at);
  check('① event_instances.deleted_at 세팅', !!db.eventInstances[0].deleted_at);
  check('① task_instances.deleted_at 세팅', !!db.taskInstances[0].deleted_at);
  check('① event_participants.deleted_at 세팅', !!db.eventParticipants[0].deleted_at);
  check('① task_participants.deleted_at 세팅', !!db.taskParticipants[0].deleted_at);
  check('① reminders 전부 hard delete(deleted_at 컬럼이 스키마에 없음)', db.reminders.length === 0);
  check('① calendar_subscriptions.deleted_at 세팅', !!db.calendarSubscriptions[0].deleted_at);
  check('① calendars.deleted_at 세팅', !!db.calendars[0].deleted_at);
}

// ── ② 바인더 삭제 → 캘린더 경유 재귀(BinderDAO가 CalendarDAO.cascadeSoftDelete 재사용) ──────
async function testBinderCascadeRecursive() {
  const db = makeDb();
  db.binders.push({ id: 'bX', deleted_at: null });
  db.binderMembers.push({ binder_id: 'bX', user_id: 'master1', deleted_at: null });
  db.binderMembers.push({ binder_id: 'bX', user_id: 'member1', deleted_at: null });
  db.sections.push({ id: 'sec1', binder_id: 'bX', deleted_at: null });
  db.calendars.push({ id: 'calA', binder_id: 'bX', deleted_at: null });
  db.calendars.push({ id: 'calB', binder_id: 'bX', deleted_at: null });
  db.events.push({ id: 'evA', calendar_id: 'calA', deleted_at: null });
  db.events.push({ id: 'evB', calendar_id: 'calB', deleted_at: null });
  db.casts.push({ id: 'caA', calendar_id: 'calA', deleted_at: null });
  db.casts.push({ id: 'caB', calendar_id: 'calB', deleted_at: null });

  await BinderDAO.cascadeSoftDelete(makeConn(db), 'bX');

  check('② binder_members 전원 deleted_at', db.binderMembers.every((r) => !!r.deleted_at));
  check('② sections.deleted_at 세팅', !!db.sections[0].deleted_at);
  check('② calendars 둘 다 deleted_at(재귀 대상 전부)', db.calendars.every((r) => !!r.deleted_at));
  check('② 각 캘린더의 자식(events)까지 재귀적으로 deleted_at — calA', !!db.events.find((e) => e.id === 'evA').deleted_at);
  check('② 각 캘린더의 자식(events)까지 재귀적으로 deleted_at — calB', !!db.events.find((e) => e.id === 'evB').deleted_at);
  check('② 바인더 삭제가 캘린더 경유로 casts까지 재귀 도달 — calA(138)', !!db.casts.find((c) => c.id === 'caA').deleted_at);
  check('② 바인더 삭제가 캘린더 경유로 casts까지 재귀 도달 — calB(138)', !!db.casts.find((c) => c.id === 'caB').deleted_at);
  check('② binders.deleted_at 세팅', !!db.binders[0].deleted_at);
}

// ── ④ 이미 지워진 행의 deleted_at 시각 불변 ─────────────────────────────────────
async function testAlreadyDeletedNotOverwritten() {
  const db = makeDb();
  db.calendars.push({ id: 'cal1', binder_id: 'b1', deleted_at: null });
  // ev1은 이미 예전에 삭제됨(30일 정리 배치 대상 시각 T_OLD로 고정) — cascade가 이걸 건드리면 안 됨.
  db.events.push({ id: 'ev1', calendar_id: 'cal1', deleted_at: 'T_OLD_FIXED', updated_at: 'T_OLD_FIXED' });
  // ev2는 아직 살아있음 — cascade로 새로 지워져야 함.
  db.events.push({ id: 'ev2', calendar_id: 'cal1', deleted_at: null });
  // ca1도 같은 대조(138) — 새로 추가한 casts UPDATE에도 멱등 가드(deleted_at IS NULL)가 있는지.
  db.casts.push({ id: 'ca1', calendar_id: 'cal1', deleted_at: 'T_OLD_FIXED', updated_at: 'T_OLD_FIXED' });
  db.casts.push({ id: 'ca2', calendar_id: 'cal1', deleted_at: null });

  await CalendarDAO.cascadeSoftDelete(makeConn(db), 'cal1');

  check('④ 이미 삭제된 행(ev1)의 deleted_at은 그대로 T_OLD_FIXED', db.events[0].deleted_at === 'T_OLD_FIXED');
  check('④ 살아있던 행(ev2)은 새로 삭제됨(T_OLD_FIXED와 다른 값)', !!db.events[1].deleted_at && db.events[1].deleted_at !== 'T_OLD_FIXED');
  check('④ 이미 삭제된 cast(ca1)의 deleted_at은 그대로 T_OLD_FIXED(138)', db.casts[0].deleted_at === 'T_OLD_FIXED');
  check('④ 살아있던 cast(ca2)는 새로 삭제됨(138)', !!db.casts[1].deleted_at && db.casts[1].deleted_at !== 'T_OLD_FIXED');
}

// ── ⑤ 기본 캘린더(=바인더의 마지막 캘린더) 삭제 차단 — CalendarService.delete 실제 구동 ──────
// config/db(root)를 가짜 pool로 교체한다 — calendarService.js·withTransaction.js 둘 다 이 모듈을
// require하므로 하나만 바꾸면 양쪽에 동시 적용된다(binderJoinApprovalRegression.test.js와 동일 관행).
async function testLastCalendarBlockedViaService() {
  const dbPath = require.resolve('../../config/db');

  const db = makeDb();
  db.binders.push({ id: 'bY', deleted_at: null });
  db.binderMembers.push({ binder_id: 'bY', user_id: 'master1', role: 0, deleted_at: null });
  db.calendars.push({ id: 'onlyCal', binder_id: 'bY', deleted_at: null });
  db.calendars.push({ id: 'secondCal', binder_id: 'bY', deleted_at: null });
  db.events.push({ id: 'evOnSecond', calendar_id: 'secondCal', deleted_at: null });

  const conn = makeConn(db);
  const fakePool = {
    async query(sql, params) {
      const s = norm(sql);
      // BinderDAO.getMember
      if (s.startsWith('SELECT binder_id, user_id, role') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
        const row = db.binderMembers.find((r) => r.binder_id === params[0] && r.user_id === params[1]);
        if (!row || row.role < 0) return { rows: [] };
        return { rows: [row] };
      }
      // CalendarDAO.findById
      if (s.startsWith('SELECT id, binder_id, title, description, color, is_public') && s.includes('FROM calendars')) {
        const row = db.calendars.find((r) => r.id === params[0] && !r.deleted_at);
        return { rows: row ? [row] : [] };
      }
      return conn.query(sql, params);
    },
    async connect() {
      return { query: fakePool.query, release() {} };
    },
  };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakePool };

  // RLY-20260806-199 — lint(no-unused-vars)로 이 require를 "결과를 안 쓴다"며 한 번
  // 지웠다가 ⑤가 깨져서 실측으로 원인을 찾고 복원했다: calendarService.js는 pool을
  // require 시점에 한 번만 바인딩하는데, calendarService.js가 내부에서 쓰는
  // withTransaction.js도 마찬가지로 자기 자신이 처음 require되는 시점의 config/db
  // exports를 캡처해 붙들고 있는다 — require.cache[dbPath]를 나중에 fakePool로
  // 바꿔치기해도 이미 캐시된 withTransaction.js의 pool 참조 자체는 안 바뀐다. 이
  // require(결과는 실제로 안 씀)가 "이 프로세스에서 calendarService.js·withTransaction.js가
  // 처음 로드되는 시점"을 여기(binder 'bY'용 fakePool이 걸려 있는 시점)로 고정해 준다 —
  // 지우면 그 첫 로드가 아래 (a) 블록(다른 binder용 fakePool2)에서 대신 일어나며
  // withTransaction.js가 fakePool2에 영구히 묶여, (b) 블록의 CalendarServiceTwo.delete가
  // (자기 pool은 새로 바인딩해도) 트랜잭션 내부는 여전히 fakePool2/db2를 써서 cascade가
  // db2 쪽에만 반영되고 이 테스트가 보는 db는 안 바뀌는 결함이 재현됐다(실측: 원복 전
  // "⑤ 삭제 허용된 캘린더는 실제로 cascade됨" 실패). 결과를 변수에 담지 않고 순수
  // 부수효과(재로드)만 쓴다는 것을 그대로 드러낸다 — no-unused-vars 자체가 안 걸린다.
  delete require.cache[require.resolve('../services/calendarService')];
  require('../services/calendarService');

  // (a) 마지막 캘린더(onlyCal 삭제 시도 전 secondCal도 존재하므로 실제 "마지막"은 각 삭제 시나리오
  // 별로 별개 fixture가 필요하다 — onlyCal 하나만 있는 바인더로 별도 구성)
  const db2 = makeDb();
  db2.binders.push({ id: 'bLast', deleted_at: null });
  db2.binderMembers.push({ binder_id: 'bLast', user_id: 'master1', role: 0, deleted_at: null });
  db2.calendars.push({ id: 'lastCal', binder_id: 'bLast', deleted_at: null });
  const conn2 = makeConn(db2);
  const fakePool2 = {
    async query(sql, params) {
      const s = norm(sql);
      if (s.startsWith('SELECT binder_id, user_id, role') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
        const row = db2.binderMembers.find((r) => r.binder_id === params[0] && r.user_id === params[1]);
        return { rows: row ? [row] : [] };
      }
      if (s.startsWith('SELECT id, binder_id, title, description, color, is_public') && s.includes('FROM calendars')) {
        const row = db2.calendars.find((r) => r.id === params[0] && !r.deleted_at);
        return { rows: row ? [row] : [] };
      }
      return conn2.query(sql, params);
    },
    async connect() {
      return { query: fakePool2.query, release() {} };
    },
  };

  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakePool2 };
  delete require.cache[require.resolve('../services/calendarService')];
  const { CalendarService: CalendarServiceLast } = require('../services/calendarService');

  let blockedError = null;
  try {
    await CalendarServiceLast.delete('lastCal', { sender_id: 'master1', device_uuid: 'd1' });
  } catch (err) {
    blockedError = err;
  }
  check('⑤ 마지막 캘린더 삭제 시도 → BadRequestError로 차단', !!blockedError && blockedError.statusCode === 400);
  check('⑤ 차단됐으므로 cascade 미실행(캘린더 deleted_at 그대로 null)', db2.calendars[0].deleted_at === null);

  // (b) 캘린더 2개 있는 바인더 — 하나 삭제는 성공해야 한다(양성 대조)
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakePool };
  delete require.cache[require.resolve('../services/calendarService')];
  const { CalendarService: CalendarServiceTwo } = require('../services/calendarService');

  let succeeded = false;
  try {
    await CalendarServiceTwo.delete('onlyCal', { sender_id: 'master1', device_uuid: 'd1' });
    succeeded = true;
  } catch (err) {
    succeeded = false;
  }
  check('⑤ 캘린더 2개 중 1개 삭제는 허용(양성 대조)', succeeded);
  check('⑤ 삭제 허용된 캘린더는 실제로 cascade됨', !!db.calendars.find((c) => c.id === 'onlyCal').deleted_at);
  check('⑤ 삭제하지 않은 나머지 캘린더(secondCal)는 그대로', !db.calendars.find((c) => c.id === 'secondCal').deleted_at);
}

// ── ⑥ 반복 회차 다수(365개)가 한 번에(집합 단위) 처리됨 ─────────────────────────
async function testBulkInstancesProcessedAsSet() {
  const db = makeDb();
  db.calendars.push({ id: 'calBulk', binder_id: 'b1', deleted_at: null });
  db.events.push({ id: 'evBulk', calendar_id: 'calBulk', deleted_at: null });
  for (let i = 0; i < 365; i++) {
    db.eventInstances.push({ id: `inst${i}`, event_id: 'evBulk', deleted_at: null });
  }

  await CalendarDAO.cascadeSoftDelete(makeConn(db), 'calBulk');

  const deletedCount = db.eventInstances.filter((r) => !!r.deleted_at).length;
  check('⑥ 365개 회차 전부 한 번의 cascade 호출로 deleted_at 세팅', deletedCount === 365);
}

// ── ⑦ SyncDAO.getBinderIdsByUserId가 삭제된 바인더를 제외한다 ───────────────────
async function testSyncExcludesDeletedBinder() {
  const rows = [
    { binder_id: 'bDeleted', user_id: 'u1', role: 3, deleted_at: null },
    { binder_id: 'bAlive', user_id: 'u1', role: 3, deleted_at: null },
  ];
  const binders = {
    bDeleted: { id: 'bDeleted', deleted_at: 'T_DEL' },
    bAlive: { id: 'bAlive', deleted_at: null },
  };
  const pool = {
    async query(sql, params) {
      const s = norm(sql);
      const [userId] = params;
      let result = rows.filter((r) => r.user_id === userId && !r.deleted_at);
      if (s.includes('role >= 0')) result = result.filter((r) => r.role >= 0);
      if (s.includes('b.deleted_at IS NULL')) result = result.filter((r) => !binders[r.binder_id].deleted_at);
      return { rows: result.map((r) => ({ binder_id: r.binder_id })) };
    },
  };
  const ids = await SyncDAO.getBinderIdsByUserId(pool, 'u1');
  check('⑦ 삭제된 바인더(bDeleted)는 스코프에서 제외', !ids.includes('bDeleted'));
  check('⑦ 살아있는 바인더(bAlive)는 스코프에 포함', ids.includes('bAlive'));
}

// ── ③ 다른 멤버 sync payload에 자식이 tombstone으로 실린다 ─────────────────────
// (아직 그 바인더 멤버십을 유지 중인 다른 멤버 관점 — oldDIds에 그 바인더가 남아있는 케이스.
//  ctx.oldDIds가 곧 "델타/tombstone 브랜치의 스코프"이므로, cascade로 막 deleted_at이 찍힌
//  이벤트·태스크가 여기 그대로 실려야 한다.)
async function testTombstoneDeliveredToOtherMember() {
  const NOW = new Date();
  const events = [
    // cascade로 방금 삭제됨(updated_at이 oldTs 이후) — tombstone으로 실려야 함
    { id: 'evDeleted', calendar_id: 'cal1', deleted_at: NOW, updated_at: NOW, created_at: new Date(NOW.getTime() - 1000) },
  ];
  const tasks = [
    { id: 'tkDeleted', calendar_id: 'cal1', deleted_at: NOW, updated_at: NOW, created_at: new Date(NOW.getTime() - 1000) },
  ];
  const calendars = { cal1: { id: 'cal1', binder_id: 'bStillMember', deleted_at: NOW } };

  // 델타(tombstone) 브랜치 텍스트만 잘라낸다 — UNION ALL(getEventsDeltaFull)이든 단일 WHERE의
  // OR 결합(getTasksDeltaFull류)이든, 두 번째(스냅샷) 브랜치는 항상 $4 파라미터의
  // "c.binder_id = ANY($4" 로 시작한다. 이 앞부분만 보고 "델타 브랜치 자체에 c.deleted_at
  // 가드가 섞여 들어갔는지"를 실제 SQL 텍스트로 판정한다 — 하드코딩하면 그 가드를 델타 브랜치에
  // 실수로 추가하는 회귀(= tombstone이 안 나가는 버그)를 이 테스트가 못 잡는다.
  function deltaBranchText(s) {
    const unionIdx = s.indexOf('UNION ALL');
    if (unionIdx >= 0) return s.slice(0, unionIdx);
    const branch2Idx = s.indexOf('OR ((c.binder_id = ANY($4');
    return branch2Idx >= 0 ? s.slice(0, branch2Idx) : s;
  }

  const pool = {
    async query(sql, params) {
      const s = norm(sql);
      const delta = deltaBranchText(s);
      const deltaHasCalendarGuard = delta.includes('c.deleted_at IS NULL');
      if (s.includes('FROM events e')) {
        const [oldDIds, , oldTs] = params;
        const rows = events.filter((e) => {
          if (!oldDIds.includes(calendars[e.calendar_id].binder_id)) return false;
          if (!(e.updated_at > oldTs)) return false;
          if (deltaHasCalendarGuard && calendars[e.calendar_id].deleted_at) return false;
          return true;
        });
        return { rows };
      }
      if (s.includes('FROM tasks t')) {
        const [oldDIds, , oldTs] = params;
        const rows = tasks.filter((t) => {
          if (!oldDIds.includes(calendars[t.calendar_id].binder_id)) return false;
          if (!(t.updated_at > oldTs)) return false;
          if (deltaHasCalendarGuard && calendars[t.calendar_id].deleted_at) return false;
          return true;
        });
        return { rows };
      }
      throw new Error(`[mock] Unhandled: ${s.slice(0, 120)}`);
    },
  };

  const ctx = {
    oldDIds: ['bStillMember'], oldCIds: [], oldTs: new Date(NOW.getTime() - 60000),
    newDIds: [], newCIds: [], calWindowFrom: new Date(0),
  };

  const eventRows = await SyncDAO.getEventsDeltaFull(pool, ctx);
  const taskRows = await SyncDAO.getTasksDeltaFull(pool, ctx);

  check('③ 삭제된 이벤트가 다른(여전히 멤버인) 멤버 payload에 deleted_at 실린 채 도착', eventRows.some((r) => r.id === 'evDeleted' && !!r.deleted_at));
  check('③ 삭제된 태스크가 다른(여전히 멤버인) 멤버 payload에 deleted_at 실린 채 도착', taskRows.some((r) => r.id === 'tkDeleted' && !!r.deleted_at));

  // ⚠️ 범위 밖(레드로 남기지 않음, 주석으로만 경계 표시 — team-lead 판정, RLY-20260806-025 후속):
  // 위 ③은 "그 바인더 멤버십을 여전히 유지 중인 다른 멤버"(oldDIds에 이 바인더가 남아있는 경우)만
  // 검증한다. "삭제·강퇴로 이 바인더 멤버십을 동시에 잃은 사람"에게는 이 델타 브랜치 자체가 스코프
  // 밖이라(ctx.oldDIds = prevToken.d_ids ∩ currDIds라서 탈락한 바인더는 oldDIds에서도 빠짐) 자식
  // tombstone이 전달되지 않는다 — 삭제(deleteBinder)뿐 아니라 강퇴(kickBinderMember)도 동일하게
  // 영향받는다. section의 purge_section_ids와 대칭되는 새 reconciliation 파이프라인이 필요한 별건
  // 결손이라 이 스위트에 실패하는 단언으로 남기지 않는다 — 후속 Task 설계 시 이 자리에 테스트를
  // 추가하면 된다.
}

// ── event_sections LEFT JOIN deleted_at 방어 (RLY-20260806-025 후속, 029 연동) ──────────────
// EventDAO.removeSection이 hard DELETE→soft UPDATE로 바뀌면(RLY-20260806-029) event_sections에
// 삭제된 링크 행이 실제로 생기기 시작한다. getEventsDeltaFull의 LEFT JOIN이 es.deleted_at을
// 확인 안 하면(ON절이든 WHERE절이든 아예 없으면) 옛 section_id가 계속 실려 나간다 — 그리고 만약
// 실수로 WHERE절에 넣으면 LEFT JOIN이 사실상 INNER JOIN이 되어 "링크가 있었다가 지워진" 이벤트
// 자체가 델타에서 통째로 사라진다(둘 다 실제로 만든 뒤 검증했다 — 구현 보고서 참조).
async function testEventSectionsLeftJoinExcludesDeletedLink() {
  const NOW = new Date();
  const calendars = { cal1: { id: 'cal1', binder_id: 'b1', deleted_at: null } };
  const events = [
    // 예전엔 secOld에 연결돼 있었지만 그 링크가 soft-delete됨(029가 만들 상태) — 다른 활성 링크 없음.
    { id: 'evUnlinked', calendar_id: 'cal1', deleted_at: null, updated_at: NOW, created_at: NOW },
    // 한 번도 섹션에 연결된 적 없음.
    { id: 'evNeverLinked', calendar_id: 'cal1', deleted_at: null, updated_at: NOW, created_at: NOW },
    // 지금도 살아있는 링크를 가짐(양성 대조).
    { id: 'evActiveLinked', calendar_id: 'cal1', deleted_at: null, updated_at: NOW, created_at: NOW },
  ];
  const eventSections = [
    { event_id: 'evUnlinked', section_id: 'secOld', deleted_at: 'T_REMOVED' },
    { event_id: 'evActiveLinked', section_id: 'secNew', deleted_at: null },
  ];

  // LEFT JOIN + 그 뒤 JOIN calendars + WHERE를 실제 SQL 텍스트에서 그대로 재현한다 — ON절에
  // es.deleted_at IS NULL이 있는지, WHERE절에 있는지를 각각 실제 텍스트 위치로 판정한다.
  function makePool() {
    return {
      async query(sql, params) {
        const s = norm(sql);
        const branches = s.split('UNION ALL');
        const [oldDIds, oldCIds, , newDIds, newCIds] = params;

        function evalBranch(branchText, binderIds, _calIds) {
          const joinToWhere = branchText.split('JOIN calendars c ON e.calendar_id = c.id');
          const onClause = joinToWhere[0]; // "LEFT JOIN event_sections es ON ..." 부분
          const whereClause = joinToWhere[1] || '';
          const onHasGuard = onClause.includes('es.deleted_at IS NULL');
          const whereHasGuard = whereClause.includes('es.deleted_at IS NULL');

          return events
            .filter((e) => calendars[e.calendar_id] && binderIds.includes(calendars[e.calendar_id].binder_id))
            .map((e) => {
              const links = eventSections.filter((es) => es.event_id === e.id);
              let joined; // 실제로 매치된 es 행(없으면 undefined = NULL-fallback)
              if (onHasGuard) {
                joined = links.find((l) => !l.deleted_at);
              } else {
                joined = links[0]; // ON절에 필터가 없으면 첫 매치(soft-delete 여부 무관)가 그대로 join된다
              }
              if (whereHasGuard && joined && joined.deleted_at) {
                return null; // 매치된 행이 WHERE에서 걸러짐 — LEFT JOIN이어도 이 이벤트 행 자체가 사라진다
              }
              return { id: e.id, section_id: joined ? joined.section_id : null };
            })
            .filter(Boolean);
        }

        const deltaRows = evalBranch(branches[0], oldDIds, oldCIds);
        const snapshotRows = branches[1] ? evalBranch(branches[1], newDIds, newCIds) : [];
        return { rows: [...deltaRows, ...snapshotRows] };
      },
    };
  }

  const ctx = {
    oldDIds: ['b1'], oldCIds: [], oldTs: new Date(NOW.getTime() - 60000),
    newDIds: [], newCIds: [], calWindowFrom: new Date(0),
  };
  const rows = await SyncDAO.getEventsDeltaFull(makePool(), ctx);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

  check('⑨ 링크가 삭제된 이벤트(evUnlinked)는 델타에 남아있음(사라지지 않음)', !!byId.evUnlinked);
  check('⑨ 링크가 삭제된 이벤트(evUnlinked)는 옛 section_id(secOld)를 싣지 않음', byId.evUnlinked && byId.evUnlinked.section_id === null);
  check('⑩ 한 번도 연결 안 된 이벤트(evNeverLinked)는 델타에서 사라지지 않음', !!byId.evNeverLinked);
  check('⑨ 활성 링크가 있는 이벤트(evActiveLinked)는 그 section_id(secNew)를 정상적으로 실음(양성 대조)', byId.evActiveLinked && byId.evActiveLinked.section_id === 'secNew');
}

// ── task_sections LEFT JOIN deleted_at 방어 (RLY-20260806-041 결함① 후속 — getEventsDeltaFull의
// event_sections LEFT JOIN(위 testEventSectionsLeftJoinExcludesDeletedLink)과 대칭) ──────────────
// EventDAO.addSection처럼 TaskDAO.addSection도 이제 createTask에서 실제로 호출된다(041) — 그
// 호출로 task_sections에 삭제된 링크 행이 생길 수 있으므로, getTasksDeltaFull의 LEFT JOIN도
// event_sections와 똑같은 함정(WHERE에 두면 사실상 INNER JOIN이 되어 태스크 자체가 사라짐)을
// 피해야 한다. getTasksDeltaFull은 UNION ALL이 아니라 단일 WHERE의 OR 결합이라 브랜치를 나누지
// 않고, ON절/WHERE절 위치만 실제 SQL 텍스트로 판정한다.
async function testTaskSectionsLeftJoinExcludesDeletedLink() {
  const NOW = new Date();
  const calendars = { cal1: { id: 'cal1', binder_id: 'b1', deleted_at: null } };
  const tasks = [
    // 예전엔 secOld에 연결돼 있었지만 그 링크가 soft-delete됨 — 다른 활성 링크 없음.
    { id: 'tkUnlinked', calendar_id: 'cal1', deleted_at: null, updated_at: NOW, created_at: NOW },
    // 한 번도 섹션에 연결된 적 없음.
    { id: 'tkNeverLinked', calendar_id: 'cal1', deleted_at: null, updated_at: NOW, created_at: NOW },
    // 지금도 살아있는 링크를 가짐(양성 대조).
    { id: 'tkActiveLinked', calendar_id: 'cal1', deleted_at: null, updated_at: NOW, created_at: NOW },
  ];
  const taskSections = [
    { task_id: 'tkUnlinked', section_id: 'secOld', deleted_at: 'T_REMOVED' },
    { task_id: 'tkActiveLinked', section_id: 'secNew', deleted_at: null },
  ];

  function makePool() {
    return {
      async query(sql, params) {
        const s = norm(sql);
        const [oldDIds] = params;
        // "JOIN calendars c ON t.calendar_id = c.id" 앞이 LEFT JOIN task_sections의 ON절,
        // 뒤가 WHERE절 — 실제 SQL 텍스트에서 그 경계로 잘라 각 위치에 가드가 있는지 판정한다.
        const [onClause, whereClause = ''] = s.split('JOIN calendars c ON t.calendar_id = c.id');
        const onHasGuard = onClause.includes('ts.deleted_at IS NULL');
        const whereHasGuard = whereClause.includes('ts.deleted_at IS NULL');

        const rows = tasks
          .filter((t) => calendars[t.calendar_id] && oldDIds.includes(calendars[t.calendar_id].binder_id))
          .map((t) => {
            const links = taskSections.filter((ts) => ts.task_id === t.id);
            const joined = onHasGuard ? links.find((l) => !l.deleted_at) : links[0];
            if (whereHasGuard && joined && joined.deleted_at) return null; // LEFT JOIN이 사실상 INNER JOIN이 됨
            return { id: t.id, section_id: joined ? joined.section_id : null };
          })
          .filter(Boolean);
        return { rows };
      },
    };
  }

  const ctx = {
    oldDIds: ['b1'], oldCIds: [], oldTs: new Date(NOW.getTime() - 60000),
    newDIds: [], newCIds: [], calWindowFrom: new Date(0),
  };
  const rows = await SyncDAO.getTasksDeltaFull(makePool(), ctx);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

  check('task_sections: 링크가 삭제된 태스크(tkUnlinked)는 델타에 남아있음(event_sections와 대칭)', !!byId.tkUnlinked);
  check('task_sections: 링크가 삭제된 태스크(tkUnlinked)는 옛 section_id(secOld)를 싣지 않음', byId.tkUnlinked && byId.tkUnlinked.section_id === null);
  check('task_sections: 한 번도 연결 안 된 태스크(tkNeverLinked)는 델타에서 사라지지 않음', !!byId.tkNeverLinked);
  check('task_sections: 활성 링크가 있는 태스크(tkActiveLinked)는 그 section_id(secNew)를 정상적으로 실음(양성 대조)', byId.tkActiveLinked && byId.tkActiveLinked.section_id === 'secNew');
}

// ── activity_feeds SECTION vs SECTION_MESSAGE 접근 판정 대칭 (RLY-20260806-041 결함③) ──────────
// 025 담당자가 두 분기의 구조 차이(비대칭)를 의심 제기했었다 — 조사 결과 오탈자로 판정해
// SECTION_MESSAGE 분기에 `s.deleted_at IS NULL`을 추가했다(syncDAO.js의 해당 분기 주석 참조).
// 실 SQL의 CASE/EXISTS 구조를 mock으로 완전히 재현하는 대신(비용 대비 낮은 가치), 소스 텍스트
// 대조로 "그 결함이 되돌아오지 않는가"를 고정한다 — eventTaskDeleteCascadeRegression.test.js의
// ⑫⑬("이름/구조는 같은데 세부가 갈라지는" 유형)과 같은 패턴.
function testActivityFeedSectionBranchesSymmetric() {
  const syncDaoSrc = fs.readFileSync(path.join(__dirname, 'syncDAO.js'), 'utf8');
  const stripAndNorm = (s) => s.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();

  const sectionStart = syncDaoSrc.indexOf("WHEN target_type = 'SECTION' THEN");
  const sectionMsgStart = syncDaoSrc.indexOf("WHEN target_type = 'SECTION_MESSAGE' THEN");
  const elseStart = syncDaoSrc.indexOf('ELSE true');
  check(
    'activity_feeds SECTION/SECTION_MESSAGE 분기를 소스에서 찾음(getActivityFeedsForSync 구조 전제)',
    sectionStart > -1 && sectionMsgStart > sectionStart && elseStart > sectionMsgStart
  );

  const sectionBranch = stripAndNorm(syncDaoSrc.slice(sectionStart, sectionMsgStart));
  const sectionMsgBranch = stripAndNorm(syncDaoSrc.slice(sectionMsgStart, elseStart));

  check('SECTION 분기가 s.deleted_at IS NULL을 확인함(기준선)', sectionBranch.includes('s.deleted_at IS NULL'));
  check(
    'SECTION_MESSAGE 분기도 s.deleted_at IS NULL을 확인함(대칭 — 041이 수정한 부분, 재발 방지)',
    sectionMsgBranch.includes('s.deleted_at IS NULL')
  );
  check(
    '두 분기 모두 access_scope 판정 구조가 동일함',
    sectionBranch.includes('s.access_scope = 0 OR EXISTS') && sectionMsgBranch.includes('s.access_scope = 0 OR EXISTS')
  );
  check(
    '두 분기 모두 section_members 멤버십 가드(secm.deleted_at IS NULL)가 동일함',
    sectionBranch.includes('secm.deleted_at IS NULL') && sectionMsgBranch.includes('secm.deleted_at IS NULL')
  );
}

// ── ⑧ 태스크 델타(신규 접근 스냅샷 브랜치)가 캘린더의 deleted_at을 확인한다 ─────
// cascade가 실패했거나 과거 데이터가 남아 태스크 자신은 deleted_at이 없는데 캘린더만 삭제된
// 경우를 재현 — 방어선(c.deleted_at IS NULL)이 독자적으로 작동하는지를 cascade 성공 여부와
// 분리해서 검증한다.
async function testTaskSnapshotChecksCalendarDeletedAt() {
  const calendars = {
    calDeleted: { id: 'calDeleted', binder_id: 'bNew', deleted_at: 'T_DEL' },
    calAlive: { id: 'calAlive', binder_id: 'bNew', deleted_at: null },
  };
  const tasks = [
    // cascade 실패를 가정 — 태스크 자신의 deleted_at은 비어 있음. c.deleted_at 방어선이 없으면 샌다.
    { id: 'tkOrphan', calendar_id: 'calDeleted', deleted_at: null, created_at: new Date(), updated_at: new Date() },
    { id: 'tkHealthy', calendar_id: 'calAlive', deleted_at: null, created_at: new Date(), updated_at: new Date() },
  ];

  const pool = {
    async query(sql, params) {
      const s = norm(sql);
      const [, , , newDIds] = params;
      const hasCalendarGuard = s.includes('t.deleted_at IS NULL AND c.deleted_at IS NULL');
      const rows = tasks.filter((t) => {
        const cal = calendars[t.calendar_id];
        if (!newDIds.includes(cal.binder_id)) return false;
        if (t.deleted_at) return false;
        if (hasCalendarGuard && cal.deleted_at) return false;
        return true;
      });
      return { rows };
    },
  };

  const ctx = {
    oldDIds: [], oldCIds: [], oldTs: new Date(0),
    newDIds: ['bNew'], newCIds: [], calWindowFrom: new Date(0),
  };

  const rows = await SyncDAO.getTasksDeltaFull(pool, ctx);
  const ids = rows.map((r) => r.id);
  check('⑧ 삭제된 캘린더 밑의 고아 태스크(tkOrphan)는 방어선에 걸려 스냅샷에서 배제', !ids.includes('tkOrphan'));
  check('⑧ 살아있는 캘린더의 태스크(tkHealthy)는 정상 포함', ids.includes('tkHealthy'));
}

async function run() {
  await testCalendarCascadeAllTables();
  await testBinderCascadeRecursive();
  await testAlreadyDeletedNotOverwritten();
  await testLastCalendarBlockedViaService();
  await testBulkInstancesProcessedAsSet();
  await testSyncExcludesDeletedBinder();
  await testTombstoneDeliveredToOtherMember();
  await testEventSectionsLeftJoinExcludesDeletedLink();
  await testTaskSectionsLeftJoinExcludesDeletedLink();
  testActivityFeedSectionBranchesSymmetric();
  await testTaskSnapshotChecksCalendarDeletedAt();

  console.log(`\n[deleteCascadeRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[deleteCascadeRegression] 실행 실패:', error);
  process.exitCode = 1;
});
