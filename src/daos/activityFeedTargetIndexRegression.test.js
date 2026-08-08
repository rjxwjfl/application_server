/**
 * src/daos/activityFeedTargetIndexRegression.test.js
 * =========================================
 * RLY-20260806-176 — `activity_feeds`를 `target_id`로 거르는 인덱스가 없었다(164 확인).
 * `idx_feed_target (target_type, target_id, created_at DESC)`를 파티션 부모에 한 번만
 * 냈다 — 파티션별로 따로 내지 않는다.
 *
 * ⚠️ 이 회귀가 정말로 잠그는 것: "파티션 부모에 한 번만 낸 CREATE INDEX가 기존·향후
 * 자식 파티션 전부에 자동 전파되는가"는 **DDL·카탈로그 동작이라 mock으로는 검증할 수
 * 없다** — 실제 Postgres(docker `postgres:15-alpine`, 임시 컨테이너, 검증 후 즉시 제거)로
 * 직접 실증했다(구현 보고서 참조): 부모에 인덱스를 낸 뒤 175의 자동 생성 경로와 동일한
 * `CREATE TABLE IF NOT EXISTS activity_feeds_2028 PARTITION OF ...`로 새 파티션을 붙였더니
 * 그 파티션에도 대응 인덱스가 즉시 자동으로 생겼다(`pg_index`로 확인). `DROP INDEX`도
 * 부모에서 한 번이면 자식의 대응 인덱스까지 함께 사라지는 것을 확인했다.
 *
 * 이 파일이 대신 **고정하는 것**은 구현이 "파티션 부모 단 하나에만 인덱스를 낸다"는
 * 구조 자체다 — 실증이 성립하는 전제(단일 부모 CREATE INDEX)가 나중에 실수로 "파티션별로
 * 따로 낸다"·"자식 테이블 이름에 직접 낸다" 식으로 바뀌면, 그 순간 위 실증이 더는
 * 유효하지 않게 된다. 소스 텍스트를 직접 읽어 그 전제가 깨지지 않았는지 정적으로
 * 단언한다(reminderDispatchRegression.test.js의 "SQL 문자열 정적 단언" 관행과 동일).
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`.
 *
 * 실행: node src/daos/activityFeedTargetIndexRegression.test.js
 */

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond, detail) { if (cond) pass++; else { fail++; failures.push(detail ? `${desc}: ${detail}` : desc); } }

const migrationPath = path.join(__dirname, '../../migrations/20260808_activity_feeds_target_index.sql');
const downMigrationPath = path.join(__dirname, '../../migrations/20260808_activity_feeds_target_index.down.sql');
const schemaPath = path.join(__dirname, '../../config/schema.sql');

// SQL 라인 주석(`-- ...`)을 제거한 뒤 검사한다 — 이 파일들의 주석 자체가 실측 근거를
// 설명하며 "activity_feeds_2028"·"CONCURRENTLY"·"CREATE INDEX" 같은 단어를 예시로 인용하고
// 있어, 주석까지 그대로 검사하면 실제로 실행되는 SQL 문이 아니라 설명 텍스트에 걸려
// 오탐이 난다(정규식이 SQL 파서가 아니므로 실제 실행문만 남기고 비교해야 한다).
const stripSqlComments = (src) => src.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');

const migrationSrc = stripSqlComments(fs.readFileSync(migrationPath, 'utf8'));
const downMigrationSrc = stripSqlComments(fs.readFileSync(downMigrationPath, 'utf8'));
const schemaSrc = fs.readFileSync(schemaPath, 'utf8'); // schema.sql은 부분 문자열만 찾으므로 그대로 둬도 무방

async function run() {
  // ============ ① 마이그레이션이 정확히 기대하는 인덱스를 파티션 부모에 낸다 ============
  check('① 마이그레이션이 idx_feed_target을 (target_type, target_id, created_at DESC)로 만든다',
    /CREATE INDEX IF NOT EXISTS idx_feed_target ON activity_feeds \(target_type, target_id, created_at DESC\)/.test(migrationSrc));

  // ============ ② 파티션 부모(activity_feeds) 단 하나에만 낸다 — 자식 테이블명 직접 지정 금지 ============
  // "activity_feeds_"로 시작하는 자식 파티션 이름이 이 마이그레이션 안에 전혀 등장하지
  // 않아야 한다 — 등장한다면 누군가 파티션별로 따로 인덱스를 내는 것으로 바꿨다는 뜻이고,
  // 그러면 위 실증(자동 전파)의 전제가 깨진다.
  check('② 마이그레이션에 자식 파티션 이름(activity_feeds_YYYY)이 등장하지 않는다(부모에만 낸다)',
    !/activity_feeds_\d{4}/.test(migrationSrc), `실제 내용에서 발견: ${(migrationSrc.match(/activity_feeds_\d{4}/g) || []).join(',')}`);

  // ============ ③ CREATE INDEX가 이 마이그레이션 안에 정확히 1번만 있다(파티션별 반복 금지) ============
  const createIndexCount = (migrationSrc.match(/CREATE INDEX/g) || []).length;
  check('③ CREATE INDEX 문이 정확히 1개다(파티션마다 반복해서 내지 않는다)', createIndexCount === 1, `실제=${createIndexCount}`);

  // ============ ④ down 마이그레이션도 부모에서 한 번만 DROP한다 ============
  check('④ down 마이그레이션이 idx_feed_target을 DROP한다', /DROP INDEX IF EXISTS idx_feed_target/.test(downMigrationSrc));
  check('④ down 마이그레이션에도 자식 파티션 이름이 등장하지 않는다',
    !/activity_feeds_\d{4}/.test(downMigrationSrc));

  // ============ ⑤ CONCURRENTLY를 쓰지 않는다(파티션 부모에 못 쓴다는 것을 실측으로 확인) ============
  check('⑤ 마이그레이션이 CONCURRENTLY를 쓰지 않는다(파티션 부모 테이블엔 못 쓴다 — 실측: "cannot create index on partitioned table ... concurrently")',
    !/CONCURRENTLY/i.test(migrationSrc));

  // ============ ⑥ schema.sql도 마이그레이션과 동일한 인덱스를 반영한다(147 방식 — 신규 설치 동기화) ============
  check('⑥ schema.sql에도 동일한 idx_feed_target 선언이 있다',
    /CREATE INDEX idx_feed_target ON activity_feeds \(target_type, target_id, created_at DESC\)/.test(schemaSrc));

  // ============ ⑦ 기존 idx_feed_binder_cursor와 안 겹친다는 전제 확인(선두 컬럼이 다름) ============
  const binderCursorMatch = /CREATE INDEX idx_feed_binder_cursor ON activity_feeds \(([^)]+)\)/.exec(schemaSrc);
  check('⑦ 기존 idx_feed_binder_cursor를 찾음', !!binderCursorMatch);
  const binderCursorLeadCol = binderCursorMatch ? binderCursorMatch[1].split(',')[0].trim() : null;
  check('⑦ 기존 인덱스의 선두 컬럼이 binder_id라 target_id 조회와 안 겹친다(재사용 불가 판정의 근거)',
    binderCursorLeadCol === 'binder_id', `실제 선두 컬럼=${binderCursorLeadCol}`);

  // ============ ⑧ ActivityFeedDAO에 target_id 단위 조회 메서드가 아직 없다(4번 — 보고만, 이번엔 안 만듦) ============
  // target_id는 insert()의 INSERT 컬럼 목록에 이미 등장한다(정상) — 여기서 잠그는 것은
  // "target_id로 거르는 SELECT/WHERE 조회 메서드"의 부재다. 있다면 이 회귀가 실패해
  // 신호를 준다(클라 Domain Task와 짝인 별도 작업이라 이번엔 만들지 않았다는 전제가
  // 깨졌다는 뜻 — 그때 다시 판단이 필요하다).
  const daoSrc = fs.readFileSync(path.join(__dirname, 'activityFeedDAO.js'), 'utf8');
  check('⑧ ActivityFeedDAO에 target_id로 거르는 SELECT 조회 메서드가 아직 없다',
    !/WHERE[^;]*target_id/is.test(daoSrc), 'daoSrc의 WHERE 절에서 target_id 발견 — 이미 구현됐을 수 있다, 재확인 필요');

  console.log(`\n[activityFeedTargetIndexRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[activityFeedTargetIndexRegression] 실행 실패:', error);
  process.exitCode = 1;
});
