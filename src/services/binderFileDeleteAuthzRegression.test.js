/**
 * src/services/binderFileDeleteAuthzRegression.test.js
 * =========================================
 * RLY-20260806-121 — `binderService.deleteAttachment`(`DELETE /binders/:binderId/attachments/
 * :attachmentId`, 파일함 개별 삭제)가 활성 바인더 멤버십만 확인하고 **소유권·role을 전혀
 * 검사하지 않아** 아무 멤버나 남의 업로드 파일을 지울 수 있었다. 이 함수 자신의 주석
 * (548-550행, 이번 수정 기준)이 "master·manager가 타인 업로드를 지우는 경로"라고 이미
 * 서술해 뒀는데 실제 인가 코드가 없었다 — `SC-binder-files.md:19·46·276·382-383`이 정확히
 * "본인 업로드: 본인. 전체: master·manager."로 못 박는다.
 *
 * ⚠️ mediaService.deleteAttachment(별개 경로, `DELETE /attachments/:id`, 업로더 본인 전용)와
 * 대칭이 안 맞았다 — 이 함수만 무방비였다. mediaService.js는 이번 Task 범위 밖(다른 Writer)
 * 이라 건드리지 않았다.
 *
 * ⚠️ 차단만 단언하면 전부 막아도 통과한다 — 본인(role 무관 통과)·manager·master(대조군)·
 * editor·비작성자 member(차단) 전부 넣는다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`, require.cache로 config/db를
 * 가짜 connection으로 교체해 실제 서비스 코드를 그대로 구동한다.
 *
 * 실행: node src/services/binderFileDeleteAuthzRegression.test.js
 */


const dbPath = require.resolve('../../config/db');
const NOW = new Date('2026-08-07T00:00:00Z').toISOString();

function freshDb() {
  return {
    // role: 0=master 1=manager 2=editor 3=member
    binderMembers: {
      'b1:master1': { binder_id: 'b1', user_id: 'master1', role: 0, deleted_at: null },
      'b1:manager1': { binder_id: 'b1', user_id: 'manager1', role: 1, deleted_at: null },
      'b1:editor1': { binder_id: 'b1', user_id: 'editor1', role: 2, deleted_at: null },
      'b1:uploader1': { binder_id: 'b1', user_id: 'uploader1', role: 3, deleted_at: null },
      'b1:other1': { binder_id: 'b1', user_id: 'other1', role: 3, deleted_at: null },
    },
    attachments: {},
  };
}

// file_size:0 — AttachmentDAO.applyStorageDelta가 size 0이면 즉시 0으로 반환해(early return)
// 이 스위트의 관심사(인가)와 무관한 회계 쿼리를 mock에 안 태워도 된다.
function addAttachment(db, id, uploaderId) {
  db.attachments[id] = {
    id, binder_id: 'b1', context_type: 'EVENT', context_id: 'e1', uploader_id: uploaderId,
    storage_key: `key-${id}`, filename: 'x.png', file_size: 0, content_type: 'image/png',
    status: 'ready', display_order: 0, created_at: NOW, updated_at: NOW, deleted_at: null,
  };
  return db.attachments[id];
}

function makeMockDb(db) {
  async function mockQuery(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

    // BinderDAO.getMember
    if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
      const row = db.binderMembers[`${params[0]}:${params[1]}`];
      return { rows: row ? [row] : [] };
    }

    // AttachmentDAO.findById
    if (s.startsWith('SELECT * FROM attachments') && s.includes("context_type NOT IN")) {
      const row = db.attachments[params[0]];
      return { rows: row && !row.deleted_at ? [row] : [] };
    }

    // AttachmentDAO.softDelete
    if (s.startsWith('UPDATE attachments SET deleted_at')) {
      const row = db.attachments[params[0]];
      if (!row) return { rows: [] };
      row.deleted_at = new Date();
      return { rows: [{ id: row.id, binder_id: row.binder_id, storage_key: row.storage_key, file_size: row.file_size }] };
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
  delete require.cache[require.resolve('./binderService')];
  const { BinderService } = require('./binderService');

  // ============ ① 재현 겸 회귀 — 비업로더 일반 멤버는 남의 파일을 지울 수 없다 ============
  addAttachment(db, 'att-1', 'uploader1');
  await expectBlocked(
    '① 비업로더 member(other1)는 uploader1의 파일을 지울 수 없다(수정 전엔 통과했다)',
    () => BinderService.deleteAttachment('b1', 'att-1', 'other1')
  );
  check('① 차단 후 실제로 안 지워짐(부작용 없음)', db.attachments['att-1'].deleted_at === null);

  await expectBlocked(
    '① editor(role=2)도 남의 파일을 지울 수 없다',
    () => BinderService.deleteAttachment('b1', 'att-1', 'editor1')
  );

  // ============ ② 대조군 — 업로더 본인은 role 무관하게 지울 수 있다 ============
  await expectOk(
    '② 대조군 — 업로더 본인(uploader1, role=member)은 지울 수 있다',
    () => BinderService.deleteAttachment('b1', 'att-1', 'uploader1')
  );
  check('② 실제로 지워짐', db.attachments['att-1'].deleted_at !== null);

  // ============ ③ 대조군 — manager·master는 비업로더여도 지울 수 있다 ============
  addAttachment(db, 'att-2', 'uploader1');
  await expectOk(
    '③ 대조군 — manager는 비업로더여도 지울 수 있다',
    () => BinderService.deleteAttachment('b1', 'att-2', 'manager1')
  );

  addAttachment(db, 'att-3', 'uploader1');
  await expectOk(
    '③ 대조군 — master도 비업로더여도 지울 수 있다',
    () => BinderService.deleteAttachment('b1', 'att-3', 'master1')
  );

  console.log(`\n[binderFileDeleteAuthzRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[binderFileDeleteAuthzRegression] 실행 실패:', error);
  process.exitCode = 1;
});
