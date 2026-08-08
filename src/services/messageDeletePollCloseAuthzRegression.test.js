/**
 * src/services/messageDeletePollCloseAuthzRegression.test.js
 * =========================================
 * RLY-20260806-111 — 107이 "핀만 고치고 목록으로 등재"한 나머지 둘: `deleteMessage`
 * (api.md:1895 "작성자 또는 master·manager")·`closePoll`(api.md:1992 동일)이 서버 어디도
 * 집행하지 않았다 — `messageService.js`에 role 참조가 0건이던 그 파일의 일부였다.
 *
 * ⚠️ 107의 togglePin(minRole:1, 예외 없음)과 다르다 — 이번 둘은 **작성자 예외가 있다**
 * (`postService.delete`·`castService.delete`와 동일 패턴: `role > 1 && author_id !== sender_id`).
 * 이 스위트가 그 차이(작성자는 role 무관하게 통과, 비작성자는 master·manager만)를 직접 검증한다.
 *
 * ⚠️ 차단만 단언하면 전부 막아도 통과한다 — 3종 대조군을 쌍으로 넣는다: 작성자 본인(통과) /
 * manager·master(통과) / 그 외 멤버·editor(차단).
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`, require.cache로 config/db를
 * 가짜 connection으로 교체해 실제 서비스 코드를 그대로 구동한다(107·103과 동일 관행).
 *
 * 실행: node src/services/messageDeletePollCloseAuthzRegression.test.js
 */


const dbPath = require.resolve('../../config/db');
const NOW = new Date('2026-08-07T00:00:00Z').toISOString();

function freshDb() {
  return {
    sections: { s1: { id: 's1', binder_id: 'b1', title: 'Sec', access_scope: 0, is_default: false, created_at: NOW, updated_at: NOW, deleted_at: null } },
    // role: 0=master 1=manager 2=editor 3=member
    binderMembers: {
      'b1:master1': { binder_id: 'b1', user_id: 'master1', role: 0, deleted_at: null },
      'b1:manager1': { binder_id: 'b1', user_id: 'manager1', role: 1, deleted_at: null },
      'b1:editor1': { binder_id: 'b1', user_id: 'editor1', role: 2, deleted_at: null },
      'b1:member1': { binder_id: 'b1', user_id: 'member1', role: 3, deleted_at: null }, // 메시지 작성자
      'b1:member2': { binder_id: 'b1', user_id: 'member2', role: 3, deleted_at: null }, // 비작성자
    },
    messages: {},
    polls: {},
  };
}

function addMessage(db, id, authorId = 'member1') {
  db.messages[id] = { id, section_id: 's1', user_id: authorId, parent_id: null, content: 'x', mention_everyone: false, is_pinned: false, pinned_at: null, pinned_by_user_id: null, created_at: NOW, updated_at: NOW, deleted_at: null };
  return db.messages[id];
}
function addPoll(db, id, messageId) {
  db.polls[id] = { id, message_id: messageId, question: 'Q', allow_multiple: false, is_anonymous: false, closes_at: null, closed_at: null, created_at: NOW, updated_at: NOW };
  return db.polls[id];
}

function makeMockDb(db) {
  async function mockQuery(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

    // MessageDAO.findById
    if (s.startsWith('SELECT id, section_id, user_id, parent_id, content') && s.includes('FROM section_messages') && s.includes('WHERE id = $1')) {
      const row = db.messages[params[0]];
      return { rows: row && !row.deleted_at ? [row] : [] };
    }

    // SectionDAO.findById
    if (s.startsWith('SELECT id, binder_id, title, access_scope, is_default')) {
      const row = db.sections[params[0]];
      return { rows: row ? [row] : [] };
    }

    // BinderDAO.getMember (requireBinderMember)
    if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
      const row = db.binderMembers[`${params[0]}:${params[1]}`];
      return { rows: row ? [row] : [] };
    }

    // MessageDAO.softDelete
    if (s.startsWith('UPDATE section_messages') && s.includes('SET deleted_at = now()')) {
      const [id] = params;
      const row = db.messages[id];
      if (row) row.deleted_at = new Date();
      return { rows: [] };
    }

    // closePoll
    if (s.startsWith('UPDATE message_polls SET closed_at = now()')) {
      const [pollId, messageId] = params;
      const row = db.polls[pollId];
      if (!row || row.message_id !== messageId) return { rows: [] };
      row.closed_at = new Date();
      return { rows: [{ id: row.id }] };
    }

    throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
  }
  return { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
}

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond) { if (cond) pass++; else { fail++; failures.push(desc); } }
async function expectOk(desc, fn) { try { await fn(); pass++; } catch (err) { fail++; failures.push(`${desc}: 정상 기대했지만 에러 — ${err.statusCode || ''} ${err.message}`); } }
async function expectBlocked(desc, fn) {
  try { await fn(); fail++; failures.push(`${desc}: 차단을 기대했지만 통과해버림`); }
  catch (err) { if (err.statusCode === 403) pass++; else { fail++; failures.push(`${desc}: 403 기대, 실제 ${err.statusCode} ${err.message}`); } }
}

async function run() {
  const db = freshDb();
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: makeMockDb(db) };
  delete require.cache[require.resolve('./messageService')];
  const { MessageService } = require('./messageService');

  // ============ deleteMessage ============
  // ① 재현 겸 회귀 — 그 외 멤버(작성자 아님)는 남의 메시지를 지울 수 없다
  addMessage(db, 'del-1', 'member1');
  await expectBlocked(
    'deleteMessage ① 비작성자 member2는 member1의 메시지를 지울 수 없다',
    () => MessageService.deleteMessage('del-1', { sender_id: 'member2', device_uuid: 'd' })
  );
  check('① 차단 후 실제로 안 지워짐(부작용 없음)', db.messages['del-1'].deleted_at === null);

  // editor도 작성자가 아니면 차단(master·manager만 예외 없이 통과 — editor는 아님)
  await expectBlocked(
    'deleteMessage editor1도 남의 메시지를 지울 수 없다',
    () => MessageService.deleteMessage('del-1', { sender_id: 'editor1', device_uuid: 'd' })
  );

  // ② 대조군 — 작성자 본인은 role과 무관하게 지울 수 있다
  await expectOk(
    'deleteMessage ② 대조군 — 작성자 본인(member1)은 role 무관하게 지울 수 있다',
    () => MessageService.deleteMessage('del-1', { sender_id: 'member1', device_uuid: 'd' })
  );
  check('② 실제로 지워짐', db.messages['del-1'].deleted_at !== null);

  // ③ 대조군 — manager·master는 작성자가 아니어도 지울 수 있다
  addMessage(db, 'del-2', 'member1');
  await expectOk(
    'deleteMessage ③ 대조군 — manager는 비작성자여도 지울 수 있다',
    () => MessageService.deleteMessage('del-2', { sender_id: 'manager1', device_uuid: 'd' })
  );
  addMessage(db, 'del-3', 'member1');
  await expectOk(
    'deleteMessage ③ 대조군 — master는 비작성자여도 지울 수 있다',
    () => MessageService.deleteMessage('del-3', { sender_id: 'master1', device_uuid: 'd' })
  );

  // ============ closePoll ============
  // ① 재현 겸 회귀
  addMessage(db, 'poll-msg-1', 'member2');
  addPoll(db, 'poll-1', 'poll-msg-1');
  await expectBlocked(
    'closePoll ① 비작성자 member1은 member2의 투표를 마감할 수 없다',
    () => MessageService.closePoll('poll-msg-1', 'poll-1', { sender_id: 'member1', device_uuid: 'd' })
  );
  check('① 차단 후 실제로 안 마감됨', db.polls['poll-1'].closed_at === null);
  await expectBlocked(
    'closePoll editor1도 남의 투표를 마감할 수 없다',
    () => MessageService.closePoll('poll-msg-1', 'poll-1', { sender_id: 'editor1', device_uuid: 'd' })
  );

  // ② 대조군 — 투표가 딸린 메시지의 작성자 본인은 role 무관하게 마감할 수 있다
  await expectOk(
    'closePoll ② 대조군 — 작성자 본인(member2)은 마감할 수 있다',
    () => MessageService.closePoll('poll-msg-1', 'poll-1', { sender_id: 'member2', device_uuid: 'd' })
  );
  check('② 실제로 마감됨', db.polls['poll-1'].closed_at !== null);

  // ③ 대조군 — manager는 비작성자여도 마감할 수 있다
  addMessage(db, 'poll-msg-2', 'member2');
  addPoll(db, 'poll-2', 'poll-msg-2');
  await expectOk(
    'closePoll ③ 대조군 — manager는 비작성자여도 마감할 수 있다',
    () => MessageService.closePoll('poll-msg-2', 'poll-2', { sender_id: 'manager1', device_uuid: 'd' })
  );

  console.log(`\n[messageDeletePollCloseAuthzRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[messageDeletePollCloseAuthzRegression] 실행 실패:', error);
  process.exitCode = 1;
});
