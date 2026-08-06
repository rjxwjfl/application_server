/**
 * src/jobs/reminderDispatchRegression.test.js
 * =========================================
 * RLY-20260806-032 리마인더 발송 파이프라인(2단계) 회귀 스위트.
 *
 * 기존 관행(plain assert + `node <file>.js` 직접 실행, 가짜 DB connection·가짜 fcm 모듈로 실제
 * job 코드를 구동)을 따른다. 실제 Postgres·FCM이 없어 SQL 문법·FCM 프로토콜 자체는 검증하지
 * 못한다 — 이 스위트가 검증하는 것은 dispatch 로직(claim·수신자 술어·롤링·재시도)이 맞는가다.
 *
 * ⑥(동시 claim 중복 발송 방지)은 실제 동시성을 mock으로 재현하기 어려워, team-lead 지시대로
 * claimDueBatch의 SQL 문자열이 "조회 후 갱신"이 아니라 단일 원자적 UPDATE(FOR UPDATE SKIP
 * LOCKED를 포함한 서브쿼리 + 그 결과를 바로 UPDATE)인지 정적으로 단언한다.
 *
 * 실행: node src/jobs/reminderDispatchRegression.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// attachmentHardDeleteRegression.test.js와 동일 관행 — logger.js가 ../configs를 (fcm과
// 무관하게도) require해 PGHOST 등을 즉시 검증한다. 실 연결은 안 하고(config/db.js를 통째로
// mock) 값만 채워 requireEnv 통과시킨다.
process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test';
process.env.PGDATABASE = process.env.PGDATABASE || 'test';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test';

let pass = 0;
let fail = 0;
const failures = [];

function check(desc, condition) {
  if (condition) pass += 1;
  else { fail += 1; failures.push(`${desc}: 단언 실패`); }
}

async function expectOk(desc, fn) {
  try {
    const result = await fn();
    pass += 1;
    return result;
  } catch (err) {
    fail += 1;
    failures.push(`${desc}: 정상 통과를 기대했지만 에러 — ${err.message}\n${err.stack}`);
    return undefined;
  }
}

// ════════════════════════════════════════════════════════════════════════
// ⑥ claim 원자성 — SQL 문자열 정적 단언(실동시성 재현 대신)
// ════════════════════════════════════════════════════════════════════════
(function assertClaimIsAtomic() {
  const src = fs.readFileSync(path.join(__dirname, '../daos/reminderDAO.js'), 'utf8');
  const m = src.match(/async claimDueBatch\(conn, \{[^}]*\}\) \{([\s\S]*?)\n  \}/);
  check('claimDueBatch 메서드를 찾음', !!m);
  const body = m ? m[1].replace(/\s+/g, ' ') : '';
  // "조회 후 갱신"이 아니라 단일 UPDATE 문 하나뿐이어야 한다 — SELECT가 그 UPDATE의
  // 서브쿼리(WHERE id IN (SELECT ...)) 안에만 있고, 별도의 최상위 SELECT/UPDATE 왕복이 없다.
  const updateCount = (body.match(/\bUPDATE reminders\b/g) || []).length;
  check('⑥ claimDueBatch — UPDATE 문이 정확히 1개(조회 후 별도 갱신 아님)', updateCount === 1);
  check('⑥ claimDueBatch — FOR UPDATE SKIP LOCKED 서브쿼리 포함', /FOR UPDATE SKIP LOCKED/.test(body));
  check('⑥ claimDueBatch — SELECT가 UPDATE의 WHERE id IN (...) 서브쿼리 안에 있음(별도 SELECT 왕복 아님)', /WHERE id IN \(\s*SELECT id FROM reminders/.test(body));
  check('⑥ claimDueBatch — claim_token을 SET하는 단일 문(RETURNING으로 결과 확보, 재조회 없음)', /SET claim_token = \$1/.test(body) && /RETURNING/.test(body));
})();

// ════════════════════════════════════════════════════════════════════════
// ⑤ SQL↔실 스키마 정적 대조 — 신규 코드(getRecipients·claimDueBatch 등)에도 적용(지시)
// ════════════════════════════════════════════════════════════════════════
const schemaSql = fs.readFileSync(path.join(__dirname, '../../config/schema.sql'), 'utf8');

function stripCheckBlocks(text) {
  let out = ''; let i = 0;
  while (i < text.length) {
    const idx = text.indexOf('CHECK', i);
    if (idx === -1) { out += text.slice(i); break; }
    out += text.slice(i, idx);
    let j = idx + 5;
    while (j < text.length && /\s/.test(text[j])) j += 1;
    if (text[j] !== '(') { out += text.slice(idx, j); i = j; continue; }
    let depth = 1; j += 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '(') depth += 1; else if (text[j] === ')') depth -= 1;
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
  let depth = 1; let j = start;
  while (j < schemaSql.length && depth > 0) {
    if (schemaSql[j] === '(') depth += 1; else if (schemaSql[j] === ')') depth -= 1;
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
  columns.forEach((col) => check(`⑤ ${desc}: ${tableName}.${col} 존재`, real.has(col)));
}

// getRecipients·claimDueBatch·findClaimedWithDetails가 참조하는 컬럼 전부.
assertColumnsExist('ReminderDAO.getRecipients(binder_members)', 'binder_members', ['binder_id', 'user_id', 'role', 'notification_level', 'deleted_at']);
assertColumnsExist('ReminderDAO.getRecipients(event_participants)', 'event_participants', ['instance_id', 'user_id', 'state', 'deleted_at']);
assertColumnsExist('ReminderDAO.getRecipients(task_participants)', 'task_participants', ['instance_id', 'user_id', 'state', 'deleted_at']);
assertColumnsExist('ReminderDAO.getRecipients(special_days)', 'special_days', ['id', 'calendar_id', 'author_id']);
assertColumnsExist('ReminderDAO.findClaimedWithDetails(event_instances)', 'event_instances', ['id', 'event_id', 'start_date', 'deleted_at']);
assertColumnsExist('ReminderDAO.findClaimedWithDetails(task_instances)', 'task_instances', ['id', 'task_id', 'due_date', 'deleted_at']);
assertColumnsExist('ReminderDAO.findClaimedWithDetails(special_days lunar)', 'special_days', ['base_date', 'r_rule', 'is_lunar', 'lunar_month', 'lunar_day', 'lunar_is_leap_month']);
assertColumnsExist('NotificationDAO.getActiveTokensByUserIds(user_devices)', 'user_devices', ['user_id', 'device_token', 'is_active']);

// §2-A-1 대응표 — 문서 표 ↔ 코드 조건. 표가 바뀌면 이 배열과 SQL을 함께 갱신한다.
const SC_REMINDER_2A1_MAPPING = [
  { row: 'Event 참가자: confirm·accept·tentative·invite·apply 포함, decline·rejected 제외', condition: "ep.state NOT IN (5, 6)" },
  { row: 'Task 참여자: ready·inProgress·onHold 포함, done 제외', condition: "tp.state != 3" },
  { row: 'SpecialDay: 소유자(author_id)', condition: 'sd.author_id = 해당 유저(참가자 테이블 조인 없음)' },
];
(function assertRecipientPredicateMatchesDoc() {
  const src = fs.readFileSync(path.join(__dirname, '../daos/reminderDAO.js'), 'utf8');
  check('§2-A-1 Event 제외 조건이 코드에 그대로 있음(state NOT IN (5, 6))', /ep\.state NOT IN \(5, 6\)/.test(src));
  check('§2-A-1 Task 제외 조건이 코드에 그대로 있음(state != 3)', /tp\.state != 3/.test(src));
  check('§2-A-2 notification_level<=1(결정 63)이 코드 상수로 고정됨', /MAX_NOTIFICATION_LEVEL_FOR_REMINDER = 1/.test(src));
  check('대응표 3행이 모두 채워짐(문서 추적용)', SC_REMINDER_2A1_MAPPING.length === 3);
})();

// ════════════════════════════════════════════════════════════════════════
// 서비스 레이어 — mock DB·mock fcm으로 실제 job 코드 구동
// ════════════════════════════════════════════════════════════════════════
const dbPath = require.resolve('../../config/db');
const fcmPath = require.resolve('../utils/fcm');
const NOW = new Date();

const db = {
  reminders: {},
  event_instances: {},
  events: {},
  task_instances: {},
  tasks: {},
  special_days: {},
  binder_members: {}, // key: `${binderId}:${userId}`
  event_participants: {}, // key: `${instanceId}:${userId}`
  task_participants: {},
  calendars: {},
  user_devices: {}, // key: userId -> [devices]
  notifications: [],
};

function setMember(binderId, userId, role, notificationLevel = 0) {
  db.binder_members[`${binderId}:${userId}`] = {
    binder_id: binderId, user_id: userId, role, notification_level: notificationLevel, deleted_at: null,
  };
}
function setDevice(userId, token) {
  if (!db.user_devices[userId]) db.user_devices[userId] = [];
  db.user_devices[userId].push({ user_id: userId, device_token: token, is_active: true });
}

db.calendars.cal1 = { id: 'cal1', binder_id: 'b1' };
setMember('b1', 'author1', 0, 0);

const fcmCalls = [];
const fcmMock = {
  sendMulticast: async (tokens, notification, data) => {
    fcmCalls.push({ tokens, notification, data });
    if (fcmMock._shouldFail) throw new Error('fake FCM outage');
    return { successCount: tokens.length, failureCount: 0, staleTokens: [] };
  },
  sendToTopic: async () => ({}),
  subscribeToTopic: async () => ({}),
  unsubscribeFromTopic: async () => ({}),
  _shouldFail: false,
};
require.cache[fcmPath] = { id: fcmPath, filename: fcmPath, loaded: true, exports: fcmMock };

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();

  // ── claimDueBatch ──────────────────────────────────────────────────────
  if (s.startsWith('UPDATE reminders') && s.includes('SET claim_token = $1')) {
    const [claimToken, leaseMinutes, maxAttempts, limit] = params;
    const now = Date.now();
    const leaseMs = leaseMinutes * 60 * 1000;
    const candidates = Object.values(db.reminders).filter((r) => {
      if (new Date(r.trigger_at).getTime() > now) return false;
      if (r.sent_at != null) return false;
      const leaseOk = !r.claim_token || (r.claimed_at && new Date(r.claimed_at).getTime() < now - leaseMs);
      if (!leaseOk) return false;
      const backoffOk = !r.next_attempt_at || new Date(r.next_attempt_at).getTime() <= now;
      if (!backoffOk) return false;
      if (r.attempt_count >= maxAttempts) return false;
      return true;
    }).sort((a, b) => new Date(a.trigger_at) - new Date(b.trigger_at)).slice(0, limit);

    candidates.forEach((r) => {
      r.claim_token = claimToken;
      r.claimed_at = new Date().toISOString();
      r.attempt_count += 1;
      r.updated_at = new Date().toISOString();
    });
    return { rows: candidates.map((r) => ({ ...r })) };
  }

  // ── findClaimedWithDetails ───────────────────────────────────────────────
  if (s.startsWith('SELECT r.id, r.target_type') && s.includes('FROM reminders r')) {
    const ids = params[0];
    const rows = [];
    ids.forEach((id) => {
      const r = db.reminders[id];
      if (!r) return;
      if (r.target_type === 0) {
        const ei = db.event_instances[r.target_id];
        if (!ei || ei.deleted_at) return;
        const ev = db.events[ei.event_id];
        rows.push({
          id: r.id, target_type: r.target_type, target_id: r.target_id, trigger_offset: r.trigger_offset,
          trigger_at: r.trigger_at, timezone: r.timezone, claim_token: r.claim_token, attempt_count: r.attempt_count,
          summary: ei.summary || (ev && ev.summary) || '일정',
          event_id: ei.event_id, event_start_date: ei.start_date,
          task_id: null, task_due_date: null,
          special_day_author_id: null, special_day_base_date: null, special_day_r_rule: null,
          special_day_is_lunar: null, special_day_lunar_month: null, special_day_lunar_day: null, special_day_lunar_is_leap_month: null,
        });
      } else if (r.target_type === 1) {
        const ti = db.task_instances[r.target_id];
        if (!ti || ti.deleted_at) return;
        const tk = db.tasks[ti.task_id];
        rows.push({
          id: r.id, target_type: r.target_type, target_id: r.target_id, trigger_offset: r.trigger_offset,
          trigger_at: r.trigger_at, timezone: r.timezone, claim_token: r.claim_token, attempt_count: r.attempt_count,
          summary: ti.summary || (tk && tk.summary) || '할 일',
          event_id: null, event_start_date: null,
          task_id: ti.task_id, task_due_date: ti.due_date,
          special_day_author_id: null, special_day_base_date: null, special_day_r_rule: null,
          special_day_is_lunar: null, special_day_lunar_month: null, special_day_lunar_day: null, special_day_lunar_is_leap_month: null,
        });
      } else {
        const sd = db.special_days[r.target_id];
        if (!sd || sd.deleted_at) return;
        rows.push({
          id: r.id, target_type: r.target_type, target_id: r.target_id, trigger_offset: r.trigger_offset,
          trigger_at: r.trigger_at, timezone: r.timezone, claim_token: r.claim_token, attempt_count: r.attempt_count,
          summary: sd.name,
          event_id: null, event_start_date: null, task_id: null, task_due_date: null,
          special_day_author_id: sd.author_id, special_day_base_date: sd.base_date, special_day_r_rule: sd.r_rule,
          special_day_is_lunar: sd.is_lunar, special_day_lunar_month: sd.lunar_month, special_day_lunar_day: sd.lunar_day,
          special_day_lunar_is_leap_month: sd.lunar_is_leap_month,
        });
      }
    });
    return { rows };
  }

  // ── getRecipients: special_day ────────────────────────────────────────
  if (s.startsWith('SELECT bm.user_id') && s.includes('FROM special_days sd')) {
    const [targetId, maxLevel] = params;
    const sd = db.special_days[targetId];
    if (!sd) return { rows: [] };
    const cal = db.calendars[sd.calendar_id];
    const bm = db.binder_members[`${cal.binder_id}:${sd.author_id}`];
    if (!bm || bm.deleted_at || bm.role < 0 || bm.notification_level > maxLevel) return { rows: [] };
    return { rows: [{ user_id: sd.author_id }] };
  }

  // ── getRecipients: event ─────────────────────────────────────────────
  if (s.startsWith('SELECT bm.user_id') && s.includes('FROM event_participants ep')) {
    const [instanceId, maxLevel] = params;
    const ei = db.event_instances[instanceId];
    const ev = ei && db.events[ei.event_id];
    const cal = ev && db.calendars[ev.calendar_id];
    const rows = Object.values(db.event_participants)
      .filter((ep) => ep.instance_id === instanceId && !ep.deleted_at && ![5, 6].includes(ep.state))
      .map((ep) => db.binder_members[`${cal.binder_id}:${ep.user_id}`])
      .filter((bm) => bm && !bm.deleted_at && bm.role >= 0 && bm.notification_level <= maxLevel)
      .map((bm) => ({ user_id: bm.user_id }));
    return { rows };
  }

  // ── getRecipients: task ──────────────────────────────────────────────
  if (s.startsWith('SELECT bm.user_id') && s.includes('FROM task_participants tp')) {
    const [instanceId, maxLevel] = params;
    const ti = db.task_instances[instanceId];
    const tk = ti && db.tasks[ti.task_id];
    const cal = tk && db.calendars[tk.calendar_id];
    const rows = Object.values(db.task_participants)
      .filter((tp) => tp.instance_id === instanceId && !tp.deleted_at && tp.state !== 3)
      .map((tp) => db.binder_members[`${cal.binder_id}:${tp.user_id}`])
      .filter((bm) => bm && !bm.deleted_at && bm.role >= 0 && bm.notification_level <= maxLevel)
      .map((bm) => ({ user_id: bm.user_id }));
    return { rows };
  }

  // ── NotificationDAO.getActiveTokensByUserIds ────────────────────────
  if (s.startsWith('SELECT user_id, device_token, device_uuid') && s.includes('FROM user_devices')) {
    const userIds = params[0];
    const rows = [];
    userIds.forEach((uid) => (db.user_devices[uid] || []).forEach((d) => rows.push(d)));
    return { rows };
  }

  // ── NotificationDAO.deactivateTokens ─────────────────────────────────
  if (s.startsWith('UPDATE user_devices') && s.includes('is_active = FALSE')) {
    return { rows: [] };
  }

  // ── NotificationDAO.insertNotificationsBulk ──────────────────────────
  if (s.startsWith('INSERT INTO notifications')) {
    db.notifications.push({ params });
    return { rows: [] };
  }

  // ── markSent / rollSpecialDay / markFailed / giveUp ──────────────────
  if (s.startsWith('UPDATE reminders SET sent_at = now()')) {
    const [id, claimToken] = params;
    const r = db.reminders[id];
    if (r && r.claim_token === claimToken) {
      r.sent_at = new Date().toISOString();
      return { rows: [{ id }] };
    }
    return { rows: [] };
  }
  if (s.startsWith('UPDATE reminders') && s.includes('SET trigger_at = $1, attempt_count = 0')) {
    const [nextTriggerAt, id, claimToken] = params;
    const r = db.reminders[id];
    if (r && r.claim_token === claimToken) {
      r.trigger_at = nextTriggerAt;
      r.attempt_count = 0;
      r.claim_token = null;
      r.claimed_at = null;
      r.next_attempt_at = null;
      return { rows: [{ id }] };
    }
    return { rows: [] };
  }
  if (s.startsWith('UPDATE reminders') && s.includes('SET claim_token = NULL, claimed_at = NULL, next_attempt_at = $1')) {
    const [nextAttemptAt, id, claimToken] = params;
    const r = db.reminders[id];
    if (r && r.claim_token === claimToken) {
      r.next_attempt_at = nextAttemptAt;
      r.claim_token = null;
      r.claimed_at = null;
      return { rows: [{ id }] };
    }
    return { rows: [] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { dispatchReminders, formatOffsetPhrase, backoffMinutes } = require('./reminderJobs');

function isoMinutesAgo(min) {
  return new Date(Date.now() - min * 60 * 1000).toISOString();
}
function isoMinutesFromNow(min) {
  return new Date(Date.now() + min * 60 * 1000).toISOString();
}

async function run() {
  // ── 픽스처: ① due 이벤트 리마인더 ─────────────────────────────────────
  db.events.ev1 = { id: 'ev1', calendar_id: 'cal1', summary: '팀 회의' };
  db.event_instances.evi1 = { id: 'evi1', event_id: 'ev1', start_date: isoMinutesFromNow(30), summary: null, deleted_at: null };
  setMember('b1', 'confirmedUser', 3, 0);
  db.event_participants['evi1:confirmedUser'] = { instance_id: 'evi1', user_id: 'confirmedUser', state: 0, deleted_at: null }; // confirm
  setDevice('confirmedUser', 'tok-confirmed');
  db.reminders.r1 = {
    id: 'r1', target_type: 0, target_id: 'evi1', trigger_offset: 1800, trigger_at: isoMinutesAgo(1),
    timezone: null, claim_token: null, claimed_at: null, attempt_count: 0, next_attempt_at: null, sent_at: null,
  };

  // ③ 비접근자(decline) — 같은 회차에 decline 참가자 추가
  setMember('b1', 'declinedUser', 3, 0);
  db.event_participants['evi1:declinedUser'] = { instance_id: 'evi1', user_id: 'declinedUser', state: 5, deleted_at: null }; // decline
  setDevice('declinedUser', 'tok-declined');

  // ④ notification_level 2 이상 — 같은 회차에 멘션만(2) 설정된 참가자
  setMember('b1', 'mutedUser', 3, 2);
  db.event_participants['evi1:mutedUser'] = { instance_id: 'evi1', user_id: 'mutedUser', state: 0, deleted_at: null };
  setDevice('mutedUser', 'tok-muted');

  // ⑤ 대기 신청자 — binder_members에 아예 없는(=승인 대기) 참가자 행(방어적 케이스 — 참가자
  // 테이블에 있더라도 binder_members가 없으면 JOIN에서 자동 탈락함을 검증)
  db.event_participants['evi1:pendingApplicant'] = { instance_id: 'evi1', user_id: 'pendingApplicant', state: 0, deleted_at: null };
  setDevice('pendingApplicant', 'tok-pending');

  await expectOk('① due 리마인더 dispatch 실행', () => dispatchReminders());

  check('① due 리마인더가 발송 처리됨(sent_at 기록)', db.reminders.r1.sent_at != null);
  check('① FCM이 실제로 호출됨', fcmCalls.length === 1);
  const sentTokens = fcmCalls[0].tokens;
  check('① 접근권 있고 알림 켜진 참가자에게만 발송(confirmedUser 포함)', sentTokens.includes('tok-confirmed'));
  check('③ decline 참가자는 제외됨', !sentTokens.includes('tok-declined'));
  check('④ notification_level=2(멘션만) 참가자는 제외됨', !sentTokens.includes('tok-muted'));
  check('⑤ binder_members 없는(대기) 참가자는 제외됨', !sentTokens.includes('tok-pending'));
  check('발송 대상이 정확히 1명(confirmedUser)', sentTokens.length === 1);

  // ── ② 삭제된 항목의 리마인더 미발송 ──────────────────────────────────
  fcmCalls.length = 0;
  db.event_instances.evi2 = { id: 'evi2', event_id: 'ev1', start_date: isoMinutesFromNow(30), deleted_at: new Date().toISOString() };
  db.reminders.r2 = {
    id: 'r2', target_type: 0, target_id: 'evi2', trigger_offset: 1800, trigger_at: isoMinutesAgo(1),
    timezone: null, claim_token: null, claimed_at: null, attempt_count: 0, next_attempt_at: null, sent_at: null,
  };
  await expectOk('② 삭제된 회차의 리마인더 dispatch 실행', () => dispatchReminders());
  check('② 삭제된 회차는 FCM 발송이 일어나지 않음', fcmCalls.length === 0);
  check('② 삭제된 회차의 리마인더는 claim이 정리됨(sent_at으로 종결, 재발송 방지)', db.reminders.r2.sent_at != null);

  // ── ⑦ SpecialDay 롤링 후 sent_at NULL ────────────────────────────────
  fcmCalls.length = 0;
  db.special_days.sd1 = {
    id: 'sd1', calendar_id: 'cal1', author_id: 'author1', name: '엄마 생신',
    base_date: '2026-04-15', r_rule: 'FREQ=YEARLY', is_lunar: false,
    lunar_month: null, lunar_day: null, lunar_is_leap_month: null, deleted_at: null,
  };
  setMember('b1', 'author1', 0, 0);
  setDevice('author1', 'tok-author');
  const sdTriggerAt = new Date(Date.UTC(2026, 3, 15, 0, 0, 0) - 1000); // 09:00 KST 2026-04-15 - 1000초
  db.reminders.r3 = {
    id: 'r3', target_type: 2, target_id: 'sd1', trigger_offset: 1000, trigger_at: sdTriggerAt.toISOString(),
    timezone: 'Asia/Seoul', claim_token: null, claimed_at: null, attempt_count: 0, next_attempt_at: null, sent_at: null,
  };
  await expectOk('⑦ SpecialDay 리마인더 dispatch 실행', () => dispatchReminders());
  check('⑦ SpecialDay는 발송 후에도 sent_at이 NULL로 남음(영구, 롤링)', db.reminders.r3.sent_at == null);
  check('⑦ trigger_at이 다음 해로 전진함', new Date(db.reminders.r3.trigger_at).getUTCFullYear() === 2027);
  check('⑦ 롤링 후 attempt_count·claim_token 초기화됨', db.reminders.r3.attempt_count === 0 && db.reminders.r3.claim_token === null);

  // ── ⑧ 실패 재시도 상한 ────────────────────────────────────────────────
  fcmMock._shouldFail = true;
  db.event_instances.evi4 = { id: 'evi4', event_id: 'ev1', start_date: isoMinutesFromNow(30), deleted_at: null };
  setMember('b1', 'retryUser', 3, 0);
  db.event_participants['evi4:retryUser'] = { instance_id: 'evi4', user_id: 'retryUser', state: 0, deleted_at: null };
  setDevice('retryUser', 'tok-retry');
  db.reminders.r4 = {
    id: 'r4', target_type: 0, target_id: 'evi4', trigger_offset: 1800, trigger_at: isoMinutesAgo(1),
    timezone: null, claim_token: null, claimed_at: null, attempt_count: 0, next_attempt_at: null, sent_at: null,
  };
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await expectOk(`⑧ 실패 재시도 tick #${i + 1}`, () => dispatchReminders());
    // next_attempt_at 백오프 때문에 다음 tick에서 다시 claim되게 즉시 만료시킨다(테스트 전용 — 실제로는 시간 경과로 자연히 지남).
    if (db.reminders.r4.next_attempt_at) db.reminders.r4.next_attempt_at = isoMinutesAgo(1);
  }
  check('⑧ MAX_ATTEMPTS(5)까지만 시도됨', db.reminders.r4.attempt_count === 5);
  check('⑧ 상한 도달 후 포기 처리(sent_at 기록 — 무한 재시도 아님, GC 대상)', db.reminders.r4.sent_at != null);
  // 6번째 tick — 이미 sent_at이 세워져 due 조건(sent_at IS NULL) 자체에서 제외되므로 더 이상 claim되지 않는다.
  const attemptsBefore = db.reminders.r4.attempt_count;
  await expectOk('⑧ 포기 이후 tick — 더 이상 재시도하지 않음', () => dispatchReminders());
  check('⑧ 포기 후에는 attempt_count가 더 늘지 않음', db.reminders.r4.attempt_count === attemptsBefore);
  fcmMock._shouldFail = false;

  // ── 부가 — 문구·백오프 유틸 스모크 ──────────────────────────────────
  check('formatOffsetPhrase(1800) === "30분 후"', formatOffsetPhrase(1800) === '30분 후');
  check('formatOffsetPhrase(86400) === "1일 후"', formatOffsetPhrase(86400) === '1일 후');
  check('backoffMinutes(1) === 1, backoffMinutes(5) === 16(상한)', backoffMinutes(1) === 1 && backoffMinutes(5) === 16);

  console.log(`\n[reminderDispatchRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[reminderDispatchRegression] 실행 실패:', error);
  process.exitCode = 1;
});
