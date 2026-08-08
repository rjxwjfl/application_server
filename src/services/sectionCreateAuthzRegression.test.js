/**
 * src/services/sectionCreateAuthzRegression.test.js
 * =========================================
 * RLY-20260806-187 — User 판정: 섹션 생성 권한을 완화한다. 공개 섹션(access_scope=0)은
 * editor(role<=2) 이상이면 만들 수 있고, 비공개(access_scope=1)는 manager(role<=1) 이상을
 * 그대로 유지한다 — D4 확정 정책(비공개는 완화 대상이 아니다). scope에 따라 인가 문턱이
 * 갈리므로 scope를 먼저 확정한 뒤(기존 검증 그대로 — 미전송 시 기본값 0=공개, 0·1이
 * 아니면 400) 역할을 검사한다.
 *
 * 수정 전(수리 대상 발견 당시)엔 access_scope와 무관하게 항상 manager(role<=1) 이상을
 * 요구해 공개 섹션도 editor는 403을 받았다 — 회귀 ②가 그 결함을 재현·고정한다(수정 전
 * 되돌려 실제로 403이었음을 확인한 절차는 구현 보고서 참조).
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`,
 * defaultSectionProtectionRegression.test.js와 동일한 가짜 DB 패턴.
 *
 * 실행: node src/services/sectionCreateAuthzRegression.test.js
 */


const dbPath = require.resolve('../../config/db');
const NOW = new Date('2026-08-08T00:00:00Z').toISOString();

const binderMembers = {
  'b1:master1':  { binder_id: 'b1', user_id: 'master1',  role: 0, deleted_at: null },
  'b1:manager1': { binder_id: 'b1', user_id: 'manager1', role: 1, deleted_at: null },
  'b1:editor1':  { binder_id: 'b1', user_id: 'editor1',  role: 2, deleted_at: null },
  'b1:member1':  { binder_id: 'b1', user_id: 'member1',  role: 3, deleted_at: null },
};
const sections = {};

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // BinderDAO.getMember
  if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
    const row = binderMembers[`${params[0]}:${params[1]}`];
    return { rows: row ? [row] : [] };
  }
  // SectionDAO.create
  if (s.startsWith('INSERT INTO sections')) {
    const [id, binder_id, title, access_scope, is_default] = params;
    const row = { id, binder_id, title, access_scope, is_default: !!is_default, created_at: NOW, updated_at: NOW };
    sections[id] = row;
    return { rows: [row] };
  }
  // SectionDAO.addMember (access_scope=1 생성 시 생성자 자동 추가)
  if (s.startsWith('WITH restored AS')) {
    return { rows: [{ user_id: params[1] }] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { SectionService } = require('./sectionService');

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond, detail) { if (cond) pass++; else { fail++; failures.push(detail ? `${desc}: ${detail}` : desc); } }

async function expectStatus(desc, fn, expectedStatus) {
  try { await fn(); fail++; failures.push(`${desc}: 예상 ${expectedStatus} — 통과해버림`); }
  catch (err) {
    if (err.statusCode === expectedStatus) pass++;
    else { fail++; failures.push(`${desc}: 예상 ${expectedStatus}, 실제 ${err.statusCode || err.message}`); }
  }
}

const ctx = (userId) => ({ sender_id: userId, device_uuid: 'dev-1' });
let seq = 0;
const newId = () => `sec-${++seq}`;

async function run() {
  // ============ ① 공개 + editor = 성공(핵심 — 이번에 완화된 지점) ============
  const s1 = newId();
  const r1 = await SectionService.createSection({ id: s1, binder_id: 'b1', title: 'T1', access_scope: 0 }, ctx('editor1'));
  check('① 공개 + editor — 성공', r1 && r1.id === s1);

  // ============ ② 비공개 + editor = 403(핵심 — D4 정책이 그대로 살아있어야 한다) ============
  await expectStatus(
    '② 비공개 + editor — 403(완화 대상 아님, D4 유지)',
    () => SectionService.createSection({ id: newId(), binder_id: 'b1', title: 'T2', access_scope: 1 }, ctx('editor1')),
    403
  );

  // ============ ③ 비공개 + manager = 성공(기존 동작 유지, 회귀 없음) ============
  const s3 = newId();
  const r3 = await SectionService.createSection({ id: s3, binder_id: 'b1', title: 'T3', access_scope: 1 }, ctx('manager1'));
  check('③ 비공개 + manager — 성공(회귀 없음)', r3 && r3.id === s3);

  // ============ ④ 공개 + member = 403(editor 미만은 여전히 막힌다) ============
  await expectStatus(
    '④ 공개 + member — 403(editor 미만은 여전히 막힌다)',
    () => SectionService.createSection({ id: newId(), binder_id: 'b1', title: 'T4', access_scope: 0 }, ctx('member1')),
    403
  );

  // ============ ⑤ access_scope 미전송 — 기본값 0(공개)으로 처리되어 editor가 통과한다 ============
  const s5 = newId();
  const r5 = await SectionService.createSection({ id: s5, binder_id: 'b1', title: 'T5' }, ctx('editor1'));
  check('⑤ access_scope 미전송 — 기본값 0(공개)으로 editor가 통과한다', r5 && r5.access_scope === 0,
    `실제=${JSON.stringify(r5)}`);

  // ============ ⑥ access_scope에 이상한 값 — 역할 검사까지 가지 않고 400(느슨한 쪽으로 안 열린다) ============
  await expectStatus(
    '⑥ access_scope=2(정의되지 않은 값) — editor도 400(역할 검사보다 먼저 걸린다, 느슨한 쪽으로 실패하지 않음)',
    () => SectionService.createSection({ id: newId(), binder_id: 'b1', title: 'T6', access_scope: 2 }, ctx('editor1')),
    400
  );
  await expectStatus(
    '⑥ access_scope="0"(문자열) — member도 400(0·1이 아니면 무조건 400, 타입 관용으로 통과 안 됨)',
    () => SectionService.createSection({ id: newId(), binder_id: 'b1', title: 'T7', access_scope: '0' }, ctx('member1')),
    400
  );

  // ============ ⑦ 대조군 — master는 공개·비공개 둘 다 여전히 통과(회귀 없음) ============
  const s7a = newId();
  check('⑦ master + 공개 — 성공', (await SectionService.createSection({ id: s7a, binder_id: 'b1', title: 'T8', access_scope: 0 }, ctx('master1'))).id === s7a);
  const s7b = newId();
  check('⑦ master + 비공개 — 성공', (await SectionService.createSection({ id: s7b, binder_id: 'b1', title: 'T9', access_scope: 1 }, ctx('master1'))).id === s7b);

  console.log(`\n[sectionCreateAuthzRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[sectionCreateAuthzRegression] 실행 실패:', error);
  process.exitCode = 1;
});
