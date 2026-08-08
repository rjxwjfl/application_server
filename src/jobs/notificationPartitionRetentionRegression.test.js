/**
 * src/jobs/notificationPartitionRetentionRegression.test.js
 * =========================================
 * RLY-20260806-173 — notifications(연도별 파티션, config/schema.sql:1035-1041)가
 * cleanupJobs.js 정리 대상에 없어 소프트 삭제된 알림 행이 영구히 남아 있었다(Architect 확인).
 * User 판정: 보관 1년. 파티션 테이블이라 행 단위 DELETE 대신 완전히 지난 연도 파티션을
 * DROP TABLE로 없앤다(cleanupJobs.js의 `cleanupNotificationPartitions` 참조).
 *
 * ⚠️ 이 파일은 JS 쪽 판단 로직(연도 추출·경계 산술·방어적 스킵)만 mock으로 검증한다. DDL이라
 * mock으로는 얕다 — 실제 DROP TABLE·파티션 상속(pg_inherits) 동작 자체는 실제 Postgres
 * (docker `postgres:15-alpine`, 임시 컨테이너, 검증 후 즉시 제거)로 별도 실증했다(구현
 * 보고서 참조). 그 실측에서 경계 행(각 연도 파티션의 첫 순간·마지막 순간, 그리고 "방금
 * 만든" 행)이 기대대로 보존/삭제되는 것까지 확인했다 — 이 회귀는 그 로직이 되돌려지지
 * 않게 잠그는 역할이다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`. config/db·@google-cloud/storage를
 * require.cache/Module._load로 가짜 교체 후 실제 cleanupJobs.js를 그대로 구동한다
 * (mediaWorkerJobs.test.js와 동일 패턴 — GCS는 cleanupJobs.js 모듈 최상단의 `new Storage()`가
 * 즉시 생성자를 호출하기 때문에 최소 스텁이 필요하다).
 *
 * 실행: node src/jobs/notificationPartitionRetentionRegression.test.js
 */

const Module = require('module');

process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test';
process.env.PGDATABASE = process.env.PGDATABASE || 'test';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test';

// @google-cloud/storage 스텁 — cleanupJobs.js 최상단의 `new Storage()`가 즉시 호출된다.
// 이 회귀는 GCS를 전혀 안 쓰지만(cleanupAttachments 미호출) 모듈 로드 자체가 막히지 않게
// 최소 형태만 제공한다(mediaWorkerJobs.test.js와 동일 패턴).
const gcsStub = { Storage: class { bucket() { return {}; } } };
const originalLoad = Module._load;
Module._load = function loadWithStub(request, parent, isMain) {
  if (request === '@google-cloud/storage') return gcsStub;
  return originalLoad.call(this, request, parent, isMain);
};

const dbPath = require.resolve('../../config/db');

let fakeChildren = [];
let fakeCurrentYear = 2026;
const droppedTables = [];

async function mockQuery(sql) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s.includes('FROM pg_inherits')) {
    return { rows: fakeChildren.map((relname) => ({ relname })) };
  }
  if (s.includes('EXTRACT(YEAR FROM NOW())')) {
    return { rows: [{ year: fakeCurrentYear }] };
  }
  const dropMatch = /^DROP TABLE IF EXISTS (\S+)$/.exec(s);
  if (dropMatch) {
    droppedTables.push(dropMatch[1]);
    return { rows: [] };
  }
  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { cleanupNotificationPartitions } = require('./cleanupJobs');
Module._load = originalLoad; // 이후 일반 require는 정상 경로로.

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond, detail) { if (cond) pass++; else { fail++; failures.push(detail ? `${desc}: ${detail}` : desc); } }

async function run() {
  // ============ ① 여러 연도 혼재 — 1년(=2년 경과) 지난 것만 정확히 드롭 ============
  fakeCurrentYear = 2028;
  fakeChildren = ['notifications_2023', 'notifications_2024', 'notifications_2025', 'notifications_2026', 'notifications_2027', 'notifications_2028'];
  droppedTables.length = 0;
  const count1 = await cleanupNotificationPartitions();
  check('① 2028년 기준 — year+2<=2028인 2023~2026만 드롭된다(2027·2028은 보존)',
    droppedTables.sort().join(',') === 'notifications_2023,notifications_2024,notifications_2025,notifications_2026',
    `실제=${droppedTables.join(',')}`);
  check('① 반환값이 드롭 개수(4)와 일치한다', count1 === 4);

  // ============ ② 경계 정밀 — currentYear-2는 드롭, currentYear-1은 보존 ============
  fakeCurrentYear = 2030;
  fakeChildren = ['notifications_2028', 'notifications_2029']; // 2028+2=2030<=2030(드롭), 2029+2=2031>2030(보존)
  droppedTables.length = 0;
  await cleanupNotificationPartitions();
  check('②-1 경계 — currentYear-2(2028)는 드롭된다', droppedTables.includes('notifications_2028'));
  check('②-2 경계 — currentYear-1(2029)은 보존된다(1년 보관 미달)', !droppedTables.includes('notifications_2029'));

  // ============ ③ 현재 연도 파티션은 절대 드롭되지 않는다 ============
  fakeCurrentYear = 2026;
  fakeChildren = ['notifications_2026'];
  droppedTables.length = 0;
  await cleanupNotificationPartitions();
  check('③ 현재 연도(2026) 파티션은 드롭되지 않는다 — "방금 만든 알림"을 담고 있을 수 있다',
    droppedTables.length === 0);

  // ============ ④ 방어적 스킵 — 이름 패턴이 안 맞는 자식은 절대 건드리지 않는다 ============
  fakeCurrentYear = 2030;
  fakeChildren = ['notifications_2020', 'notifications_default', 'notifications_2020_backup', 'not_a_notifications_child'];
  droppedTables.length = 0;
  await cleanupNotificationPartitions();
  check('④ 정규식과 안 맞는 이름은 전부 건드리지 않는다(오직 notifications_2020만 드롭)',
    droppedTables.length === 1 && droppedTables[0] === 'notifications_2020', `실제=${droppedTables.join(',')}`);

  // ============ ⑤ 파티션 자체가 없으면 아무 것도 안 하고 0을 반환 ============
  fakeCurrentYear = 2030;
  fakeChildren = [];
  droppedTables.length = 0;
  const count5 = await cleanupNotificationPartitions();
  check('⑤ 자식 파티션이 없으면 DROP을 시도하지 않고 0을 반환한다', count5 === 0 && droppedTables.length === 0);

  console.log(`\n[notificationPartitionRetentionRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[notificationPartitionRetentionRegression] 실행 실패:', error);
  process.exitCode = 1;
});
