/**
 * src/daos/allDaoSchemaColumnRegression.test.js
 * =========================================
 * RLY-20260806-035 — DAO ↔ 실 스키마 드리프트 전수 수리의 재발 방지 장치.
 *
 * ⚠️ rework 이력: 최초 버전은 "DAO가 참조하는 컬럼"을 사람이 손으로 선언한 목록과 실 스키마만
 * 대조했다 — **소스 파일 자체를 읽지 않았다.** 팀리드가 `post_likes` WHERE 절과 INSERT 컬럼
 * 목록에 존재하지 않는 컬럼(`zzz_fake`)을 직접 주입해 재현했고, 661건이 그대로 통과했다.
 *
 * **이 파일은 방향이 다른 두 검사를 명확히 구분해 둘 다 유지한다(팀리드 지시 — 지우지 말고
 * 이름·주석으로 방향을 명확히 하라):**
 *
 *   § A. **스키마 방향 단언** (`assertSchemaDeclares`/`assertSchemaLacks`) — **코드를 읽지
 *        않는다.** "우리가 이 컬럼이 실존한다고 믿는다"는 사람의 선언과 `config/schema.sql`을
 *        대조한다. 누군가 스키마에서 컬럼을 지우거나 이름을 바꿔 알려진 의존을 깨는 것을 잡는
 *        용도 — **코드 쪽 드리프트(코드가 스키마에 없는 컬럼을 쓰는 것)는 못 잡는다.** 1차
 *        제출의 실패 원인이 정확히 이 방향의 검사를 "코드 드리프트 방지"로 오인한 것이었다.
 *
 *   § B. **소스 스캐너 단언**(이 파일 하단, `sqlSourceScanner.js` 기반) — **실제 .js 소스의
 *        SQL 문자열을 정규식으로 파싱해 컬럼 참조를 뽑아내고, 그것을 실 스키마와 대조한다.**
 *        이게 이번 Task가 실제로 필요로 한 방향 — "코드가 스키마에 없는 컬럼을 쓴다"를 잡는다.
 *        사람이 적은 목록에 의존하지 않는다.
 *
 * 실행: node src/daos/allDaoSchemaColumnRegression.test.js
 *
 * ── 무엇을 세는 숫자인가 ─────────────────────────────────────────────────
 * "REF" = 소스에서 뽑아낸 (테이블, 컬럼, 위치) 참조 하나. 이 회귀가 통과시킨다는 것은
 * "이 REF들이 전부 실 스키마 안에 있다"는 뜻이지, "이 파일들의 SQL을 전부 이해했다"는 뜻이
 * 아니다. **SKIP = 스캐너가 판별을 포기하고 건너뛴 위치.** SKIP이 크면 그만큼 이 회귀의
 * 실질 커버리지가 좁다는 뜻이다 — 그래서 SKIP도 파일별로 집계해 아래에 출력한다(감춘 숫자
 * 없음).
 *
 * ── 자가검증(④) ─────────────────────────────────────────────────────────
 * `src/daos/schemaDriftInjectionSelfTest.js`가 이 파일이 실제로 주입을 잡아내는지 5개
 * 위치(SELECT·INSERT·UPDATE SET·WHERE/AND/ON·RETURNING) 각각에 대해 자동으로 검증한다.
 * `node src/daos/schemaDriftInjectionSelfTest.js`로 별도 실행 — 대상 파일을 실제로 수정했다가
 * 원복하는 파괴적 스크립트라 이 파일 자체에는 포함하지 않는다(그린 상태의 상시 회귀와 섞으면
 * 안 된다).
 *
 * ── 못 잡는 범위(스캐너 설계상 한계 — sqlSourceScanner.js 헤더와 동일) ─────────────
 * 1. `SELECT *` / `SELECT alias.*` — 컬럼명 비노출.
 * 2. RETURNING * — 컬럼명 비노출.
 * 3. SELECT/RETURNING의 복합 표현식(CASE WHEN·서브쿼리·함수 호출 결과에 별칭 붙인 것) — 단순
 *    식별자(`alias.col`)가 아니면 스킵.
 * 4. alias가 CTE·서브쿼리 결과를 가리켜 실제 테이블에 대응하지 않는 경우(예: `WITH restored AS
 *    (...) SELECT user_id FROM restored`) — "restored"가 실 스키마 테이블이 아니므로 스킵.
 * 5. 두 테이블 이상을 JOIN하는데 별칭 접두사 없이 쓴 컬럼(모호 — 잘못된 테이블에 댈 위험이라
 *    보수적으로 스킵).
 * 6. `${table}`·`${column}` 같은 동적 보간으로 테이블/컬럼명 자체가 조립되는 경우
 *    (`deleteCascadeHelpers.js`의 `participantTable`·`sectionTable`, `sectionDAO.js`의
 *    `${table}` 루프) — 정규식이 유효한 테이블명을 못 찾아 그 문(statement) 전체가 스킵된다.
 * 7. `eventDAO.js`·`taskDAO.js` — RLY-20260806-031 소유(진행 중). 이미 알려진 실 결함이 있다
 *    (`event_participants`/`task_participants.inviter_id` — schema.sql에 없는 컬럼을
 *    addParticipant/addParticipantRaw가 참조). 포함시키면 031 작업 도중 이 회귀가 상시 RED로
 *    걸린다 — **EXCLUDED_FILES에 사유와 함께 한 곳에 모아 뒀다. 031이 병합되면 이 배열에서
 *    빼서 자동으로 편입시킬 것.**
 */

const fs = require('fs');
const path = require('path');
const { readSchemaSql, extractTableColumns, getAllTableNames } = require('./schemaColumnCheck');
const { scanFile } = require('./sqlSourceScanner');

let pass = 0;
let fail = 0;
const failures = [];

function check(desc, condition) {
  if (condition) pass += 1;
  else { fail += 1; failures.push(`${desc}: 단언 실패`); }
}

const schemaSql = readSchemaSql();
const allTables = getAllTableNames(schemaSql);
const columnCache = new Map(); // table -> Set(columns)
function realColumnsOf(table) {
  if (!columnCache.has(table)) columnCache.set(table, new Set(extractTableColumns(schemaSql, table)));
  return columnCache.get(table);
}

// ════════════════════════════════════════════════════════════════════════
// § A. 스키마 방향 단언 — 코드를 읽지 않는다(위 헤더 §A 참조).
// "사람이 이 컬럼들이 실존한다고 선언한 목록"이 config/schema.sql과 일치하는지만 본다.
// 코드 드리프트(§B, 소스 스캐너)와는 반대 방향 — 스키마 리팩터링이 알려진 의존을 깨는 것을
// 잡는 용도다. 함수명 자체에 방향을 명시한다(assertColumnsExist라는 이전 이름이 "코드가 이
// 컬럼을 참조한다"는 오해를 유발했다 — 팀리드가 반려한 핵심 이유).
// ════════════════════════════════════════════════════════════════════════

function assertSchemaDeclares(desc, tableName, columns) {
  const real = realColumnsOf(tableName);
  columns.forEach((col) => {
    check(`[스키마 방향] ${desc}: ${tableName}.${col} 존재`, real.has(col));
  });
}

function assertSchemaLacks(desc, tableName, columns) {
  const real = realColumnsOf(tableName);
  columns.forEach((col) => {
    check(`[스키마 방향] ${desc}: ${tableName}.${col} 부재(구 컬럼 재도입 회귀 방지)`, !real.has(col));
  });
}

// post_likes — RLY-20260806-035에서 직접 수정: id·deleted_at 없음, hard delete.
assertSchemaDeclares('postDAO', 'post_likes', ['post_id', 'user_id', 'created_at']);
assertSchemaLacks('postDAO(post_likes — RLY-20260806-035 결함 회귀 방지)', 'post_likes', ['id', 'deleted_at']);

// message_polls·message_poll_options·message_poll_votes — RLY-20260806-035에서 직접 수정:
// is_closed·polls/options.deleted_at·votes.id/created_at 없음.
assertSchemaDeclares('messageService(getPoll/votePoll/closePoll)', 'message_polls',
  ['id', 'message_id', 'question', 'allow_multiple', 'is_anonymous', 'closes_at', 'closed_at', 'created_at', 'updated_at']);
assertSchemaLacks('messageService(message_polls — RLY-20260806-035 결함 회귀 방지)', 'message_polls',
  ['is_closed', 'deleted_at']);
assertSchemaDeclares('messageService(getPoll)', 'message_poll_options',
  ['id', 'poll_id', 'option_text', 'display_order', 'created_at']);
assertSchemaLacks('messageService(message_poll_options — RLY-20260806-035 결함 회귀 방지)', 'message_poll_options',
  ['deleted_at']);
assertSchemaDeclares('messageService(votePoll)', 'message_poll_votes', ['poll_id', 'option_id', 'user_id', 'voted_at']);
assertSchemaLacks('messageService(message_poll_votes — RLY-20260806-035 결함 회귀 방지)', 'message_poll_votes',
  ['id', 'deleted_at', 'created_at']);

// binderService.search() — RLY-20260806-035에서 직접 수정: events/tasks에 binder_id·title
// 없음(calendar_id 경유·summary가 실제 컬럼), posts에 content 없음(body_markdown).
assertSchemaLacks('binderService(search — events, RLY-20260806-035 결함 회귀 방지)', 'events', ['binder_id']);
assertSchemaLacks('binderService(search — events, RLY-20260806-035 결함 회귀 방지)', 'event_instances',
  ['title', 'start_time', 'end_time']);
assertSchemaLacks('binderService(search — tasks, RLY-20260806-035 결함 회귀 방지)', 'tasks', ['binder_id']);
assertSchemaLacks('binderService(search — tasks, RLY-20260806-035 결함 회귀 방지)', 'task_instances', ['title']);
assertSchemaLacks('binderService(search — posts, RLY-20260806-035 결함 회귀 방지)', 'posts', ['content']);

// billingService.getAssets() — RLY-20260806-035에서 직접 수정: user_assets.deleted_at 없음.
assertSchemaLacks('billingService(getAssets — RLY-20260806-035 결함 회귀 방지)', 'user_assets', ['deleted_at']);

// reminders·special_days·events/tasks.reminder_offsets — reminderGenerationRegression.test.js
// (RLY-20260806-026)가 이미 전량 커버해 여기서 중복 선언하지 않는다.

// RLY-20260806-031이 소유 — inviter_id 결함이 이미 알려져 있다(위 헤더 §7). 병합되면 여기서 뺀다.
const EXCLUDED_FILES = new Set([
  'src/daos/eventDao.js',
  'src/daos/taskDAO.js',
]);

// ════════════════════════════════════════════════════════════════════════
// § B. 소스 스캐너 단언 — 실제 .js 소스의 SQL을 파싱해 컬럼 참조를 뽑고 스키마와 대조한다
// (위 헤더 §B 참조). 이번 Task가 실제로 필요로 한 방향 — 코드 드리프트를 잡는다.
// ════════════════════════════════════════════════════════════════════════

const TARGET_FILES = [
  // DAOs
  'src/daos/activityFeedDAO.js',
  'src/daos/attachmentDAO.js',
  'src/daos/auditDAO.js',
  'src/daos/billingDAO.js',
  'src/daos/binderDAO.js',
  'src/daos/calendarDAO.js',
  'src/daos/castDAO.js',
  'src/daos/deleteCascadeHelpers.js',
  'src/daos/groupDAO.js',
  'src/daos/messageDAO.js',
  'src/daos/notificationDAO.js',
  'src/daos/postDAO.js',
  'src/daos/reminderDAO.js',
  'src/daos/sectionDAO.js',
  'src/daos/specialDayDAO.js',
  'src/daos/syncDAO.js',
  'src/daos/userDAO.js',
  'src/daos/userSettingsDAO.js',
  // 원시 SQL을 직접 쓰는 서비스(DAO를 안 거치는 쿼리)
  'src/services/billingService.js',
  'src/services/binderService.js',
  'src/services/mediaService.js',
  'src/services/messageService.js',
  'src/services/notificationService.js',
  'src/services/specialDayService.js',
].filter((f) => !EXCLUDED_FILES.has(f));

const repoRoot = path.join(__dirname, '..', '..');
const skipTotals = {}; // reason -> count (전체 합)
const perFileReport = [];

TARGET_FILES.forEach((relPath) => {
  const abs = path.join(repoRoot, relPath);
  const { refs, skipped, statementCount } = scanFile(abs, allTables);

  let fileRefCount = 0;
  let fileSkipCount = 0;

  refs.forEach(({ table, column, clause }) => {
    fileRefCount += 1;
    const real = realColumnsOf(table);
    check(`${relPath} [${clause}]: ${table}.${column} 존재`, real.has(column));
  });

  skipped.forEach(({ reason, count }) => {
    fileSkipCount += count;
    skipTotals[reason] = (skipTotals[reason] || 0) + count;
  });

  perFileReport.push({ file: relPath, statements: statementCount, refs: fileRefCount, skipped: fileSkipCount });
});

// EXCLUDED_FILES가 실제로 존재하는 파일을 가리키는지(오타로 조용히 전체를 빼먹는 사고 방지).
EXCLUDED_FILES.forEach((relPath) => {
  check(`EXCLUDED_FILES 항목이 실제 파일: ${relPath}`, fs.existsSync(path.join(repoRoot, relPath)));
});

console.log(`\n[allDaoSchemaColumnRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건 — §A 스키마 방향 + §B 소스 스캐너 방향 합산)`);
console.log('\n--- §B 소스 스캐너: 파일별 REF/SKIP 집계 ---');
perFileReport.forEach((r) => {
  console.log(`  ${r.file}: 문장 ${r.statements}건, REF ${r.refs}건 검증, SKIP ${r.skipped}건`);
});
const totalRefs = perFileReport.reduce((s, r) => s + r.refs, 0);
const totalSkips = perFileReport.reduce((s, r) => s + r.skipped, 0);
console.log(`\n합계: REF ${totalRefs}건 검증 / SKIP ${totalSkips}건(스캐너가 판별 포기)`);
console.log('\n--- SKIP 사유별 집계 ---');
Object.entries(skipTotals).sort((a, b) => b[1] - a[1]).forEach(([reason, count]) => {
  console.log(`  ${count}건 — ${reason}`);
});
console.log(`\n제외 파일(031 소유, 위 헤더 §7): ${[...EXCLUDED_FILES].join(', ')}`);

if (failures.length) {
  console.log('\n--- 실패 목록 ---');
  failures.forEach((f) => console.log(' - ' + f));
  process.exitCode = 1;
}
