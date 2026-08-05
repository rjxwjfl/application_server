/**
 * src/services/emitBinderIdRegression.test.js
 * =========================================
 * RLY-20260806-016 (A-NEW-13) emit binder_id 조작 차단 회귀 스위트.
 *
 * eventBus.emit('sync'|'alert', …)의 binder_id는 sendToTopic('binder_{id}') 브로드캐스트·
 * audit_logs.binder_id·activity_feeds.binder_id를 동시에 먹인다. 요청 본문의 data.binder_id를
 * 그대로 쓰면 인증만 통과한 사용자가 임의 바인더에 알림을 뿌리고 감사·피드 행을 주입할 수 있다.
 *
 * 이 스위트는 실제 서비스 코드에 "공격자가 자신이 속하지 않은(또는 실제 항목과 무관한) 바인더
 * id를 payload에 실었을 때" emit이 DB 유래 값을 쓰는지 — 클라 값을 쓰지 않는지 — 를 직접
 * eventBus 리스너로 스파이해서 단언한다. authzRegression.test.js와 동일 관행(가짜 DB
 * connection, plain assert, `node <file>.js` 직접 실행)을 따른다.
 *
 * 실행: node src/services/emitBinderIdRegression.test.js
 */

const assert = require('assert');

// ── config/db.js를 가짜 커넥션으로 교체(require.cache 주입) ───────────────────
const dbPath = require.resolve('../../config/db');

const NOW = new Date().toISOString();

const db = {
  binder_members: {},
  calendars: {},
  sections: {},
  section_messages: {},
};

function setMember(binderId, userId, role) {
  db.binder_members[`${binderId}:${userId}`] = {
    binder_id: binderId, user_id: userId, role,
    notification_level: 1, nickname_in_binder: null, joined_at: NOW, deleted_at: null,
  };
}

// ── 픽스처 ──────────────────────────────────────────────────────────────
// b1 = 실제 항목이 속한 정당한 바인더. u1은 b1의 일반 멤버(role=3), manager1은 b1의 manager(role=1).
// evil-binder = 공격자가 emit payload에 실어 오염을 노리는 "임의의 남의 바인더" — u1/manager1은
// 여기 멤버가 아니며, mock DB에도 등록하지 않는다(정상 흐름이라면 조회조차 되지 않아야 한다).
setMember('b1', 'u1', 3);
setMember('b1', 'manager1', 1);

db.calendars.c1 = { id: 'c1', binder_id: 'b1', title: 'Cal1', description: null, color: 0, is_public: false, created_at: NOW, updated_at: NOW, deleted_at: null };
db.sections.s1 = { id: 's1', binder_id: 'b1', title: 'Sec1', access_scope: 0, is_default: false, created_at: NOW, updated_at: NOW, deleted_at: null };
db.section_messages.m1 = { id: 'm1', section_id: 's1', user_id: 'u1', parent_id: null, content: 'hi', mention_everyone: false, is_pinned: false, created_at: NOW, updated_at: NOW, deleted_at: null };

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();

  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // BinderDAO.getMember
  if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
    const row = db.binder_members[`${params[0]}:${params[1]}`];
    return { rows: row ? [row] : [] };
  }
  // CalendarDAO.findById
  if (s.includes('FROM calendars') && s.includes('WHERE id = $1')) {
    const row = db.calendars[params[0]];
    return { rows: row ? [row] : [] };
  }
  // SectionDAO.findById
  if (s.includes('FROM sections WHERE id = $1')) {
    const row = db.sections[params[0]];
    return { rows: row ? [row] : [] };
  }
  // SectionDAO.create — 반환 행의 binder_id가 sectionService.createSection의 emit에 쓰인다
  if (s.startsWith('INSERT INTO sections')) {
    const [id, binder_id, title, access_scope] = params;
    return { rows: [{ id, binder_id, title, access_scope, is_default: false, created_at: NOW, updated_at: NOW }] };
  }
  // MessageDAO.findById
  if (s.includes('FROM section_messages') && s.includes('WHERE id = $1') && s.startsWith('SELECT')) {
    const row = db.section_messages[params[0]];
    return { rows: row ? [row] : [] };
  }
  // MessageDAO.update
  if (s.startsWith('UPDATE section_messages')) {
    const [content, messageId] = params;
    const row = db.section_messages[messageId];
    return { rows: row ? [{ ...row, content: content ?? row.content }] : [] };
  }
  // AttachmentDAO.findByContext(postService.withAttachments) — 응답 조립용, 인가·binder_id와 무관
  if (s.includes('FROM attachments') && s.includes('context_type')) return { rows: [] };

  // 그 외 INSERT/UPDATE(events·tasks·posts·event_instances·event_participants 등) — 이 회귀의
  // 관심사는 emit binder_id 출처뿐이므로, id만 메아리치는 최소 응답으로 흉내낸다.
  if (s.startsWith('INSERT INTO') || s.startsWith('UPDATE ')) {
    return { rows: [{ id: params[0] }] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const mockDb = {
  query: mockQuery,
  connect: async () => ({ query: mockQuery, release() {} }),
};

require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

// ── 실제 서비스 로드(가짜 DB가 주입된 뒤) ─────────────────────────────────
const { EventService } = require('./eventService');
const { TaskService } = require('./taskService');
const { SectionService } = require('./sectionService');
const { PostService } = require('./postService');
const { MessageService } = require('./messageService');
const eventBus = require('../events/eventBus');

const ctx = (userId) => ({ sender_id: userId, device_uuid: 'dev-1' });

let pass = 0;
let fail = 0;
const failures = [];

/**
 * fn 실행 중 eventBus가 emit('sync'|'alert', …)로 내보내는 모든 payload를 수집해 반환한다.
 * 실제 audit/feed/push consumer(핸들러)는 별도로 등록돼 있지 않으므로 fn 자체의 부수효과는 없다.
 */
async function captureEmits(fn) {
  const captured = [];
  const onSync = (payload) => captured.push({ event: 'sync', payload });
  const onAlert = (payload) => captured.push({ event: 'alert', payload });
  eventBus.on('sync', onSync);
  eventBus.on('alert', onAlert);
  try {
    await fn();
  } finally {
    eventBus.off('sync', onSync);
    eventBus.off('alert', onAlert);
  }
  return captured;
}

async function expectEmitBinderId(desc, fn, eventName, expectedBinderId) {
  try {
    const captured = await captureEmits(fn);
    const match = captured.find((c) => c.event === eventName);
    if (!match) {
      fail++;
      failures.push(`${desc}: '${eventName}' emit이 전혀 발생하지 않음(캡처 ${captured.length}건: ${captured.map((c) => c.event).join(',')})`);
      return;
    }
    if (match.payload.binder_id === expectedBinderId) {
      pass++;
    } else {
      fail++;
      failures.push(`${desc}: binder_id 예상 '${expectedBinderId}', 실제 '${match.payload.binder_id}'`);
    }
  } catch (err) {
    fail++;
    failures.push(`${desc}: 예상치 못한 에러 — ${err.statusCode || ''} ${err.message}`);
  }
}

async function expectStatus(desc, fn, expectedStatus) {
  try {
    await fn();
    fail++;
    failures.push(`${desc}: 예상 ${expectedStatus} — 통과해버림(에러 없음)`);
  } catch (err) {
    if (err.statusCode === expectedStatus) {
      pass++;
    } else {
      fail++;
      failures.push(`${desc}: 예상 ${expectedStatus}, 실제 ${err.statusCode || '(non-AppError) ' + err.message}`);
    }
  }
}

async function run() {
  const EVIL = 'evil-binder'; // u1/manager1 어디의 멤버도 아닌, 공격자가 payload에 실어 오염을 노리는 바인더

  // ============ eventService.createEvent — calendar_id(c1→b1)와 별개 필드인 binder_id를
  //              공격자가 EVIL로 실어도 sync/alert 모두 b1을 써야 한다 ============
  await expectEmitBinderId(
    'Event.createEvent sync — calendar_id 기반 b1, payload binder_id=EVIL 무시',
    () => EventService.createEvent({ id: 'e-new', calendar_id: 'c1', binder_id: EVIL, summary: 'x' }, ctx('u1')),
    'sync', 'b1'
  );
  await expectEmitBinderId(
    'Event.createEvent alert(참가자 배정) — payload binder_id=EVIL 무시',
    () => EventService.createEvent({
      id: 'e-new2', calendar_id: 'c1', binder_id: EVIL, summary: 'x', binder_name: 'x',
      instances: [{ id: 'ei-new', participants: [{ user_id: 'other-user' }] }],
    }, ctx('u1')),
    'alert', 'b1'
  );

  // ============ taskService.createTask — 동일 패턴 ============
  await expectEmitBinderId(
    'Task.createTask sync — calendar_id 기반 b1, payload binder_id=EVIL 무시',
    () => TaskService.createTask({ id: 't-new', calendar_id: 'c1', binder_id: EVIL, summary: 'x' }, ctx('u1')),
    'sync', 'b1'
  );

  // ============ messageService.updateMessage — message.binder_id 컬럼이 애초에 없어
  //              fallback이 사실상 항상 data.binder_id로 떨어지던 지점. section 경유 도출 검증 ============
  await expectEmitBinderId(
    'Message.updateMessage sync — section 경유 b1, payload binder_id=EVIL 무시',
    () => MessageService.updateMessage('m1', { binder_id: EVIL, content: 'edited' }, ctx('u1')),
    'sync', 'b1'
  );

  // ============ sectionService.createSection — data.binder_id가 곧 인가 대상 바인더라 값
  //              자체의 조작 여지는 없지만(비회원 바인더는 403), 생성된 행의 binder_id가
  //              emit에 정확히 흘러가는지 회귀 고정 ============
  await expectEmitBinderId(
    'Section.createSection sync — 생성된 행의 binder_id(b1)가 emit에 그대로',
    () => SectionService.createSection({ id: 'sec-new', binder_id: 'b1', title: 'New' }, ctx('manager1')),
    'sync', 'b1'
  );
  await expectStatus(
    'Section.createSection EVIL 바인더는 비멤버라 403(값 조작이 아니라 인가로 차단됨을 확인)',
    () => SectionService.createSection({ id: 'sec-new2', binder_id: EVIL, title: 'New' }, ctx('manager1')),
    403
  );

  // ============ postService.create — data.binder_id가 곧 인가 대상 바인더. member.binder_id
  //              (DB 유래) 사용 회귀 고정 ============
  await expectEmitBinderId(
    'Post.create sync — member 조회로 확인된 binder_id(b1)가 emit에',
    () => PostService.create({ id: 'post-new', binder_id: 'b1', title: 'T', body_markdown: 'x' }, ctx('u1')),
    'sync', 'b1'
  );

  console.log(`\n[emitBinderIdRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[emitBinderIdRegression] 실행 실패:', error);
  process.exitCode = 1;
});
