/**
 * src/daos/auditDAORegression.test.js
 * =========================================
 * RLY-20260806-208 — auditDAO.js는 `insert` 하나뿐이고(SELECT 0건 — .outbox/handover-
 * 20260808.md C-2가 이미 별건으로 등재한 상태) 어떤 회귀 테스트에도 걸리지 않던 파일이었다
 * (RLY-20260806-199 실측). ⚠️ 이 파일은 지금 있는 것(insert 경로)만 덮는다 — 감사 로그를
 * "읽는 수단"은 만들지 않는다(팀장 지시).
 *
 * AuditDAO.insert를 직접 부르는 유일한 소비처는 `src/events/auditHandler.js`의 4개
 * eventBus 리스너(sync·user:registered·member:joined·member:left)다 — 단위 자체보다
 * 이 배선을 검증하는 게 더 값있다: 여기가 깨지면 "감사 로그가 기록되지 않는다"가 아무
 * 데도 드러나지 않고 조용히 사라진다(이 저장소의 다른 이벤트 소비처들과 같은 위험).
 *
 * 검증 대상:
 *   - sync 리스너의 방어 가드(action·target_type·target_id 중 하나라도 없으면 INSERT
 *     자체를 하지 않는다 — 불완전한 감사 행을 만들지 않는 방어)
 *   - member:left의 actor_id 대체 규칙(강퇴=처리한 관리자, 자진 탈퇴=본인 — 통지
 *     경로(notificationHandler.js)와 반대 방향이 아니라 같은 규칙임을 확인한다)
 *   - DB insert 실패가 emit 호출부까지 동기적으로 전파되지 않는다(fire-and-forget —
 *     감사 로그 실패가 실제 기능을 막으면 안 된다는 이 저장소의 기존 관행)
 *
 * mock이 실제로 무엇을 검증하는지 확인(RLY-20260806-135 교훈) — ①(sync 가드)은 프로덕션
 * 코드를 임시로 되돌려(cp 백업 + 복원) 이 테스트가 실제로 실패하는지 확인했다(구현
 * 보고서 참조).
 *
 * 관행: 테스트 프레임워크 없음. plain assert 없이 check() 헬퍼 + `node <file>.js`.
 * config/db를 가짜로 교체(sendAlertTwoChannelRegression.test.js와 동일 패턴).
 *
 * 실행: node src/daos/auditDAORegression.test.js
 */

process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test';
process.env.PGDATABASE = process.env.PGDATABASE || 'test';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test';

const dbPath = require.resolve('../../config/db');

let insertedLogs = [];
let shouldFailInsert = false;

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();

  // AuditDAO.insert
  if (s.startsWith('INSERT INTO audit_logs')) {
    if (shouldFailInsert) throw new Error('[fake] audit_logs insert 실패(시뮬레이션)');
    const [binder_id, actor_id, device_uuid, action_type, target_type, target_id, metadata] = params;
    insertedLogs.push({ binder_id, actor_id, device_uuid, action_type, target_type, target_id, metadata });
    return { rows: [] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { AuditDAO } = require('./auditDAO');
const eventBus = require('../events/eventBus');
require('../events/auditHandler'); // 리스너 등록(require.cache로 1회만 실행됨)
const { TargetType, ActionType } = require('../utils/typeDefinitions');

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond, detail) { if (cond) pass++; else { fail++; failures.push(detail ? `${desc}: ${detail}` : desc); } }

function reset() { insertedLogs = []; shouldFailInsert = false; }

async function flush() {
  // auditHandler.js의 4개 리스너는 전부 await 없이 fire-and-forget으로 AuditDAO.insert를
  // 부른다 — emit 직후 마이크로태스크 큐가 한 바퀴 돌 시간을 준다.
  await new Promise((resolve) => setImmediate(resolve));
}

async function run() {
  // ============ ① AuditDAO.insert 단위 — 파라미터가 정확한 순서로 전달된다 ============
  reset();
  await AuditDAO.insert({ query: mockQuery }, {
    binder_id: 'b1', actor_id: 'u1', device_uuid: 'dev-1',
    action_type: ActionType.CREATE, target_type: TargetType.POST, target_id: 'p1', metadata: { x: 1 },
  });
  check('① INSERT 1건', insertedLogs.length === 1);
  check('① 필드가 정확한 위치에 실린다', insertedLogs[0].binder_id === 'b1' && insertedLogs[0].actor_id === 'u1'
    && insertedLogs[0].action_type === ActionType.CREATE && insertedLogs[0].target_type === TargetType.POST
    && insertedLogs[0].target_id === 'p1', `실제=${JSON.stringify(insertedLogs[0])}`);
  check('① metadata는 JSON 문자열로 저장된다', insertedLogs[0].metadata === JSON.stringify({ x: 1 }));

  // ============ ② sync 리스너 — 정상 이벤트는 그대로 기록된다 ============
  reset();
  eventBus.emit('sync', { binder_id: 'b2', sender_id: 'u2', device_uuid: 'dev-2', action: ActionType.UPDATE, target_type: TargetType.EVENT, target_id: 'e1' });
  await flush();
  check('② sync 정상 이벤트는 기록된다', insertedLogs.length === 1 && insertedLogs[0].action_type === ActionType.UPDATE && insertedLogs[0].target_type === TargetType.EVENT);

  // ============ ③ sync 리스너 — action·target_type·target_id 중 하나라도 없으면 기록하지 않는다(가드) ============
  reset();
  eventBus.emit('sync', { binder_id: 'b3', sender_id: 'u3', target_type: TargetType.EVENT, target_id: 'e2' }); // action 없음
  eventBus.emit('sync', { binder_id: 'b3', sender_id: 'u3', action: ActionType.UPDATE, target_id: 'e2' }); // target_type 없음
  eventBus.emit('sync', { binder_id: 'b3', sender_id: 'u3', action: ActionType.UPDATE, target_type: TargetType.EVENT }); // target_id 없음
  await flush();
  check('③ 불완전한 sync 이벤트 3건 전부 기록되지 않는다(감사 행 절반짜리를 만들지 않는 방어)', insertedLogs.length === 0, `실제=${JSON.stringify(insertedLogs)}`);

  // ============ ④ user:registered — USER 타입으로 기록, binder_id는 null ============
  reset();
  eventBus.emit('user:registered', { user_id: 'u4', provider: 'google' });
  await flush();
  check('④ user:registered은 ActionType.CREATE·TargetType.USER로 기록된다',
    insertedLogs.length === 1 && insertedLogs[0].action_type === ActionType.CREATE && insertedLogs[0].target_type === TargetType.USER
    && insertedLogs[0].target_id === 'u4' && insertedLogs[0].binder_id === null,
    `실제=${JSON.stringify(insertedLogs[0])}`);
  check('④ provider가 metadata에 실린다', insertedLogs[0].metadata === JSON.stringify({ provider: 'google' }));

  // ============ ⑤ member:joined — action 미지정(현재 모든 호출부의 실제 형태) 시 기본값 JOIN ============
  reset();
  eventBus.emit('member:joined', { user_id: 'u5', binder_id: 'b5', device_uuid: 'dev-5' });
  await flush();
  check('⑤ member:joined 기본 action_type은 ActionType.JOIN이다', insertedLogs.length === 1 && insertedLogs[0].action_type === ActionType.JOIN, `실제=${JSON.stringify(insertedLogs[0])}`);
  check('⑤ actor_id는 user_id다(가입한 본인)', insertedLogs[0].actor_id === 'u5');

  // ============ ⑥ member:left — 강퇴(actor_id 있음)는 처리한 관리자가 actor, 자진 탈퇴(actor_id 없음)는 본인이 actor ============
  reset();
  eventBus.emit('member:left', { user_id: 'target6', binder_id: 'b6', actor_id: 'kicker6', action: ActionType.KICK, device_uuid: 'dev-6' });
  await flush();
  check('⑥ 강퇴는 actor_id가 처리한 관리자다(대상 본인이 아니다)', insertedLogs.length === 1 && insertedLogs[0].actor_id === 'kicker6', `실제=${JSON.stringify(insertedLogs[0])}`);
  check('⑥ 강퇴는 action_type=KICK로 기록된다', insertedLogs[0].action_type === ActionType.KICK);
  check('⑥ target_id는 강퇴당한 본인이다(처리자가 아니다)', insertedLogs[0].target_id === 'target6');

  reset();
  eventBus.emit('member:left', { user_id: 'leaver6', binder_id: 'b6', device_uuid: 'dev-6' }); // actor_id·action 모두 없음(자진 탈퇴 — binderService.leaveBinder와 동일 형태)
  await flush();
  check('⑥ 자진 탈퇴는 actor_id가 본인으로 대체된다(actor_id 미지정 시 user_id로 폴백)', insertedLogs.length === 1 && insertedLogs[0].actor_id === 'leaver6', `실제=${JSON.stringify(insertedLogs[0])}`);
  check('⑥ 자진 탈퇴 기본 action_type은 ActionType.LEAVE다', insertedLogs[0].action_type === ActionType.LEAVE);

  // ============ ⑦ DB insert 실패는 emit 호출부까지 동기적으로 전파되지 않는다(fire-and-forget) ============
  reset();
  shouldFailInsert = true;
  let threw = false;
  try {
    eventBus.emit('sync', { binder_id: 'b7', sender_id: 'u7', action: ActionType.CREATE, target_type: TargetType.POST, target_id: 'p7' });
  } catch {
    threw = true;
  }
  await flush();
  check('⑦ audit insert 실패가 emit 호출부로 동기 전파되지 않는다', !threw);

  console.log(`\n[auditDAORegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[auditDAORegression] 실행 실패:', error);
  process.exitCode = 1;
});
