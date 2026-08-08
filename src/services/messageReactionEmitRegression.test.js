/**
 * src/services/messageReactionEmitRegression.test.js
 * =========================================
 * RLY-20260806-179 — MessageService.addReaction·removeReaction이 eventBus.emit('sync') 자체를
 * 아예 안 냈다. design_intent.md "이벤트 버스 흐름"·§16-7(H4)이 ActionType 30~33(PIN·UNPIN·
 * REACT·UNREACT)을 "메시징 → 피드 INSERT"로 명시하고 "모든 도메인 이벤트는 audit_logs와
 * activity_feeds 양쪽에 동시 기록된다"고 규정하는데, PIN·UNPIN은 이미 emit하면서 REACT·
 * UNREACT만 빠져 있었다(153과 같은 부류 — 정책 침묵이 아니라 명시된 규정 누락).
 * addReaction에는 SC-notifications.md E17("내 메시지에 반응 추가됨" → 섹션 메시징 화면
 * 진입)에 대응하는 eventBus.emit('alert')도 추가했다 — notificationService.ALERT_TYPE_MAP에
 * 이미 `reaction: ActionType.REACT`가 있었지만(호출부 없이 방치돼 있었다) 이번에 실제로
 * 사용했다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`. eventBus.on으로 실제 emit을
 * 스파이한다(emitBinderIdRegression.test.js와 동일한 captureEmits 패턴 — feedHandler·
 * notificationHandler·auditHandler는 require하지 않아 부수효과 없이 payload만 검사한다).
 *
 * 실행: node src/services/messageReactionEmitRegression.test.js
 */


const dbPath = require.resolve('../../config/db');
const NOW = new Date('2026-08-08T00:00:00Z').toISOString();

const sections = {
  s1: { id: 's1', binder_id: 'b1', title: 'sec1', access_scope: 0, is_default: false, deleted_at: null },
};
const messages = {
  m1: { id: 'm1', section_id: 's1', user_id: 'author1', parent_id: null, content: 'hi', mention_everyone: false, is_pinned: false, deleted_at: null },
};
const reactionsTable = [];

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // MessageDAO.findById
  if (s.startsWith('SELECT id, section_id, user_id, parent_id, content') && s.includes('FROM section_messages')) {
    const row = messages[params[0]];
    return { rows: row ? [row] : [] };
  }
  // SectionDAO.findById
  if (s.startsWith('SELECT id, binder_id, title, access_scope, is_default') && s.includes('FROM sections')) {
    const row = sections[params[0]];
    return { rows: row ? [row] : [] };
  }
  // MessageDAO.addReaction
  if (s.startsWith('INSERT INTO message_reactions')) {
    const [id, message_id, user_id, emoji] = params;
    const activeRow = reactionsTable.find((r) => r.message_id === message_id && r.user_id === user_id && r.emoji === emoji && !r.deleted_at);
    if (activeRow) { activeRow.updated_at = NOW; return { rows: [{ ...activeRow }] }; }
    const row = { id, message_id, user_id, emoji, created_at: NOW, deleted_at: null };
    reactionsTable.push(row);
    return { rows: [{ ...row }] };
  }
  // MessageDAO.removeReaction
  if (s.startsWith('UPDATE message_reactions')) {
    const [message_id, user_id, emoji] = params;
    const activeRow = reactionsTable.find((r) => r.message_id === message_id && r.user_id === user_id && r.emoji === emoji && !r.deleted_at);
    if (!activeRow) return { rows: [] };
    activeRow.deleted_at = NOW;
    return { rows: [{ id: activeRow.id }] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { MessageService } = require('./messageService');
const eventBus = require('../events/eventBus');
const { ActionType, TargetType } = require('../utils/typeDefinitions');

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond, detail) { if (cond) pass++; else { fail++; failures.push(detail ? `${desc}: ${detail}` : desc); } }

// emitBinderIdRegression.test.js와 동일한 캡처 패턴 — 핸들러는 require하지 않아 부수효과 없다.
async function captureEmits(fn) {
  const captured = [];
  const onSync = (payload) => captured.push({ event: 'sync', payload });
  const onAlert = (payload) => captured.push({ event: 'alert', payload });
  eventBus.on('sync', onSync);
  eventBus.on('alert', onAlert);
  try { await fn(); } finally { eventBus.off('sync', onSync); eventBus.off('alert', onAlert); }
  return captured;
}

const ctx = () => ({ sender_id: 'reactor1', device_uuid: 'dev-reactor' });

async function run() {
  // ============ ① addReaction — sync 이벤트가 정확한 필드로 나간다 ============
  const captured1 = await captureEmits(() => MessageService.addReaction('m1', '❤️', ctx()));
  const sync1 = captured1.find((c) => c.event === 'sync');
  check('① addReaction — sync 이벤트가 나간다(이전엔 아예 없었다)', !!sync1);
  check('① sync.binder_id', sync1?.payload.binder_id === 'b1');
  check('① sync.sender_id', sync1?.payload.sender_id === 'reactor1');
  check('① sync.device_uuid', sync1?.payload.device_uuid === 'dev-reactor');
  check('① sync.action = REACT', sync1?.payload.action === ActionType.REACT);
  check('① sync.target_type = MESSAGE_REACTION', sync1?.payload.target_type === TargetType.MESSAGE_REACTION);
  check('① sync.target_id = 반응 행 id(메시지 id가 아니다)', typeof sync1?.payload.target_id === 'string' && sync1.payload.target_id !== 'm1');

  // ============ ② addReaction — alert 이벤트(E17)가 메시지 작성자에게만 나간다 ============
  const alert1 = captured1.find((c) => c.event === 'alert');
  check('② addReaction — alert 이벤트가 나간다(E17 — 내 메시지에 반응 추가됨)', !!alert1);
  check('② alert.type = reaction', alert1?.payload.type === 'reaction');
  check('② alert.target_user_ids = [메시지 작성자]', JSON.stringify(alert1?.payload.target_user_ids) === JSON.stringify(['author1']));
  check('② alert.routeData.route_type = SECTION_MESSAGE(E17이 명시한 라우팅 대상)',
    alert1?.payload.routeData.route_type === TargetType.SECTION_MESSAGE);
  check('② alert.routeData.route_id = 메시지 id', alert1?.payload.routeData.route_id === 'm1');
  check('② alert.device_uuid', alert1?.payload.device_uuid === 'dev-reactor');

  // ============ ③ removeReaction — 실제로 지워졌을 때만 sync(UNREACT)가 나간다 ============
  const captured2 = await captureEmits(() => MessageService.removeReaction('m1', '❤️', ctx()));
  const sync2 = captured2.find((c) => c.event === 'sync');
  check('③ removeReaction — sync 이벤트가 나간다(이전엔 아예 없었다)', !!sync2);
  check('③ sync.action = UNREACT', sync2?.payload.action === ActionType.UNREACT);
  check('③ sync.target_type = MESSAGE_REACTION', sync2?.payload.target_type === TargetType.MESSAGE_REACTION);
  check('③ sync.device_uuid', sync2?.payload.device_uuid === 'dev-reactor');
  const alert2 = captured2.find((c) => c.event === 'alert');
  check('③ removeReaction은 alert를 내지 않는다(E17은 "추가됨"만 명시)', !alert2);

  // ============ ④ removeReaction — 이미 없는 반응을 다시 지우면(멱등) 이벤트가 안 나간다 ============
  const captured3 = await captureEmits(() => MessageService.removeReaction('m1', '❤️', ctx()));
  check('④ 이미 지워진 반응을 다시 지우면 sync 이벤트가 안 나간다(실제 변화 없음)', captured3.length === 0,
    `실제=${JSON.stringify(captured3)}`);

  console.log(`\n[messageReactionEmitRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[messageReactionEmitRegression] 실행 실패:', error);
  process.exitCode = 1;
});
