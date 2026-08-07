/**
 * src/services/pinRoleGateRegression.test.js
 * =========================================
 * RLY-20260806-107 — api.md:1902 "핀 토글. master·manager 전용."을 서버 어디도 집행하지
 * 않았다(103 작업 중 부수 발견). 컨트롤러는 `SectionService.assertMessageAccess`로 콘텐츠
 * 접근만 확인했고, `messageService.js` 전체에 role 관련 로직이 0건이었다(grep 확인) —
 * member·editor 도 API로 직접 핀을 걸고 뗄 수 있었다. RLY-20260806-097(UI)의 화면 차단이
 * 유일한 방어였다(우회 가능).
 *
 * ⚠️ 차단만 단언하면 전부 막아도 통과한다 — member·editor(차단)와 manager·master(대조군,
 * 통과)를 쌍으로 넣는다. 해제(unpin)도 같은 게이트가 걸리는지 별도로 확인한다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`, require.cache로 config/db를
 * 가짜 connection으로 교체해 실제 서비스 코드(MessageService.togglePin)를 그대로 구동한다.
 *
 * 실행: node src/services/pinRoleGateRegression.test.js
 */

const assert = require('assert');

const dbPath = require.resolve('../../config/db');
const NOW = new Date('2026-08-07T00:00:00Z').toISOString();

function freshDb() {
  return {
    sections: { s1: { id: 's1', binder_id: 'b1', title: 'Sec', access_scope: 0, is_default: false, created_at: NOW, updated_at: NOW, deleted_at: null } },
    binderMembers: {
      // role: 0=master 1=manager 2=editor 3=member
      'b1:master1': { binder_id: 'b1', user_id: 'master1', role: 0, deleted_at: null },
      'b1:manager1': { binder_id: 'b1', user_id: 'manager1', role: 1, deleted_at: null },
      'b1:editor1': { binder_id: 'b1', user_id: 'editor1', role: 2, deleted_at: null },
      'b1:member1': { binder_id: 'b1', user_id: 'member1', role: 3, deleted_at: null },
    },
    messages: {
      m1: { id: 'm1', section_id: 's1', user_id: 'member1', parent_id: null, content: 'hi', mention_everyone: false, is_pinned: false, pinned_at: null, pinned_by_user_id: null, created_at: NOW, updated_at: NOW, deleted_at: null },
      m2: { id: 'm2', section_id: 's1', user_id: 'member1', parent_id: null, content: 'already pinned', mention_everyone: false, is_pinned: true, pinned_at: NOW, pinned_by_user_id: 'manager1', created_at: NOW, updated_at: NOW, deleted_at: null },
    },
  };
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

    // BinderDAO.getMember (requireBinderMember 내부)
    if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
      const row = db.binderMembers[`${params[0]}:${params[1]}`];
      return { rows: row ? [row] : [] };
    }

    // MessageDAO.countPinned
    if (s.startsWith('SELECT COUNT(*)::int AS count FROM section_messages')) {
      const [sectionId] = params;
      const count = Object.values(db.messages).filter((m) => m.section_id === sectionId && m.is_pinned === true && !m.deleted_at).length;
      return { rows: [{ count }] };
    }

    // MessageDAO.togglePin
    if (s.startsWith('UPDATE section_messages') && s.includes('SET is_pinned = NOT is_pinned')) {
      const [messageId, userId] = params;
      const row = db.messages[messageId];
      if (!row) return { rows: [] };
      const wasPinned = row.is_pinned;
      row.is_pinned = !wasPinned;
      row.pinned_at = wasPinned ? null : new Date();
      row.pinned_by_user_id = wasPinned ? null : userId;
      return { rows: [{ id: row.id, is_pinned: row.is_pinned, pinned_at: row.pinned_at, pinned_by_user_id: row.pinned_by_user_id }] };
    }

    throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
  }
  return { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
}

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond) { if (cond) pass++; else { fail++; failures.push(desc); } }

async function expectBlocked(desc, fn) {
  try {
    await fn();
    fail++; failures.push(`${desc}: 차단을 기대했지만 통과해버림`);
  } catch (err) {
    if (err.statusCode === 403) pass++; else { fail++; failures.push(`${desc}: 403 기대, 실제 ${err.statusCode} ${err.message}`); }
  }
}
async function expectOk(desc, fn) {
  try { await fn(); pass++; } catch (err) { fail++; failures.push(`${desc}: 정상 통과 기대했지만 에러 — ${err.statusCode || ''} ${err.message}`); }
}

async function run() {
  const db = freshDb();
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: makeMockDb(db) };
  delete require.cache[require.resolve('./messageService')];
  const { MessageService } = require('./messageService');

  // ============ ① 재현 근거 겸 회귀 — member는 핀을 걸 수 없다 ============
  await expectBlocked(
    '① member(role=3)는 핀을 걸 수 없다',
    () => MessageService.togglePin('m1', { sender_id: 'member1', device_uuid: 'dev1' })
  );
  check('① 차단 후 m1은 실제로 여전히 미핀(부작용 없음)', db.messages.m1.is_pinned === false);

  // editor(role=2)도 "master·manager 전용"이므로 차단돼야 한다(§16-7 등급 정합 — manager+만 통과)
  await expectBlocked(
    'editor(role=2)도 핀을 걸 수 없다',
    () => MessageService.togglePin('m1', { sender_id: 'editor1', device_uuid: 'dev1' })
  );

  // ============ ② 대조군 — manager·master는 여전히 된다 ============
  await expectOk(
    '② 대조군 — manager(role=1)는 핀을 걸 수 있다',
    () => MessageService.togglePin('m1', { sender_id: 'manager1', device_uuid: 'dev1' })
  );
  check('② manager가 건 핀이 실제로 반영됨', db.messages.m1.is_pinned === true);

  // 원상복구 후 master로도 확인
  db.messages.m1.is_pinned = false; db.messages.m1.pinned_at = null; db.messages.m1.pinned_by_user_id = null;
  await expectOk(
    '② 대조군 — master(role=0)도 핀을 걸 수 있다',
    () => MessageService.togglePin('m1', { sender_id: 'master1', device_uuid: 'dev1' })
  );

  // ============ ③ 해제(unpin)도 같은 게이트가 걸린다 ============
  await expectBlocked(
    '③ member는 이미 핀된 메시지를 해제할 수도 없다(m2)',
    () => MessageService.togglePin('m2', { sender_id: 'member1', device_uuid: 'dev1' })
  );
  check('③ 차단 후 m2는 여전히 핀 상태(부작용 없음)', db.messages.m2.is_pinned === true);
  await expectOk(
    '③ 대조군 — manager는 해제할 수 있다',
    () => MessageService.togglePin('m2', { sender_id: 'manager1', device_uuid: 'dev1' })
  );
  check('③ manager 해제가 실제로 반영됨', db.messages.m2.is_pinned === false);

  console.log(`\n[pinRoleGateRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[pinRoleGateRegression] 실행 실패:', error);
  process.exitCode = 1;
});
