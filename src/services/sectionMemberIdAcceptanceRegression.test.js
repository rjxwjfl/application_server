/**
 * src/services/sectionMemberIdAcceptanceRegression.test.js
 * =========================================
 * RLY-20260806-156 ② — User 판정("즉시 표시가 기본, 포기는 예외")에 대비해 섹션 멤버 추가를
 * 미리 준비한다. 로컬 `section_members`에도 `uq_section_members_active
 * (section_id,user_id) WHERE deleted_at IS NULL` 파샬 유니크가 이미 있어(143 확인) 멘션·반응과
 * 같은 함정이 성립할 수 있다 — 지금은 클라가 낙관적 로컬 삽입을 안 해서 터지지 않을 뿐이다.
 * `SectionService.addMembers`가 `members: [{id, user_id}]`(신 형태, 클라 id 존중)와
 * `user_ids: [uuid]`(구 형태, 서버 발급) 둘 다 받도록 확장했다.
 *
 * ⚠️ RLY-20260806-159 갱신 — SectionDAO.addMember의 "복원(restored)" 경로가 소프트 삭제된
 * 기존 행을 되살릴 때 **기존 id를 무조건 유지**하던 것을(156이 등재, 수리 안 함으로 남겨둠)
 * 이제 고쳤다: `clientId`(5번째 인자, nullable)를 명시적으로 보내면 그 id로 갈아끼우고,
 * 안 보내면(구 형태 호출) 기존 id를 그대로 유지한다(하위호환). section_members.id는
 * 참조하는 FK도 폴리모픽 target_id도 없어(sectionDAO.js addMember 주석 — 스키마 전수 확인)
 * id를 바꿔도 안전하다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`.
 *
 * 실행: node src/services/sectionMemberIdAcceptanceRegression.test.js
 */

const assert = require('assert');

const dbPath = require.resolve('../../config/db');
const NOW = new Date('2026-08-07T00:00:00Z').toISOString();

const binderMembers = {
  'b1:manager1': { binder_id: 'b1', user_id: 'manager1', role: 1, deleted_at: null },
  'b1:member1': { binder_id: 'b1', user_id: 'member1', role: 3, deleted_at: null },
  'b1:member2': { binder_id: 'b1', user_id: 'member2', role: 3, deleted_at: null },
};
const sections = {
  s1: { id: 's1', binder_id: 'b1', access_scope: 1, deleted_at: null },
};

// 인메모리 section_members — SectionDAO.addMember의 CTE(restored/inserted) 의미론을 그대로
// 재현한다: 활성 행이 있으면 아무 것도 안 함(그 위는 서비스가 이미 걸러야 정상이지만 DAO
// 자체는 ON CONFLICT DO NOTHING으로 방어), 소프트 삭제된 행이 있으면 "기존 id 유지"로 복원,
// 둘 다 없으면 넘어온 id로 신규 삽입.
const sectionMembersTable = [];

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
    return { rows: binderMembers[`${params[0]}:${params[1]}`] ? [binderMembers[`${params[0]}:${params[1]}`]] : [] };
  }
  if (s.startsWith('SELECT id, binder_id, title, access_scope, is_default') && s.includes('FROM sections')) {
    const row = sections[params[0]];
    return { rows: row ? [row] : [] };
  }
  // SectionDAO.addMember — WITH restored ... inserted ...
  if (s.startsWith('WITH restored AS')) {
    const [sectionId, userId, id, clientId] = params;
    const activeRow = sectionMembersTable.find((r) => r.section_id === sectionId && r.user_id === userId && !r.deleted_at);
    if (activeRow) {
      // ON CONFLICT ... DO NOTHING — 아무 것도 안 바뀜, 빈 결과.
      return { rows: [] };
    }
    const deletedRow = sectionMembersTable.find((r) => r.section_id === sectionId && r.user_id === userId && r.deleted_at);
    if (deletedRow) {
      // restored — 실제 SQL 텍스트가 `SET id = COALESCE($4, id)`를 담고 있을 때만 id를
      // clientId로 갈아끼운다(132/135의 교훈 — 목이 SQL과 무관하게 자체적으로 갈아끼우면
      // 실제 코드를 되돌려도 회귀가 못 잡는다). clientId가 없으면(구 형태) 기존 id 유지.
      if (s.includes('SET id = COALESCE($4, id)') && clientId) deletedRow.id = clientId;
      deletedRow.deleted_at = null;
      deletedRow.updated_at = NOW;
      return { rows: [{ user_id: userId }] };
    }
    // inserted — 신규, 넘어온 id 사용.
    sectionMembersTable.push({ id, section_id: sectionId, user_id: userId, deleted_at: null });
    return { rows: [{ user_id: userId }] };
  }
  // SectionDAO.countMembers
  if (s.startsWith('SELECT COUNT(*)::int AS count FROM section_members')) {
    const count = sectionMembersTable.filter((r) => r.section_id === params[0] && !r.deleted_at).length;
    return { rows: [{ count }] };
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

const ctx = () => ({ sender_id: 'manager1', device_uuid: 'dev1' });

async function run() {
  // ============ ① 신 형태 — members:[{id,user_id}] — 클라 id를 그대로 존중 ============
  {
    const clientMemberId = 'client-section-member-id-AAA';
    const result = await SectionService.addMembers('s1', [{ id: clientMemberId, user_id: 'member1' }], ctx());
    check('신 형태 — added_user_ids에 member1 포함', result.added_user_ids.includes('member1'));
    const row = sectionMembersTable.find((r) => r.section_id === 's1' && r.user_id === 'member1');
    check('신 형태 — 클라가 보낸 id가 그대로 저장된다(신규 삽입 경로)', row && row.id === clientMemberId, `실제=${JSON.stringify(row)}`);
  }

  // ============ ② 구 형태 — user_ids:[uuid] — 하위호환, 서버가 id 발급(기존 동작) ============
  {
    const result = await SectionService.addMembers('s1', ['member2'], ctx());
    check('구 형태 — 여전히 동작한다(회귀 없음)', result.added_user_ids.includes('member2'));
    const row = sectionMembersTable.find((r) => r.section_id === 's1' && r.user_id === 'member2');
    check('구 형태 — id는 서버가 새로 발급한다(user_id와 다른 값)', row && typeof row.id === 'string' && row.id !== 'member2');
  }

  // ============ ③ RLY-20260806-159 — 복원 경로에서 클라 id가 이긴다(신 형태) ============
  {
    // member1을 제거(소프트 삭제)한 뒤 신 형태(clientId 있음)로 재추가.
    const before = sectionMembersTable.find((r) => r.section_id === 's1' && r.user_id === 'member1');
    const originalId = before.id;
    before.deleted_at = NOW; // 제거 시뮬레이션(SectionService.removeMember 대신 직접 조작 — 이 회귀의 관심사는 addMember 하나뿐)

    const newClientId = 'client-section-member-id-BBB-different';
    const result = await SectionService.addMembers('s1', [{ id: newClientId, user_id: 'member1' }], ctx());

    const after = sectionMembersTable.find((r) => r.section_id === 's1' && r.user_id === 'member1');
    check('③-1 복원 — 클라가 명시적으로 보낸 id로 갈아끼워진다(더 이상 기존 id를 유지하지 않는다)',
      after && after.id === newClientId && after.id !== originalId,
      `기대=${newClientId}, 실제=${JSON.stringify(after)}`);
    check('③-2 복원 — 응답의 added_user_ids에도 정상 포함된다(성공으로 처리)', result.added_user_ids.includes('member1'));
    check('③-3 복원 후에도 section_members 행이 정확히 1개뿐이다(id 교체가 행을 복제/유실시키지 않는다, 참조 불변 확인)',
      sectionMembersTable.filter((r) => r.section_id === 's1' && r.user_id === 'member1').length === 1);
  }

  // ============ ④ RLY-20260806-159 — 구 형태(clientId 없음)는 여전히 기존 id를 유지한다(하위호환) ============
  {
    // member2를 제거(소프트 삭제)한 뒤 구 형태(user_ids 평문)로 재추가.
    const before = sectionMembersTable.find((r) => r.section_id === 's1' && r.user_id === 'member2');
    const originalId = before.id;
    before.deleted_at = NOW;

    await SectionService.addMembers('s1', ['member2'], ctx());

    const after = sectionMembersTable.find((r) => r.section_id === 's1' && r.user_id === 'member2');
    check('④ 복원 — 구 형태(clientId 미전송)는 기존 id를 그대로 유지한다(하위호환 — clientId=null이면 COALESCE가 기존 id를 그대로 둔다)',
      after && after.id === originalId,
      `기대=${originalId}(기존 유지), 실제=${JSON.stringify(after)}`);
  }

  // ============ 인가·유효성 회귀 없음(대조군) ============
  await expectStatus(
    '대조군 — 활성 바인더 멤버가 아니면 여전히 400',
    () => SectionService.addMembers('s1', [{ id: 'x', user_id: 'not-a-binder-member' }], ctx()),
    400
  );

  console.log(`\n[sectionMemberIdAcceptanceRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[sectionMemberIdAcceptanceRegression] 실행 실패:', error);
  process.exitCode = 1;
});
