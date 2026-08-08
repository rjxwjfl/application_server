/**
 * src/services/messagePinServiceRegression.test.js
 * =========================================
 * RLY-20260806-094 — messageService.togglePin이 `MessageDAO.togglePin(client, messageId)`를
 * context.sender_id 없이 호출했다(수정 전). DAO 시그니처에 userId 자리를 추가해도 서비스
 * 호출부가 안 넘기면 여전히 NULL이 찍힌다 — 이 스위트는 DAO가 아니라 **서비스 호출부 배선**
 * (실제 라우트→컨트롤러→서비스 흐름과 동일한 인자 전달)을 가짜 DB connection으로 구동해
 * 검증한다. defaultSectionProtectionRegression.test.js(087)와 동일 관행.
 *
 * 실행: node src/services/messagePinServiceRegression.test.js
 */


const dbPath = require.resolve('../../config/db');

const NOW = new Date('2026-08-06T00:00:00Z').toISOString();

const db = {
  section_messages: {
    m1: { id: 'm1', section_id: 's1', user_id: 'author1', parent_id: null, content: 'hi', mention_everyone: false, is_pinned: false, pinned_at: null, pinned_by_user_id: null, created_at: NOW, updated_at: NOW, deleted_at: null },
  },
  sections: {
    s1: { id: 's1', binder_id: 'b1', title: 'Sec', access_scope: 0, is_default: false, created_at: NOW, updated_at: NOW, deleted_at: null },
  },
  // RLY-20260806-107 — togglePin이 이제 requireBinderMember(minRole:1)를 거친다.
  // 이 스위트의 관심사(context.sender_id 배선)와 무관해 호출자를 manager로 고정한다.
  binder_members: {
    'b1:manager1': { binder_id: 'b1', user_id: 'manager1', role: 1, deleted_at: null },
  },
};

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // MessageDAO.findById
  if (s.startsWith('SELECT id, section_id, user_id, parent_id, content') && s.includes('FROM section_messages') && s.includes('WHERE id = $1')) {
    const row = db.section_messages[params[0]];
    return { rows: row && !row.deleted_at ? [row] : [] };
  }

  // BinderDAO.getMember (requireBinderMember 내부, RLY-20260806-107)
  if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
    const row = db.binder_members[`${params[0]}:${params[1]}`];
    return { rows: row ? [row] : [] };
  }

  // MessageDAO.countPinned — RLY-20260806-103이 togglePin 앞에 추가한 한도 사전 체크.
  // 이 스위트의 관심사(context.sender_id 배선)와는 무관해 항상 한도 미만(0)으로 응답한다.
  if (s.startsWith('SELECT COUNT(*)::int AS count FROM section_messages')) {
    const [sectionId] = params;
    const count = Object.values(db.section_messages).filter((m) => m.section_id === sectionId && m.is_pinned === true && !m.deleted_at).length;
    return { rows: [{ count }] };
  }

  // MessageDAO.togglePin — 실제 SQL 그대로 시뮬레이션(갱신 전 is_pinned 값 기준 CASE)
  if (s.startsWith('UPDATE section_messages') && s.includes('SET is_pinned = NOT is_pinned')) {
    const [messageId, userId] = params;
    const row = db.section_messages[messageId];
    if (!row) return { rows: [] };
    const wasPinned = row.is_pinned;
    row.is_pinned = !wasPinned;
    row.pinned_at = wasPinned ? null : new Date();
    row.pinned_by_user_id = wasPinned ? null : userId ?? null; // 호출부가 안 넘기면 undefined → NULL 바인딩
    return { rows: [{ id: row.id, is_pinned: row.is_pinned, pinned_at: row.pinned_at, pinned_by_user_id: row.pinned_by_user_id }] };
  }

  // SectionDAO.findById
  if (s.startsWith('SELECT id, binder_id, title, access_scope, is_default')) {
    const row = db.sections[params[0]];
    return { rows: row ? [row] : [] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { MessageService } = require('./messageService');

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond) { if (cond) pass++; else { fail++; failures.push(desc); } }

async function run() {
  // ① 서비스 경유 핀 — context.sender_id가 실제로 pinned_by_user_id까지 도달한다
  const pinned = await MessageService.togglePin('m1', { sender_id: 'manager1', device_uuid: 'dev1' });
  check('① MessageService.togglePin 응답 is_pinned=true', pinned.is_pinned === true);
  check('① 서비스 호출부 배선 — context.sender_id가 pinned_by_user_id까지 도달(수정 전엔 여기가 항상 undefined였다)', pinned.pinned_by_user_id === 'manager1');
  check('① pinned_at도 채워짐', pinned.pinned_at != null);

  // ② 같은 서비스 경유로 해제 — 문서대로 NULL 복귀
  const unpinned = await MessageService.togglePin('m1', { sender_id: 'manager1', device_uuid: 'dev1' });
  check('② 해제 후 is_pinned=false', unpinned.is_pinned === false);
  check('② 해제 후 pinned_at=NULL', unpinned.pinned_at === null);
  check('② 해제 후 pinned_by_user_id=NULL', unpinned.pinned_by_user_id === null);

  console.log(`\n[messagePinServiceRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[messagePinServiceRegression] 실행 실패:', error);
  process.exitCode = 1;
});
