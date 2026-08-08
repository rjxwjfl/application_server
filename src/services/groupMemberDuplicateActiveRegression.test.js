/**
 * src/services/groupMemberDuplicateActiveRegression.test.js
 * =========================================
 * RLY-20260806-159 ② — GroupDAO.addMember는 group_members에 ON CONFLICT 절 없이
 * 순수 INSERT만 했다. 이미 활성 멤버인 user_id로 다시 호출하면
 * uq_group_members_active(group_id,user_id) WHERE deleted_at IS NULL 파샬 유니크에 걸려
 * raw Postgres 23505가 그대로 올라간다 — statusCode가 없는 에러라
 * errorHandler.js(`err.statusCode || err.status || 500`)에서 무조건 500으로 떨어진다.
 * transport.md §7-1상 5xx는 재시도 대상이라, 오프라인 큐가 "다시 시도해도 절대 성공할 수
 * 없는" 요청을 영원히 재시도하며 막힌다 — 표시 문제가 아니라 큐 자체가 고착되는 결함이다.
 *
 * 기존 관행 확인: SectionDAO.addMember(ON CONFLICT ... WHERE deleted_at IS NULL DO NOTHING)와
 * messageDAO.addReaction(ON CONFLICT ... DO UPDATE, "중복=성공, 기존 행 반환" 의도)을 검토했다.
 * ⚠️ 실측(Postgres 15 컨테이너)해보니 addReaction 쪽 ON CONFLICT (message_id,user_id,emoji)에는
 * partial unique index(uk_message_reactions_active ... WHERE deleted_at IS NULL)와 매칭되는
 * WHERE절이 빠져 있어 그 자체가 "there is no unique or exclusion constraint matching the
 * ON CONFLICT specification"으로 던진다 — 실제로 검증된 적 없는 결함이다(반응 코드는 이번
 * 태스크 대상 아님, 별도 보고만 한다). GroupDAO.addMember는 SectionDAO 쪽의 검증된
 * WHERE절 구문에 addReaction의 "성공+기존 행 반환" 의도를 얹어 고쳤다 — 그룹 멤버 추가
 * 라우트(POST /groups/:groupId/members)는 단건 응답으로 행을 그대로 반환해야 해서(
 * groupRoutes.js:8) DO NOTHING(빈 RETURNING)은 맞지 않는다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`.
 * 목의 ON CONFLICT 분기는 실제 SQL 텍스트에 그 절이 있는지로 판단한다(132/135 교훈 —
 * 목이 SQL과 무관하게 자체적으로 갈아끼우면 실제 코드를 되돌려도 회귀가 못 잡는다).
 *
 * 실행: node src/services/groupMemberDuplicateActiveRegression.test.js
 */


const dbPath = require.resolve('../../config/db');
const NOW = new Date('2026-08-07T00:00:00Z').toISOString();

const binderMembers = {
  'b1:manager1': { binder_id: 'b1', user_id: 'manager1', role: 1, deleted_at: null },
  'b1:member1': { binder_id: 'b1', user_id: 'member1', role: 3, deleted_at: null },
};
const groups = {
  g1: { id: 'g1', binder_id: 'b1', name: 'g1', color: null, created_by: 'manager1', deleted_at: null },
};

// 인메모리 group_members — GroupDAO.addMember의 실제 SQL 텍스트에 ON CONFLICT 절이
// 있는지에 따라 동작을 분기한다(수정 전 SQL을 흉내내면 실제 Postgres 23505 결함을
// 재현하고, 수정 후 SQL이면 "중복=성공, 기존 행 반환"을 재현한다).
const groupMembersTable = [];

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  if (s.startsWith('SELECT id, binder_id, name, color, created_by') && s.includes('FROM groups')) {
    const row = groups[params[0]];
    return { rows: row ? [row] : [] };
  }
  if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
    return { rows: binderMembers[`${params[0]}:${params[1]}`] ? [binderMembers[`${params[0]}:${params[1]}`]] : [] };
  }
  if (s.startsWith('INSERT INTO group_members')) {
    const [id, groupId, userId] = params;
    const activeRow = groupMembersTable.find((r) => r.group_id === groupId && r.user_id === userId && !r.deleted_at);
    const hasFix = s.includes('ON CONFLICT (group_id, user_id) WHERE deleted_at IS NULL DO UPDATE');
    if (activeRow) {
      if (!hasFix) {
        // 실제 Postgres 23505 — statusCode 없음(errorHandler에서 500으로 떨어지는 그 형태).
        const err = new Error('duplicate key value violates unique constraint "uq_group_members_active"');
        err.code = '23505';
        throw err;
      }
      activeRow.updated_at = NOW;
      return { rows: [{ ...activeRow }] };
    }
    const row = { id, group_id: groupId, user_id: userId, created_at: NOW, updated_at: NOW, deleted_at: null };
    groupMembersTable.push(row);
    return { rows: [{ ...row }] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { GroupService } = require('./groupService');

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond, detail) { if (cond) pass++; else { fail++; failures.push(detail ? `${desc}: ${detail}` : desc); } }

async function run() {
  // ============ ① 최초 추가 — 정상 동작(회귀 없음) ============
  const first = await GroupService.addMember('g1', { user_id: 'member1' }, 'manager1');
  check('① 최초 추가 — 정상적으로 행이 생긴다', first && first.user_id === 'member1');
  const firstId = first.id;

  // ============ ② 중복(이미 활성) 멤버 재추가 — 500 대신 성공 + 기존 행 반환 ============
  let thrown = null;
  let second = null;
  try {
    second = await GroupService.addMember('g1', { user_id: 'member1' }, 'manager1');
  } catch (err) {
    thrown = err;
  }
  check('② 중복 활성 멤버 재추가 — 더 이상 예외가 던져지지 않는다(23505가 그대로 올라가 500이 되던 결함 수정)',
    thrown === null, thrown ? `실제로 던져짐: ${thrown.message} (code=${thrown.code})` : undefined);
  check('② 중복 재추가 — 응답은 성공(기존 행)이다', second && second.user_id === 'member1');
  check('② 중복 재추가 — 기존 행의 id를 그대로 반환한다(새 id로 바뀌지 않음, DO UPDATE가 id를 SET하지 않으므로)',
    second && second.id === firstId, `기대=${firstId}, 실제=${second && second.id}`);
  check('② group_members 테이블에 중복 행이 생기지 않는다(정확히 1개)',
    groupMembersTable.filter((r) => r.group_id === 'g1' && r.user_id === 'member1').length === 1);

  // ============ ③ 다른 사용자 추가는 여전히 정상 동작(회귀 없음) ============
  binderMembers['b1:member2'] = { binder_id: 'b1', user_id: 'member2', role: 3, deleted_at: null };
  const third = await GroupService.addMember('g1', { user_id: 'member2' }, 'manager1');
  check('③ 다른 사용자 추가는 영향 없다', third && third.user_id === 'member2');

  console.log(`\n[groupMemberDuplicateActiveRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[groupMemberDuplicateActiveRegression] 실행 실패:', error);
  process.exitCode = 1;
});
