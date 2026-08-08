/**
 * src/services/reactionMentionDuplicateActiveRegression.test.js
 * =========================================
 * RLY-20260806-163 — messageDAO.addReaction·insertMentions의 `ON CONFLICT` 절에 파샬
 * 유니크 인덱스(`uk_message_reactions_active`·`uk_message_mentions_active`, 둘 다
 * `WHERE deleted_at IS NULL`)와 매칭되는 `WHERE`절이 빠져 있었다. Postgres는 파샬 유니크
 * 인덱스를 ON CONFLICT 추론 대상으로 잡으려면 동일한 predicate의 WHERE절이 반드시 있어야
 * 한다 — 없으면 그 자체가 "there is no unique or exclusion constraint matching the
 * ON CONFLICT specification"으로 던진다(실측: Postgres 15 컨테이너, docker, 검증 후
 * 즉시 제거). 이번에 GroupDAO.addMember(159) 수정 과정에서 실제 Postgres로 실증하다가
 * 발견했다 — 정적 분석으로는 못 봤을 결함이다.
 *
 * ⚠️ 반응과 멘션은 의도가 다르다:
 *  - 반응(addReaction) — 제거(removeReaction) 후 재추가가 실제로 일어나는 토글형 조작이라
 *    "중복=성공, 기존 행 반환"(DO UPDATE)이 맞다. WHERE절만 추가했다.
 *  - 멘션(insertMentions) — createMessage 트랜잭션 안에서 메시지 하나당 정확히 한 번,
 *    한 배치로만 호출된다(다른 호출부 없음, updateMessage도 멘션을 안 건드림 — 직접
 *    확인) — 반응처럼 "제거 후 재추가"가 일어날 통로가 없어 되살릴 대상이 없다. 클라가
 *    같은 mentions 배열에 같은 user_id를 중복으로 보낸 경우에 대한 방어일 뿐이라
 *    "성공이되 아무 것도 갱신하지 않는다"(DO NOTHING)로 잡았다. 실무 이유도 있다 — DO
 *    UPDATE는 같은 INSERT 문 안에서 동일 키가 3번 이상 반복되면 "ON CONFLICT DO UPDATE
 *    command cannot affect row a second time"로 별도로 던진다(실측 확인) — mentions는
 *    한 배열을 한 번에 다중 VALUES로 넣는 벌크 삽입이라 이 실패 모드에 그대로 노출된다.
 *    DO NOTHING은 같은 문 안의 중복이 몇 개든 안전하다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`. 목의 ON CONFLICT 분기는
 * 실제 SQL 텍스트에 그 WHERE절이 있는지로 판단한다(132/135 교훈 — 목이 SQL과 무관하게
 * 자체적으로 갈아끼우면 실제 코드를 되돌려도 회귀가 못 잡는다).
 *
 * 실행: node src/services/reactionMentionDuplicateActiveRegression.test.js
 */

const assert = require('assert');

const dbPath = require.resolve('../../config/db');
const NOW = new Date('2026-08-07T00:00:00Z').toISOString();

const sections = {
  s1: { id: 's1', binder_id: 'b1', title: 'sec', access_scope: 0, is_default: false, deleted_at: null },
};
// RLY-20260806-179 갱신 — addReaction·removeReaction이 이제 binder_id를 위해 메시지를 먼저
// 조회한다. 이 파일의 ①②(반응 회귀)는 createMessage를 거치지 않고 messageId 'm1'을 직접
// 참조하므로 fixture를 미리 채워 둔다.
const messages = {
  m1: { id: 'm1', section_id: 's1', user_id: 'u1', parent_id: null, content: 'hi', mention_everyone: false, is_pinned: false, deleted_at: null },
};

// 인메모리 message_reactions / message_mentions.
const reactionsTable = [];
const mentionsTable = [];

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // SectionDAO.findById (createMessage·addReaction·removeReaction 전부 조회)
  if (s.startsWith('SELECT id, binder_id, title, access_scope, is_default') && s.includes('FROM sections')) {
    const row = sections[params[0]];
    return { rows: row ? [row] : [] };
  }
  // MessageDAO.findById (RLY-20260806-179 — addReaction·removeReaction이 binder_id를 위해 조회)
  if (s.startsWith('SELECT id, section_id, user_id, parent_id, content') && s.includes('FROM section_messages')) {
    const row = messages[params[0]];
    return { rows: row ? [row] : [] };
  }

  // MessageDAO.create (section_messages)
  if (s.startsWith('INSERT INTO section_messages')) {
    const [id, section_id, user_id, parent_id, content] = params;
    return { rows: [{ id, section_id, user_id, parent_id, content, mention_everyone: false, is_pinned: false, created_at: NOW, updated_at: NOW }] };
  }

  // MessageDAO.addReaction
  if (s.startsWith('INSERT INTO message_reactions')) {
    const [id, message_id, user_id, emoji] = params;
    const hasFix = s.includes('ON CONFLICT (message_id, user_id, emoji) WHERE deleted_at IS NULL DO UPDATE');
    const activeRow = reactionsTable.find((r) => r.message_id === message_id && r.user_id === user_id && r.emoji === emoji && !r.deleted_at);
    if (activeRow) {
      if (!hasFix) {
        const err = new Error('duplicate key value violates unique constraint "uk_message_reactions_active"');
        err.code = '23505';
        throw err;
      }
      activeRow.updated_at = NOW;
      return { rows: [{ ...activeRow }] };
    }
    const row = { id, message_id, user_id, emoji, created_at: NOW, updated_at: NOW, deleted_at: null };
    reactionsTable.push(row);
    return { rows: [{ ...row }] };
  }

  // MessageDAO.insertMentions
  if (s.startsWith('INSERT INTO message_mentions')) {
    const hasFix = s.includes('ON CONFLICT (message_id, user_id) WHERE deleted_at IS NULL DO NOTHING');
    // 파라미터는 (id, message_id, user_id)가 3개씩 순서대로 이어진다(다중 VALUES 벌크 삽입).
    const rows = [];
    for (let i = 0; i < params.length; i += 3) {
      const [id, message_id, user_id] = params.slice(i, i + 3);
      const activeRow = mentionsTable.find((r) => r.message_id === message_id && r.user_id === user_id && !r.deleted_at)
        || rows.find((r) => r.message_id === message_id && r.user_id === user_id);
      if (activeRow) {
        if (!hasFix) {
          const err = new Error('duplicate key value violates unique constraint "uk_message_mentions_active"');
          err.code = '23505';
          throw err;
        }
        // DO NOTHING — 아무 것도 안 바뀌고 RETURNING에도 안 실린다.
        continue;
      }
      const row = { id, message_id, user_id, deleted_at: null };
      mentionsTable.push(row);
      rows.push(row);
    }
    return { rows: rows.map(({ id, message_id, user_id }) => ({ id, message_id, user_id })) };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { MessageService } = require('./messageService');

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond, detail) { if (cond) pass++; else { fail++; failures.push(detail ? `${desc}: ${detail}` : desc); } }

const ctx = () => ({ sender_id: 'u1', device_uuid: 'dev1' });

async function run() {
  // ============ ① 반응 — 최초 추가는 정상(회귀 없음) ============
  const first = await MessageService.addReaction('m1', '❤️', ctx());
  check('① 최초 반응 추가 — 정상', first && first.emoji === '❤️');
  const firstId = first.id;

  // ============ ② 반응 — 중복(이미 활성) 재추가는 500 대신 성공 + 기존 행 반환 ============
  let thrown = null;
  let second = null;
  try {
    second = await MessageService.addReaction('m1', '❤️', ctx());
  } catch (err) {
    thrown = err;
  }
  check('② 중복 활성 반응 재추가 — 예외가 던져지지 않는다(23505가 500이 되던 결함 수정)',
    thrown === null, thrown ? `실제로 던져짐: ${thrown.message} (code=${thrown.code})` : undefined);
  check('② 중복 재추가 — 성공(기존 행)', second && second.emoji === '❤️');
  check('② 중복 재추가 — 기존 행의 id를 그대로 반환한다(DO UPDATE가 id를 SET하지 않으므로)',
    second && second.id === firstId, `기대=${firstId}, 실제=${second && second.id}`);
  check('② message_reactions에 중복 행이 생기지 않는다(정확히 1개)',
    reactionsTable.filter((r) => r.message_id === 'm1' && r.user_id === 'u1' && r.emoji === '❤️').length === 1);

  // ============ ③ 멘션 — 배열에 같은 user_id가 2번 들어와도 500 대신 성공(중복 무시) ============
  const result = await MessageService.createMessage('s1', {
    content: '@bob @bob 안녕',
    mentions: [{ id: 'mention-id-1', user_id: 'bob' }, { id: 'mention-id-2', user_id: 'bob' }],
  }, ctx());
  check('③ 멘션 배열 중복(같은 user_id 2번) — 예외 없이 메시지 생성 자체는 성공한다', !!result.id);
  check('③ 멘션 결과는 중복 없이 정확히 1건만 반영된다(DO NOTHING이 두 번째를 조용히 무시)',
    result.mentions.length === 1, `실제=${JSON.stringify(result.mentions)}`);
  check('③ 반영된 멘션의 user_id가 기대대로 bob이다', result.mentions[0] && result.mentions[0].user_id === 'bob');

  // ============ ④ 대조군 — 서로 다른 user_id 멘션은 둘 다 정상 반영(회귀 없음) ============
  const result2 = await MessageService.createMessage('s1', {
    content: '@bob @carol',
    mentions: [{ id: 'mention-id-3', user_id: 'bob2' }, { id: 'mention-id-4', user_id: 'carol2' }],
  }, ctx());
  check('④ 서로 다른 user_id 멘션 2건 — 둘 다 정상 반영(회귀 없음)', result2.mentions.length === 2);

  console.log(`\n[reactionMentionDuplicateActiveRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[reactionMentionDuplicateActiveRegression] 실행 실패:', error);
  process.exitCode = 1;
});
