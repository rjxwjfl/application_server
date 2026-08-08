/**
 * src/services/castCommentBinderIdRegression.test.js
 * =========================================
 * RLY-20260806-179 — CastService.deleteComment가 binder_id를 인가 분기(타인 댓글 삭제) 안
 * 에서만 조회했다. 본인 댓글을 지우는(가장 흔한) 경로는 그 분기를 안 타 cast/calendar 조회
 * 자체가 아예 안 됐고, emit의 binder_id가 항상 undefined였다 — feedHandler는 binder_id를
 * 필수로 요구해(`!data.binder_id`면 즉시 return) 활동 피드에 전혀 안 남았고,
 * notificationService.sendSync가 만드는 FCM 토픽도 `binder_undefined`가 돼 아무도 구독 안 한
 * 토픽으로 나가 실시간 sync push가 사실상 허공에 발송됐다.
 *
 * postService.deleteComment는 이미 인가 분기와 무관하게 post를 항상 먼저 조회해 이 함정이
 * 없었다 — castService만 비대칭이었다(비교 회귀 ③).
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`. eventBus.on으로 실제 emit을
 * 스파이한다.
 *
 * 실행: node src/services/castCommentBinderIdRegression.test.js
 */


const dbPath = require.resolve('../../config/db');
const NOW = new Date('2026-08-08T00:00:00Z').toISOString();

const casts = { cast1: { id: 'cast1', calendar_id: 'cal1', deleted_at: null } };
const calendars = { cal1: { id: 'cal1', binder_id: 'b1', title: 'Cal1', description: null, color: 0, is_public: false, deleted_at: null } };
const comments = {
  c1: { id: 'c1', cast_id: 'cast1', user_id: 'author1', content: 'hi', deleted_at: null },
  c2: { id: 'c2', cast_id: 'cast1', user_id: 'author1', content: 'hi2', deleted_at: null },
};
const binderMembers = {
  'b1:manager1': { binder_id: 'b1', user_id: 'manager1', role: 1, deleted_at: null },
};

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  if (s.startsWith('SELECT * FROM cast_comments')) {
    const row = comments[params[0]];
    return { rows: row ? [row] : [] };
  }
  if (s.startsWith('SELECT * FROM casts')) {
    const row = casts[params[0]];
    return { rows: row ? [row] : [] };
  }
  if (s.startsWith('SELECT id, binder_id, title, description, color, is_public') && s.includes('FROM calendars')) {
    const row = calendars[params[0]];
    return { rows: row ? [row] : [] };
  }
  if (s.startsWith('SELECT binder_id, user_id, role') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
    const row = binderMembers[`${params[0]}:${params[1]}`];
    return { rows: row ? [row] : [] };
  }
  if (s.startsWith('UPDATE cast_comments')) {
    const row = comments[params[0]];
    if (row) row.deleted_at = NOW;
    return { rows: [] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { CastService } = require('./castService');
const eventBus = require('../events/eventBus');

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond, detail) { if (cond) pass++; else { fail++; failures.push(detail ? `${desc}: ${detail}` : desc); } }

async function captureEmits(fn) {
  const captured = [];
  const onSync = (payload) => captured.push({ event: 'sync', payload });
  eventBus.on('sync', onSync);
  try { await fn(); } finally { eventBus.off('sync', onSync); }
  return captured;
}

async function run() {
  // ============ ① 본인 댓글 삭제 — 결함이 있던 바로 그 경로에서 binder_id가 실린다 ============
  const captured1 = await captureEmits(() => CastService.deleteComment('c1', { sender_id: 'author1', device_uuid: 'dev-1' }));
  check('① 본인 댓글 삭제 — sync 이벤트가 나간다', captured1.length === 1);
  check('① 본인 댓글 삭제 — binder_id가 undefined가 아니라 실제 값이다(결함의 핵심)',
    captured1[0]?.payload.binder_id === 'b1', `실제=${JSON.stringify(captured1[0]?.payload)}`);
  check('① sender_id·device_uuid도 정상', captured1[0]?.payload.sender_id === 'author1' && captured1[0]?.payload.device_uuid === 'dev-1');

  // ============ ② 타인(manager) 댓글 삭제 — 기존에도 정상이던 경로, 회귀 없음 ============
  const captured2 = await captureEmits(() => CastService.deleteComment('c2', { sender_id: 'manager1', device_uuid: 'dev-2' }));
  check('② manager가 타인 댓글 삭제 — binder_id 정상(회귀 없음)', captured2[0]?.payload.binder_id === 'b1');

  console.log(`\n[castCommentBinderIdRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[castCommentBinderIdRegression] 실행 실패:', error);
  process.exitCode = 1;
});
