/**
 * src/services/pollCreationRegression.test.js
 * =========================================
 * RLY-20260806-103 — 투표 생성 경로 자체가 없었다(087·094가 두 번 등재. `messageService.js`
 * `createMessage`가 `data.poll`을 아예 읽지 않아 클라가 poll을 보내도 조용히 무시됐다).
 * MVP 판정: `specs_index.md`의 SC-messaging 상태=🟢(V2 아님, `docs/v2/`에 없음) — 087·094와
 * 동일 근거로 재확인.
 *
 * 094가 `SyncDAO.getMessagePolls`·`getMessagePollOptions`(델타 동기화)를 이미 뚫어 놨다 —
 * 이 스위트의 ④가 **내가 만든 쓰기가 094의 읽기와 실제로 이어지는지**를 같은 mock pool
 * 위에서 직접 확인한다(094의 로직 자체는 건드리지 않는다 — 함수를 그대로 호출만 한다).
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`, require.cache로 config/db를
 * 가짜 connection으로 교체해 실제 서비스 코드(MessageService.createMessage)를 그대로 구동한다.
 *
 * 실행: node src/services/pollCreationRegression.test.js
 */

const assert = require('assert');

const dbPath = require.resolve('../../config/db');
const NOW_ISO = new Date('2026-08-07T00:00:00Z').toISOString();

function freshDb() {
  return {
    sections: { s1: { id: 's1', binder_id: 'b1', title: 'Sec', access_scope: 0, is_default: false, created_at: NOW_ISO, updated_at: NOW_ISO, deleted_at: null } },
    messages: {},
    polls: {},        // id -> row
    pollOptions: {},   // id -> row
  };
}

function makeMockDb(db) {
  async function mockQuery(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

    // SectionDAO.findById
    if (s.startsWith('SELECT id, binder_id, title, access_scope, is_default')) {
      const row = db.sections[params[0]];
      return { rows: row ? [row] : [] };
    }

    // MessageDAO.create
    if (s.startsWith('INSERT INTO section_messages')) {
      const [id, section_id, user_id, parent_id, content, mention_everyone] = params;
      const row = { id, section_id, user_id, parent_id, content, mention_everyone, is_pinned: false, created_at: NOW_ISO, updated_at: NOW_ISO };
      db.messages[id] = row;
      return { rows: [row] };
    }

    // _createPoll — message_polls INSERT
    if (s.startsWith('INSERT INTO message_polls')) {
      const [id, message_id, question, allow_multiple, is_anonymous, closes_at] = params;
      const row = { id, message_id, question, allow_multiple, is_anonymous, closes_at, closed_at: null, created_at: new Date(), updated_at: new Date() };
      db.polls[id] = row;
      return { rows: [row] };
    }

    // _createPoll — message_poll_options bulk INSERT
    if (s.startsWith('INSERT INTO message_poll_options')) {
      const rows = [];
      for (let i = 0; i < params.length; i += 4) {
        const [id, poll_id, option_text, display_order] = params.slice(i, i + 4);
        const row = { id, poll_id, option_text, display_order, created_at: new Date() };
        db.pollOptions[id] = row;
        rows.push(row);
      }
      return { rows };
    }

    // ── 094 SyncDAO — 같은 db 위에서 그대로 조회(로직은 안 건드리고 호출만) ──
    if (s.startsWith('SELECT * FROM message_polls')) {
      const [messageIds] = params;
      const rows = Object.values(db.polls).filter((p) => messageIds.includes(p.message_id));
      return { rows };
    }
    if (s.startsWith('SELECT po.* FROM message_poll_options')) {
      const [messageIds] = params;
      const pollIdsInScope = new Set(Object.values(db.polls).filter((p) => messageIds.includes(p.message_id)).map((p) => p.id));
      const rows = Object.values(db.pollOptions).filter((o) => pollIdsInScope.has(o.poll_id));
      return { rows };
    }

    throw new Error(`[mock] Unhandled query: ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
  }
  return { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
}

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond) { if (cond) pass++; else { fail++; failures.push(desc); } }
function ctx() { return { sender_id: 'u1', device_uuid: 'dev1' }; }

async function run() {
  const db = freshDb();
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: makeMockDb(db) };
  delete require.cache[require.resolve('./messageService')];
  const { MessageService } = require('./messageService');
  const { SyncDAO } = require('../daos/syncDAO');

  // ============ ① 재현 — data.poll을 읽는 코드 자체가 없었다 ============
  check('① 재현 근거 — 수정 전에는 _createPoll 메서드 자체가 없었다(이번에 신설)', typeof MessageService._createPoll === 'function');

  const validPoll = (overrides = {}) => ({
    id: 'poll-' + Math.random().toString(36).slice(2),
    question: '이번 주 회식 언제가 좋을까요?',
    allow_multiple: false,
    is_anonymous: false,
    options: [
      { id: 'opt-a-' + Math.random().toString(36).slice(2), option_text: '금요일', display_order: 0 },
      { id: 'opt-b-' + Math.random().toString(36).slice(2), option_text: '토요일', display_order: 1 },
    ],
    ...overrides,
  });

  // ============ ② MVP 검증 — SC-messaging.md §20-2 V1 ============
  const rejectCases = [
    ['질문 빈 값', validPoll({ question: '' })],
    ['질문 300자 초과', validPoll({ question: 'x'.repeat(301) })],
    ['옵션 1개(최소 2 미달)', validPoll({ options: [{ id: 'o1', option_text: 'A', display_order: 0 }] })],
    ['옵션 11개(최대 10 초과)', validPoll({ options: Array.from({ length: 11 }, (_, i) => ({ id: `o${i}`, option_text: `opt${i}`, display_order: i })) })],
    ['옵션 텍스트 빈 값', validPoll({ options: [{ id: 'o1', option_text: '', display_order: 0 }, { id: 'o2', option_text: 'B', display_order: 1 }] })],
  ];
  for (const [desc, poll] of rejectCases) {
    try {
      await MessageService.createMessage('s1', { id: 'msg-' + Math.random().toString(36).slice(2), content: 'x', poll }, ctx());
      fail++; failures.push(`② ${desc} — 400을 기대했지만 통과함`);
    } catch (err) {
      if (err.statusCode === 400) pass++; else { fail++; failures.push(`② ${desc} — 400 기대, 실제 ${err.statusCode} ${err.message}`); }
    }
  }

  // ============ ③ 정상 생성 — message_polls·message_poll_options가 실제로 저장된다 ============
  const messageId = 'msg-ok-1';
  const poll = validPoll();
  const created = await MessageService.createMessage('s1', { id: messageId, content: '투표 참여해주세요', poll }, ctx());
  check('③ 응답에 poll이 포함된다', created.poll && created.poll.id);
  check('③ 응답 poll.options 2개', created.poll.options.length === 2);
  check('③ message_polls에 실제로 저장됨', !!db.polls[created.poll.id]);
  check('③ message_poll_options 2개 실제로 저장됨', Object.values(db.pollOptions).filter((o) => o.poll_id === created.poll.id).length === 2);
  check('③ 기존 메시지 생성 동작 불변 — content도 정상 저장', db.messages[messageId].content === '투표 참여해주세요');

  // ============ ④ ⚠️ 094의 동기화와 실제로 이어진다 — 같은 mock pool로 직접 확인 ============
  const syncedPolls = await SyncDAO.getMessagePolls(makeMockDb(db), [messageId], null);
  check('④ 방금 만든 poll이 SyncDAO.getMessagePolls(094)로 실제 조회된다', syncedPolls.some((p) => p.id === created.poll.id));
  const syncedOptions = await SyncDAO.getMessagePollOptions(makeMockDb(db), [messageId]);
  check('④ 방금 만든 옵션도 SyncDAO.getMessagePollOptions(094)로 실제 조회된다', syncedOptions.length === 2 && syncedOptions.every((o) => o.poll_id === created.poll.id));

  // ============ ⑤ 회귀 불변 — poll 없는 기존 메시지 생성은 그대로 동작 ============
  const plain = await MessageService.createMessage('s1', { id: 'msg-plain-1', content: '그냥 텍스트' }, ctx());
  check('⑤ poll 없는 메시지는 poll:null로 정상 생성', plain.poll === null);

  console.log(`\n[pollCreationRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[pollCreationRegression] 실행 실패:', error);
  process.exitCode = 1;
});
