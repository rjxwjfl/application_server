/**
 * src/services/mentionIdAcceptanceRegression.test.js
 * =========================================
 * RLY-20260806-153 — User 판정(가, 2026-08-07): 멘션은 "@" 강조를 클라가 로컬에서 즉시
 * 보여준다 → system.md §10-2 판정 축의 조건①이 참이 되어 더는 파생물이 아니다(반응과
 * 같은 축). 확정 형태 `mentions: [{id, user_id}]`(embeds[]·poll.options[]와 동일 모양)를
 * 서버가 수용하고, 구 형태(`mention_user_ids: [uuid, ...]`)도 하위호환으로 계속 받는다.
 *
 * ⚠️ ③ ON CONFLICT 부활 경로 — Architect 실측대로 `MessageDAO.insertMentions`의
 * `ON CONFLICT (message_id, user_id) DO UPDATE ... RETURNING id`는 **id를 SET하지 않는다.**
 * 스키마의 unique 인덱스가 partial(`uk_message_mentions_active ... WHERE deleted_at IS NULL`)
 * 이라 소프트 삭제된 행은애초에 충돌 대상이 아니라서 "삭제됐다가 새 id로 부활"하는 흔한
 * 경우는 그냥 새 행으로 깨끗이 들어간다 — **문제는 "이미 활성 상태인" (message_id,user_id)
 * 조합에 다른 id로 다시 INSERT를 시도하는 경우뿐**(현재 호출부는 createMessage 하나뿐이라
 * 순수 재시도 외에는 이 경로를 안 타지만, 재현 자체는 가능함을 회귀로 확인한다). 이 결과는
 * **고치지 않는다** — 팀리드 지시대로 보고만 한다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`.
 *
 * 실행: node src/services/mentionIdAcceptanceRegression.test.js
 */

const assert = require('assert');

const dbPath = require.resolve('../../config/db');
const NOW = new Date('2026-08-07T00:00:00Z').toISOString();

const sections = { s1: { id: 's1', binder_id: 'b1', title: 'Sec', access_scope: 0, is_default: false, created_at: NOW, updated_at: NOW, deleted_at: null } };

// 인메모리 message_mentions — ON CONFLICT (message_id, user_id) partial unique(WHERE deleted_at
// IS NULL)의 실제 동작을 재현한다: 활성 행이 있을 때만 충돌, id는 SET되지 않는다(기존 값 유지).
const messageMentionsTable = [];
let messageSeq = 0;
const savedMessages = {};

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // SectionDAO.findById
  if (s.startsWith('SELECT id, binder_id, title, access_scope, is_default')) {
    const row = sections[params[0]];
    return { rows: row ? [row] : [] };
  }
  // MessageDAO.create
  if (s.startsWith('INSERT INTO section_messages')) {
    const [id, section_id, user_id, parent_id, content, mention_everyone] = params;
    const row = { id, section_id, user_id, parent_id, content, mention_everyone, is_pinned: false, created_at: NOW, updated_at: NOW };
    savedMessages[id] = row;
    return { rows: [row] };
  }
  // MessageDAO.insertMentions — ON CONFLICT (message_id, user_id) 시뮬레이션(partial unique,
  // 활성 행만 충돌 대상). id는 DO UPDATE가 안 건드리므로 충돌 시 **기존 행의 id를 그대로 반환**.
  if (s.startsWith('INSERT INTO message_mentions')) {
    const rows = [];
    for (let i = 0; i < params.length; i += 3) {
      const [id, message_id, user_id] = params.slice(i, i + 3);
      const existingActive = messageMentionsTable.find(
        (r) => r.message_id === message_id && r.user_id === user_id && !r.deleted_at
      );
      if (existingActive) {
        // DO UPDATE SET deleted_at = NULL, updated_at = now() — id는 그대로.
        existingActive.deleted_at = null;
        existingActive.updated_at = NOW;
        rows.push({ id: existingActive.id, message_id, user_id });
      } else {
        const row = { id, message_id, user_id, deleted_at: null, updated_at: NOW };
        messageMentionsTable.push(row);
        rows.push({ id, message_id, user_id });
      }
    }
    return { rows };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const eventBus = require('../events/eventBus');
const { MessageService } = require('./messageService');

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond, detail) { if (cond) pass++; else { fail++; failures.push(detail ? `${desc}: ${detail}` : desc); } }

const ctx = () => ({ sender_id: 'author1', device_uuid: 'dev1' });
const msg = () => `msg-${++messageSeq}`;

async function run() {
  // ============ ① 신 형태 — mentions:[{id,user_id}] — 클라 id를 그대로 존중 ============
  {
    const clientMentionId = 'client-mention-id-AAA';
    let alertPayload = null;
    eventBus.once('alert', (p) => { alertPayload = p; });

    const result = await MessageService.createMessage('s1', {
      id: msg(), content: '@member1 확인해주세요',
      mentions: [{ id: clientMentionId, user_id: 'member1' }],
    }, ctx());

    check(
      '신 형태 — 클라가 보낸 mentions[].id가 그대로 저장된다',
      result.mentions[0] && result.mentions[0].id === clientMentionId,
      `실제=${JSON.stringify(result.mentions)}`
    );
    check(
      '신 형태 — 알림(alert)이 target_user_ids를 정상적으로 채워 나간다(신 형태에서도 안 빠짐)',
      alertPayload && Array.isArray(alertPayload.target_user_ids) && alertPayload.target_user_ids.includes('member1'),
      `실제=${JSON.stringify(alertPayload)}`
    );
  }

  // ============ ② 구 형태 — mention_user_ids:[uuid] — 하위호환, 서버가 id 발급(기존 동작) ============
  {
    let alertPayload = null;
    eventBus.once('alert', (p) => { alertPayload = p; });

    const result = await MessageService.createMessage('s1', {
      id: msg(), content: '@member2 확인해주세요',
      mention_user_ids: ['member2'],
    }, ctx());

    check(
      '구 형태 — 여전히 동작한다(회귀 없음)',
      result.mentions[0] && result.mentions[0].user_id === 'member2',
      `실제=${JSON.stringify(result.mentions)}`
    );
    check(
      '구 형태 — id는 클라가 안 보냈으니 서버가 새로 발급한다(기존 동작 유지, id !== user_id)',
      result.mentions[0] && typeof result.mentions[0].id === 'string' && result.mentions[0].id !== 'member2',
      `실제=${JSON.stringify(result.mentions)}`
    );
    check(
      '구 형태 — 알림도 여전히 나간다',
      alertPayload && alertPayload.target_user_ids.includes('member2')
    );
  }

  // ============ ③ 부활 경로 — 이미 활성인 (message_id,user_id)에 다른 클라 id로 재삽입 ============
  // ⚠️ 실측만 한다 — 결함이면 고치지 않고 보고한다(팀리드 지시).
  {
    const sameMessageId = msg();
    const firstClientId = 'first-attempt-id';
    const secondClientId = 'second-attempt-different-id';

    await MessageService.createMessage('s1', {
      id: sameMessageId, content: '@member3 첫 시도',
      mentions: [{ id: firstClientId, user_id: 'member3' }],
    }, ctx());

    // 같은 messageId·같은 user_id로 "다른" 클라 id를 다시 보내는 상황을 인위적으로 재현
    // (현재 유일한 호출부는 createMessage뿐이라, DAO를 직접 다시 불러 그 경로만 독립적으로
    // 확인한다 — messageService를 통하면 같은 messageId로 두 번째 INSERT INTO section_messages가
    // 나가 이 mock이 처리하지 않는 경로라 DAO 레벨에서 직접 재현한다).
    const { MessageDAO } = require('../daos/messageDAO');
    const revived = await MessageDAO.insertMentions(mockDb, sameMessageId, [{ id: secondClientId, user_id: 'member3' }]);

    check(
      '③ 실측 — 활성 상태에서 다른 클라 id로 재삽입하면 ON CONFLICT DO UPDATE가 타서 "기존" id가 반환된다(새 id가 아님) — 이것이 Architect가 지목한 지점, 고치지 않고 보고만 한다',
      revived[0] && revived[0].id === firstClientId && revived[0].id !== secondClientId,
      `기대=${firstClientId}(기존), 실제=${JSON.stringify(revived)}`
    );
  }

  console.log(`\n[mentionIdAcceptanceRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[mentionIdAcceptanceRegression] 실행 실패:', error);
  process.exitCode = 1;
});
