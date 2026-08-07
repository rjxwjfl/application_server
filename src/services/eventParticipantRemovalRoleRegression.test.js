/**
 * src/services/eventParticipantRemovalRoleRegression.test.js
 * =========================================
 * RLY-20260806-114 ① — eventService.removeParticipant(강퇴)이 `role > 2`(editor까지 허용)를
 * 검사해 api.md:958·SC-event.md §1(69행)·§8-1(565행)·§7 API맵(449행)이 일관되게 요구하는
 * "작성자 또는 master·manager(role≤1)"보다 더 관대했다. Task쪽 동일 기능은 정말 "editor
 * 이상"(SC-task.md:141)이라 코드가 그 패턴을 그대로 옮겨 쓴 것으로 보인다 — 두 문서를 나란히
 * 읽고 event만 축이 다르다는 것을 확인한 뒤 event 쪽만 좁혔다.
 *
 * ⚠️ 권한을 좁히는 변경이라 "차단"만 단언하면 위험하다 — editor 차단·manager 통과·**작성자는
 * role 무관 통과**(instance.author_id 판정) 세 갈래 모두 확인한다. 본인 탈퇴는 이 게이트를
 * 아예 안 타는 기존 동작도 회귀로 고정한다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`, require.cache로 config/db를
 * 가짜 connection으로 교체해 실제 서비스 코드를 그대로 구동한다.
 *
 * 실행: node src/services/eventParticipantRemovalRoleRegression.test.js
 */

const assert = require('assert');

const dbPath = require.resolve('../../config/db');

function freshDb() {
  return {
    // role: 0=master 1=manager 2=editor 3=member
    binderMembers: {
      'b1:master1': { binder_id: 'b1', user_id: 'master1', role: 0, deleted_at: null },
      'b1:manager1': { binder_id: 'b1', user_id: 'manager1', role: 1, deleted_at: null },
      'b1:editor1': { binder_id: 'b1', user_id: 'editor1', role: 2, deleted_at: null },
      // author1 — 이벤트 작성자지만 binder role은 일반 member(role=3). 작성자 예외 검증용.
      'b1:author1': { binder_id: 'b1', user_id: 'author1', role: 3, deleted_at: null },
      'b1:target1': { binder_id: 'b1', user_id: 'target1', role: 3, deleted_at: null },
    },
    // 인스턴스 하나 재사용(참여자 제거는 멱등 UPDATE라 여러 번 호출해도 무방)
    instance: { id: 'ei1', deleted_at: null, calendar_id: 'cal1', author_id: 'author1', binder_id: 'b1', reminder_offsets: null },
    removeCalls: [],
  };
}

function makeMockDb(db) {
  async function mockQuery(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

    // EventDAO.findInstanceContext
    if (s.startsWith('SELECT ei.id, ei.deleted_at, e.calendar_id, e.author_id, c.binder_id')) {
      const [instanceId, eventId] = params;
      if (instanceId !== db.instance.id) return { rows: [] };
      return { rows: [db.instance] };
    }

    // BinderDAO.getMember
    if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
      const row = db.binderMembers[`${params[0]}:${params[1]}`];
      return { rows: row ? [row] : [] };
    }

    // EventDAO.removeParticipant
    if (s.startsWith('UPDATE event_participants')) {
      db.removeCalls.push({ instanceId: params[0], userId: params[1] });
      return { rows: [] };
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
  delete require.cache[require.resolve('./eventService')];
  const { EventService } = require('./eventService');

  // ============ ① 재현 겸 회귀 — editor는 더 이상 타인을 제거할 수 없다 ============
  await expectBlocked(
    '① editor(role=2)는 타인(target1)을 제거할 수 없다(수정 전엔 통과했다)',
    () => EventService.removeParticipant('e1', 'ei1', 'target1', { sender_id: 'editor1', device_uuid: 'd' })
  );
  check('① 차단 후 실제 제거 호출 없음(부작용 없음)', db.removeCalls.length === 0);

  // ============ ② 대조군 — manager·master는 여전히 타인을 제거할 수 있다 ============
  await expectOk(
    '② 대조군 — manager(role=1)는 타인을 제거할 수 있다',
    () => EventService.removeParticipant('e1', 'ei1', 'target1', { sender_id: 'manager1', device_uuid: 'd' })
  );
  check('② manager 제거 호출 기록됨', db.removeCalls.some((c) => c.userId === 'target1'));

  db.removeCalls = [];
  await expectOk(
    '② 대조군 — master(role=0)도 타인을 제거할 수 있다',
    () => EventService.removeParticipant('e1', 'ei1', 'target1', { sender_id: 'master1', device_uuid: 'd' })
  );

  // ============ ③ 대조군 — 이벤트 작성자는 binder role과 무관하게 타인을 제거할 수 있다 ============
  db.removeCalls = [];
  await expectOk(
    '③ 대조군 — 작성자(author1, binder role=member)는 role 무관하게 타인을 제거할 수 있다',
    () => EventService.removeParticipant('e1', 'ei1', 'target1', { sender_id: 'author1', device_uuid: 'd' })
  );
  check('③ 작성자 제거 호출 기록됨', db.removeCalls.some((c) => c.userId === 'target1'));

  // ============ ④ 회귀 불변 — 본인 탈퇴는 role·작성자 여부와 무관하게 항상 허용 ============
  db.removeCalls = [];
  await expectOk(
    '④ 회귀 불변 — 일반 member(target1)의 본인 탈퇴는 게이트를 타지 않고 통과한다',
    () => EventService.removeParticipant('e1', 'ei1', 'target1', { sender_id: 'target1', device_uuid: 'd' })
  );

  console.log(`\n[eventParticipantRemovalRoleRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[eventParticipantRemovalRoleRegression] 실행 실패:', error);
  process.exitCode = 1;
});
