/**
 * src/jobs/partitionAutoCreateRegression.test.js
 * =========================================
 * RLY-20260806-175 — `notifications`·`audit_logs`·`activity_feeds`(전부 `PARTITION BY
 * RANGE(created_at)`)가 `config/schema.sql`에 연도 파티션이 정적으로만 선언돼 있어(173에서
 * 발견), 나열된 마지막 연도를 넘어서면 INSERT가 전면 실패했다. `src/jobs/partitionJobs.js`의
 * `ensurePartitions()`가 holidayJobs.js와 같은 이중 구조(연 1회 cron + 기동 시 자가 보정)로
 * "올해+2년" 파티션이 항상 있도록 만든다.
 *
 * ⚠️ 이 파일은 JS 쪽 로직(연도 범위·존재 여부 분기·테이블별 독립 실패·멱등)만 mock으로
 * 검증한다. DDL이라 mock으로는 얕다 — 실제 `CREATE TABLE IF NOT EXISTS ... PARTITION OF`가
 * 유효한지, 결함이 실재하는지(수정 전 INSERT가 진짜 실패하는지), 수정 후 경계 행이
 * 정확한 파티션에 들어가는지는 실제 Postgres(docker `postgres:15-alpine`, 임시 컨테이너,
 * 검증 후 즉시 제거)로 별도 실증했다(구현 보고서 참조) — 결함을 먼저 재현한 뒤 고쳤다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`. config/db를 가짜로 교체.
 *
 * 실행: node src/jobs/partitionAutoCreateRegression.test.js
 */


process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test';
process.env.PGDATABASE = process.env.PGDATABASE || 'test';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test';

const dbPath = require.resolve('../../config/db');

let fakeCurrentYear = 2026;
let existingRelnames = new Set(); // to_regclass가 "존재함"으로 답할 이름들
let failTables = new Set(); // CREATE 시도 시 강제로 던질 테이블
const createdStatements = [];

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s.includes('EXTRACT(YEAR FROM NOW())')) {
    return { rows: [{ year: fakeCurrentYear }] };
  }
  if (s.includes('to_regclass($1) IS NULL')) {
    const relname = params[0];
    return { rows: [{ missing: !existingRelnames.has(relname) }] };
  }
  const createMatch = /^CREATE TABLE IF NOT EXISTS (\S+) PARTITION OF (\S+)/.exec(s);
  if (createMatch) {
    const [, relname, table] = createMatch;
    if (failTables.has(table)) throw new Error(`시뮬레이션된 DDL 실패: ${table}`);
    createdStatements.push(relname);
    existingRelnames.add(relname); // 다음 호출부턴 존재하는 것으로 취급(현실과 동일)
    return { rows: [] };
  }
  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { ensurePartitions } = require('./partitionJobs');

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond, detail) { if (cond) pass++; else { fail++; failures.push(detail ? `${desc}: ${detail}` : desc); } }

async function run() {
  // ============ ① 아무 파티션도 없음 — 3개 테이블 × 3개 연도(올해~올해+2) 전부 생성 ============
  fakeCurrentYear = 2026;
  existingRelnames = new Set();
  failTables = new Set();
  createdStatements.length = 0;
  const count1 = await ensurePartitions();
  const expected1 = [
    'notifications_2026', 'notifications_2027', 'notifications_2028',
    'audit_logs_2026', 'audit_logs_2027', 'audit_logs_2028',
    'activity_feeds_2026', 'activity_feeds_2027', 'activity_feeds_2028',
  ];
  check('① 세 테이블 × 3개 연도(올해~올해+2년) 전부 생성된다',
    createdStatements.length === 9 && expected1.every((r) => createdStatements.includes(r)),
    `실제=${createdStatements.join(',')}`);
  check('① 반환값이 생성 개수(9)와 일치한다', count1 === 9);

  // ============ ② 이미 일부 있으면 그 연도는 다시 만들지 않는다(멱등의 핵심) ============
  fakeCurrentYear = 2026;
  existingRelnames = new Set(['notifications_2026', 'notifications_2027', 'notifications_2028']);
  failTables = new Set();
  createdStatements.length = 0;
  const count2 = await ensurePartitions();
  check('② 이미 존재하는 notifications 파티션은 다시 생성되지 않는다',
    !createdStatements.some((r) => r.startsWith('notifications_')));
  check('② 나머지(audit_logs·activity_feeds)는 여전히 생성된다', count2 === 6);

  // ============ ③ 같은 상태로 두 번 연속 실행해도 안전(진짜 멱등) ============
  fakeCurrentYear = 2026;
  existingRelnames = new Set();
  failTables = new Set();
  createdStatements.length = 0;
  const firstRun = await ensurePartitions();
  const secondRun = await ensurePartitions(); // existingRelnames가 mock 안에서 누적되므로 이번엔 전부 "이미 있음"
  check('③-1 첫 실행은 9개를 만든다', firstRun === 9);
  check('③-2 같은 상태에서 두 번째 실행은 아무 것도 새로 안 만든다(멱등)', secondRun === 0);

  // ============ ④ 한 테이블에서 실패해도 나머지 테이블은 계속 처리된다 ============
  fakeCurrentYear = 2026;
  existingRelnames = new Set();
  failTables = new Set(['audit_logs']);
  createdStatements.length = 0;
  const count4 = await ensurePartitions();
  check('④ audit_logs가 실패해도 예외가 밖으로 안 던져진다(전체 job이 안 죽는다)', true); // 여기 도달했다는 것 자체가 증거
  check('④ audit_logs를 제외한 notifications·activity_feeds는 정상 생성된다',
    createdStatements.some((r) => r.startsWith('notifications_')) && createdStatements.some((r) => r.startsWith('activity_feeds_'))
    && !createdStatements.some((r) => r.startsWith('audit_logs_')));
  check('④ 반환값은 실패한 테이블 몫만큼 줄어든다(6 = 9 - audit_logs 3개)', count4 === 6);

  // ============ ⑤ 시간이 흘러 올해가 바뀌면 그만큼 새 연도만 채운다 ============
  fakeCurrentYear = 2027; // 작년(2026) 기준 결과가 이미 존재한다고 가정
  existingRelnames = new Set(['notifications_2026', 'notifications_2027', 'notifications_2028',
    'audit_logs_2026', 'audit_logs_2027', 'audit_logs_2028',
    'activity_feeds_2026', 'activity_feeds_2027', 'activity_feeds_2028']);
  failTables = new Set();
  createdStatements.length = 0;
  const count5 = await ensurePartitions();
  check('⑤ 연도가 하나 지나면 올해+2년(2029)치만 새로 채운다(3개 테이블 × 1개 연도)',
    count5 === 3 && ['notifications_2029', 'audit_logs_2029', 'activity_feeds_2029'].every((r) => createdStatements.includes(r)),
    `실제=${createdStatements.join(',')}`);

  console.log(`\n[partitionAutoCreateRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[partitionAutoCreateRegression] 실행 실패:', error);
  process.exitCode = 1;
});
