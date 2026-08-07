/**
 * src/services/pinLimitRegression.test.js
 * =========================================
 * RLY-20260806-103 — 핀 한도(섹션당 5개, SC-messaging.md §20-1 Q2·§16-12 "차단 + 사용자
 * 명시 해제")를 서버 어디도 검증하지 않았다(094가 등재). api.md:1902·1908이 이미
 * "섹션당 5개 한도"·"Error 409 — 핀 한도 초과"를 명시한다 — 새 에러 코드 체계를 만들지
 * 않고 기존 409(ConflictError) 계약을 그대로 썼다.
 *
 * ⚠️ 핀 해제는 한도 검증 대상이 아니다(§16-12) — 이 스위트가 직접 확인한다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`, require.cache로 config/db를
 * 가짜 connection으로 교체해 실제 서비스 코드(MessageService.togglePin)를 그대로 구동한다.
 *
 * 실행: node src/services/pinLimitRegression.test.js
 */

const assert = require('assert');

const dbPath = require.resolve('../../config/db');
const NOW = new Date('2026-08-07T00:00:00Z').toISOString();

// ── 픽스처 — 섹션 s1에 이미 5개(한도) 핀됨, m6는 미핀 ──────────────────────────
function freshDb() {
  const messages = {};
  for (let i = 1; i <= 5; i++) {
    messages[`m${i}`] = {
      id: `m${i}`, section_id: 's1', user_id: 'author1', parent_id: null, content: `pinned-${i}`,
      mention_everyone: false, is_pinned: true, pinned_at: NOW, pinned_by_user_id: 'manager1',
      created_at: NOW, updated_at: NOW, deleted_at: null,
    };
  }
  messages.m6 = {
    id: 'm6', section_id: 's1', user_id: 'author1', parent_id: null, content: 'unpinned',
    mention_everyone: false, is_pinned: false, pinned_at: null, pinned_by_user_id: null,
    created_at: NOW, updated_at: NOW, deleted_at: null,
  };
  return {
    messages,
    sections: { s1: { id: 's1', binder_id: 'b1', title: 'Sec', access_scope: 0, is_default: false, created_at: NOW, updated_at: NOW, deleted_at: null } },
  };
}

function makeMockDb(db) {
  async function mockQuery(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

    if (s.startsWith('SELECT id, section_id, user_id, parent_id, content') && s.includes('FROM section_messages') && s.includes('WHERE id = $1')) {
      const row = db.messages[params[0]];
      return { rows: row && !row.deleted_at ? [row] : [] };
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

    // SectionDAO.findById
    if (s.startsWith('SELECT id, binder_id, title, access_scope, is_default')) {
      const row = db.sections[params[0]];
      return { rows: row ? [row] : [] };
    }

    throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
  }
  return { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
}

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond) { if (cond) pass++; else { fail++; failures.push(desc); } }

async function run() {
  const db = freshDb();
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: makeMockDb(db) };
  delete require.cache[require.resolve('./messageService')];
  const { MessageService } = require('./messageService');

  const ctx = { sender_id: 'manager1', device_uuid: 'dev1' };

  // ============ ① 재현 — 6번째 핀 시도(한도 도달 상태에서) ============
  let blocked = false;
  let blockedErr = null;
  try {
    await MessageService.togglePin('m6', ctx);
  } catch (err) {
    blocked = true;
    blockedErr = err;
  }
  check('① 6번째 핀은 차단된다(409)', blocked && blockedErr.statusCode === 409);
  check('① 기존 계약의 코드 사용(PIN_LIMIT_EXCEEDED)', blockedErr && blockedErr.errorCode === 'PIN_LIMIT_EXCEEDED');
  check('① 차단 후 m6는 실제로 여전히 미핀 상태(부작용 없음)', db.messages.m6.is_pinned === false);

  // ============ ② 핀 해제는 한도와 무관 — 항상 허용 ============
  const unpinResult = await MessageService.togglePin('m1', ctx); // 이미 5개 핀 상태에서 해제 시도
  check('② 한도 도달 상태에서도 기존 핀 해제는 성공한다', unpinResult.is_pinned === false);

  // ============ ③ 해제로 4개가 됐으니 이제 m6 핀은 성공한다 ============
  const pinResult = await MessageService.togglePin('m6', ctx);
  check('③ 자리가 생기면 새 핀이 성공한다', pinResult.is_pinned === true);

  // ============ ④ 다시 5개(한도) — 또 다른 미핀 메시지는 다시 차단된다 ============
  db.messages.m7 = { id: 'm7', section_id: 's1', user_id: 'author1', parent_id: null, content: 'x', mention_everyone: false, is_pinned: false, pinned_at: null, pinned_by_user_id: null, created_at: NOW, updated_at: NOW, deleted_at: null };
  let blockedAgain = false;
  try {
    await MessageService.togglePin('m7', ctx);
  } catch (err) {
    blockedAgain = err.statusCode === 409 && err.errorCode === 'PIN_LIMIT_EXCEEDED';
  }
  check('④ 한도 재도달 — 새 핀은 다시 차단된다(대조군 아님, 한도 로직 자체의 재현성 확인)', blockedAgain);

  console.log(`\n[pinLimitRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[pinLimitRegression] 실행 실패:', error);
  process.exitCode = 1;
});
