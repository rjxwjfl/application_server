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
  // RLY-20260806-031 병합 완료 — 제외 해제됨. 두 파일 모두 스캐너 대상이다.
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

// ════════════════════════════════════════════════════════════════════════
// § C. "쓰기 공백" 방향 — 스키마엔 있는데 이 저장소 어디의 INSERT·UPDATE SET 에도 없는
// 컬럼을 잡는다. RLY-20260806-104(조사)가 제안한 것을 RLY-20260806-112(사용자 승인)가
// 상설화한다. §A·§B와 다른 세 번째 방향 — **§B와 같은 스캐너(sqlSourceScanner.js)의 REF를
// 재사용하되 clause 필터만 다르다**(`INSERT columns`·`UPDATE SET`만 본다). 새 파서를 만들지
// 않았다. ⚠️ **§B는 이 절에서 전혀 건드리지 않는다** — §C는 아래에서 독립적으로 다시 스캔한다
// (§B의 기존 REF 카운트·통과 건수에 부작용을 주지 않기 위해서다. `TARGET_FILES` 배열은
// **읽기만** 재사용한다 — §B가 그 배열로 하는 일은 그대로다).
//
// ── 대상 파일 ────────────────────────────────────────────────────────────
// §B와 동일한 TARGET_FILES + job 파일 3개(`cleanupJobs.js`·`holidayJobs.js`·
// `subscriptionJobs.js` — raw `pool.query`를 쓰는데 §B 스캔 대상엔 없었다. RLY-20260806-104가
// 직접 찾은 공백이다).
//
// ⚠️ **§B를 이 job 파일 3개까지 확장해야 하는가 — 판단(이번엔 하지 않았다)**: §B는 "코드가
// 스키마에 없는 컬럼을 쓴다"(존재 방향)를 잡는다. job 파일 3개도 raw SQL을 쓰므로 원리적으로는
// 같은 위험(스키마에 없는 컬럼 참조)에 노출돼 있다 — **확장하는 게 맞아 보인다.** 다만 이번
// Task는 "쓰기 공백"(§C) 상설화가 목적이라 §B 자체의 범위 변경은 별도 승인 없이 하지 않았다
// (지시 — "§B 확장은 이번에 하지 마라"). 비용은 낮다(TARGET_FILES 배열에 세 줄 추가하면 끝,
// 새 인프라 불필요) — 다음 Task로 그대로 넘길 수 있다.
//
// ── 이 방향이 못 잡는 범위(§B와 같은 스캐너 한계를 그대로 물려받는다 — 지우지 말 것) ──
// 파일 헤더의 "못 잡는 범위" 1~7과 전부 동일(같은 스캐너이므로). **이 §C에서 실제로 두 번
// 부딪힌 구체 사례**(RLY-20260806-104 조사에서 발견, 둘 다 아래 화이트리스트에
// `동적SQL-확인됨`으로 태그돼 있다 — 지우지 말 것, 지우면 다음 사람이 "왜 여기 있지?" 하며
// 다시 조사해야 한다):
//   · `message_embeds.updated_at`·`deleted_at` — `sectionDAO.js`의
//     `for (const table of ['message_embeds', 'message_reactions', 'message_mentions']) {
//       UPDATE ${table} child SET deleted_at = now()... }` 캐스케이드 루프(섹션 삭제 시)가
//     실제로 쓴다 — `${table}` 동적 보간이라 정규식이 테이블명을 못 찾아(한계 6) 스캐너가
//     이 문(statement) 전체를 스킵한다.
//   · `user_settings`의 거의 모든 설정 컬럼 — `userSettingsDAO.updatePartial()`이
//     `SET ${setClauses.join(', ')}`로 **런타임에** SQL을 조립한다(한계 6, 동일 이유). 스캐너는
//     문자열 리터럴만 파싱하므로 이 동적 조립을 SET 컬럼으로 못 뽑는다.
// 둘 다 RLY-20260806-104가 직접 소스를 읽어 실제로 정상 기록되는 것을 확인했다 — 결함이
// 아니라 **스캐너의 판별 한계**다.
//
// ── 화이트리스트 vs 알려진 미해결 — 구조적으로 다르다(섞지 말 것) ──────────────────
// `_writeGapWhitelist` = **의도적으로 안 써지는 컬럼(결함 아님)**. 사유 태그 5종
// (RLY-20260806-104 권고 체계 그대로):
//   · `DEFAULT`        — 스키마 `DEFAULT`/`GENERATED`로 채워진다(INSERT가 명시할 필요 없음).
//   · `동적SQL-확인됨`  — 스캐너 한계로 안 보이지만 직접 소스를 읽어 정상 기록을 확인했다.
//   · `V2`             — 아직 만들지 않기로 한 기능의 선언된 컬럼(`docs/v2/` 근거).
//   · `폐기`           — 폐기된 기능의 잔존 컬럼(스키마 정리는 별건).
//   · `미착수`         — 읽기도 쓰기도 없다(기능 자체가 서버에 없다 — "쓰기 공백"이 아니라
//                        "미착수"라는 RLY-20260806-104의 핵심 구분).
// 초기 시드는 **RLY-20260806-104 조사의 "확인함" 절을 그대로 옮겼다 — 여기서 다시 판정하지
// 않았다.**
//
// `_writeGapKnownIssues` = **실제 결함인데 이번 Task(장치를 만드는 것) 범위 밖이라 지금 안
// 고친 것**. 화이트리스트에 넣지 않는다 — 넣으면 "지금 있는 결함을 화이트리스트로 덮는" 것이
// 된다(금지 사항). 대신 **실행마다 경고를 출력**하고 실패로 세지 않는다(클라
// `test/tooling/server_response_dto_drift_regression_test.dart` §6-1의 `_knownIssues`와
// 대칭 구조 — RLY-20260806-109가 먼저 쓴 패턴을 그대로 따랐다). 고쳐지면 이 배열에서 항목을
// 빼라 — 그러면 §C가 자동으로 "이제 안 빠졌다"를 검증하게 된다.
// ════════════════════════════════════════════════════════════════════════

// ⚠️ RLY-20260806-112 실측 발견 — `eventDao.js`·`taskDAO.js`도 §C 첫 실행에서 events·tasks·
// event_instances·task_instances 등 6개 테이블 전체를 "쓰기 공백"으로 대량 오탐시켰다(둘 다
// 실제로는 정상 기록되는 핵심 테이블이다). 원인: 파일 헤더 §7 주석("031 병합 완료 — 제외
// 해제됨, 두 파일 모두 스캐너 대상")과 달리 **`TARGET_FILES`(§B) 배열엔 실제로 이 두 파일이
// 없다** — 주석과 배열이 서로 어긋난 상태였다. §B 자체는 이번 Task에서 건드리지 않았다(지시)
// — 이 사실은 구현 보고서에 별도로 등재했다. §C는 이 두 파일 없이는 정확도를 낼 수 없어
// 아래 목록에 추가했다(§B TARGET_FILES를 고치는 게 아니라 §C 자체의 스캔 대상을 넓히는 것).
const WRITE_GAP_EXTRA_FILES = [
  'src/jobs/cleanupJobs.js',
  'src/jobs/holidayJobs.js',
  'src/jobs/subscriptionJobs.js',
  'src/daos/eventDao.js',
  'src/daos/taskDAO.js',
];

const _writeGapWhitelist = [
  // ── DEFAULT/GENERATED ──────────────────────────────────────────────────
  { table: 'activity_feeds', column: 'id', reason: 'DEFAULT', note: 'GENERATED ALWAYS AS IDENTITY(schema.sql).' },
  { table: 'activity_feeds', column: 'created_at', reason: 'DEFAULT', note: 'DEFAULT now().' },
  { table: 'audit_logs', column: 'id', reason: 'DEFAULT', note: 'GENERATED ALWAYS AS IDENTITY.' },
  { table: 'audit_logs', column: 'created_at', reason: 'DEFAULT', note: 'DEFAULT now().' },
  { table: 'binder_join_requests', column: 'expires_at', reason: 'DEFAULT', note: "DEFAULT now() + INTERVAL '30 days'." },
  { table: 'group_members', column: 'created_at', reason: 'DEFAULT', note: 'DEFAULT now().' },
  { table: 'groups', column: 'created_at', reason: 'DEFAULT', note: 'DEFAULT now().' },
  { table: 'holidays', column: 'id', reason: 'DEFAULT', note: 'SERIAL.' },
  { table: 'holidays', column: 'created_at', reason: 'DEFAULT', note: 'DEFAULT now().' },
  { table: 'holidays', column: 'updated_at', reason: 'DEFAULT', note: 'DEFAULT now() — holidayJobs.js INSERT가 명시하지 않는다.' },
  { table: 'message_embeds', column: 'created_at', reason: 'DEFAULT', note: 'DEFAULT now().' },
  { table: 'message_mentions', column: 'created_at', reason: 'DEFAULT', note: 'DEFAULT now().' },
  { table: 'notifications', column: 'created_at', reason: 'DEFAULT', note: 'DEFAULT now() — RLY-20260806-104 보고서가 이 컬럼을 "확인함" 절에서 빠뜨렸다(원시 스캔엔 있었으나 정리 중 누락됨) — §C를 실제로 돌려서 그 누락 자체를 여기서 잡아 시드에 추가했다.' },
  { table: 'payment_receipt_logs', column: 'id', reason: 'DEFAULT', note: 'GENERATED ALWAYS AS IDENTITY.' },
  { table: 'section_members', column: 'created_at', reason: 'DEFAULT', note: 'DEFAULT now().' },
  { table: 'subscription_events', column: 'id', reason: 'DEFAULT', note: 'GENERATED ALWAYS AS IDENTITY(billingDAO.js가 실제 INSERT, id만 자동).' },
  { table: 'user_settings', column: 'created_at', reason: 'DEFAULT', note: 'createDefault()가 user_id만 명시 INSERT — 나머지는 스키마 DEFAULT.' },

  // ── 동적SQL-확인됨(위 "못 잡는 범위" 참조 — 직접 소스를 읽어 정상 기록을 확인함) ──────
  { table: 'message_embeds', column: 'updated_at', reason: '동적SQL-확인됨', note: "sectionDAO.js의 `${table}` 캐스케이드 루프(섹션 삭제 시)가 실제로 쓴다." },
  { table: 'message_embeds', column: 'deleted_at', reason: '동적SQL-확인됨', note: '위와 동일 캐스케이드.' },
  { table: 'user_settings', column: 'language_code', reason: '동적SQL-확인됨', note: "userSettingsDAO.updatePartial()의 동적 SET 조립이 쓴다." },
  { table: 'user_settings', column: 'holidays_countries', reason: '동적SQL-확인됨', note: '위와 동일.' },
  { table: 'user_settings', column: 'timezone', reason: '동적SQL-확인됨', note: '위와 동일.' },
  { table: 'user_settings', column: 'first_day_of_week', reason: '동적SQL-확인됨', note: '위와 동일.' },
  { table: 'user_settings', column: 'show_lunar_calendar', reason: '동적SQL-확인됨', note: '위와 동일.' },
  { table: 'user_settings', column: 'show_week_numbers', reason: '동적SQL-확인됨', note: '위와 동일.' },
  { table: 'user_settings', column: 'blue_saturday', reason: '동적SQL-확인됨', note: '위와 동일.' },
  { table: 'user_settings', column: 'is_push_enabled', reason: '동적SQL-확인됨', note: '위와 동일.' },
  { table: 'user_settings', column: 'is_notice_enabled', reason: '동적SQL-확인됨', note: '위와 동일.' },
  { table: 'user_settings', column: 'font_size', reason: '동적SQL-확인됨', note: '위와 동일.' },
  { table: 'user_settings', column: 'theme_preference', reason: '동적SQL-확인됨', note: '위와 동일.' },
  { table: 'user_settings', column: 'updated_at', reason: '동적SQL-확인됨', note: "updatePartial()이 `setClauses.push('updated_at = NOW()')`로 동적 추가." },

  // ── 폐기 ──────────────────────────────────────────────────────────────
  { table: 'calendars', column: 'usage_type', reason: '폐기', note: 'SC-shift-manage ⚫ 폐기(2026-08-01 User 결정, specs_index.md). 스키마 컬럼 정리는 별건.' },

  // ── 미착수(읽기도 쓰기도 없음 — 기능 자체가 서버에 없다) ──────────────────────
  { table: 'binder_boosts', column: 'binder_id', reason: '미착수', note: 'Boost 구매 흐름 전체 미구현(verifyBoost 등 501 — RLY-20260806-099가 확인).' },
  { table: 'binder_boosts', column: 'tier', reason: '미착수', note: '위와 동일.' },
  { table: 'binder_boosts', column: 'status', reason: '미착수', note: '위와 동일 — RLY-20260806-099가 읽기(SELECT)만 추가했다, 쓰기는 여전히 없다.' },
  { table: 'binder_boosts', column: 'paid_by_user_id', reason: '미착수', note: '위와 동일.' },
  { table: 'binder_boosts', column: 'product_id', reason: '미착수', note: '위와 동일.' },
  { table: 'binder_boosts', column: 'store_type', reason: '미착수', note: '위와 동일.' },
  { table: 'binder_boosts', column: 'original_transaction_id', reason: '미착수', note: '위와 동일.' },
  { table: 'binder_boosts', column: 'current_period_start', reason: '미착수', note: '위와 동일.' },
  { table: 'binder_boosts', column: 'current_period_end', reason: '미착수', note: '위와 동일 — 읽기만 있음.' },
  { table: 'binder_boosts', column: 'grace_period_end', reason: '미착수', note: '위와 동일.' },
  { table: 'binder_boosts', column: 'cancel_at_period_end', reason: '미착수', note: '위와 동일.' },
  { table: 'binder_boosts', column: 'created_at', reason: '미착수', note: '위와 동일.' },
  { table: 'binder_boosts', column: 'updated_at', reason: '미착수', note: '위와 동일.' },
  { table: 'holidays', column: 'deleted_at', reason: '미착수', note: '참조 데이터라 삭제 기능 자체가 없다 — holidayJobs.js는 INSERT만 한다.' },
  { table: 'special_days', column: 'recurrence_policy_version', reason: '미착수', note: 'RLY-20260806-082 확인: 서버 내부 마이그레이션 북키핑용, 클라 계약 없음(DEFAULT 1).' },
  { table: 'user_settings', column: 'persona_hint', reason: '미착수', note: 'api.md가 응답 예시에 포함하지만 서버 SELECT·INSERT·UPDATE 어디에도 없다.' },
  { table: 'user_terms_consents', column: 'id', reason: '미착수', note: 'SC-blocked(계정 정지·휴면 UX) 전체 미구현 — 테이블 전체 참조 0건.' },
  { table: 'user_terms_consents', column: 'user_id', reason: '미착수', note: '위와 동일.' },
  { table: 'user_terms_consents', column: 'terms_version', reason: '미착수', note: '위와 동일.' },
  { table: 'user_terms_consents', column: 'privacy_version', reason: '미착수', note: '위와 동일.' },
  { table: 'user_terms_consents', column: 'consented_at', reason: '미착수', note: '위와 동일.' },
  { table: 'user_terms_consents', column: 'consent_source', reason: '미착수', note: '위와 동일.' },
  { table: 'users', column: 'suspended_reason', reason: '미착수', note: 'SC-blocked 미구현 — api.md AuthUserResponse 예시엔 있으나 서버가 읽지도 쓰지도 않는다.' },
  { table: 'users', column: 'suspended_until', reason: '미착수', note: '위와 동일.' },
  { table: 'users', column: 'inactive_since', reason: '미착수', note: '위와 동일.' },
];

// ⚠️ 화이트리스트가 아니다 — 실제 결함이다. 화이트리스트로 덮지 마라(AC).
const _writeGapKnownIssues = [
  {
    table: 'notifications', column: 'group_key', reason: '실제결함-규칙미정',
    note: 'RLY-20260806-108: SC-notifications.md §16-4가 "미해결·UI 표준 미정"이라 규칙을 '
      + '정하지 않고 구현을 보류했다. 읽기(notificationDAO.getByRecipient의 SELECT 목록)·문서 '
      + '계약(SC-notifications.md 시나리오 E20·design_intent.md)은 있는데 INSERT가 안 채운다. '
      + '규칙이 정해지면 이 배열에서 항목을 빼라.',
  },
];

function writeGapWhitelistFor(table) {
  return new Set(_writeGapWhitelist.filter((w) => w.table === table).map((w) => w.column));
}
function writeGapKnownIssuesFor(table) {
  return new Set(_writeGapKnownIssues.filter((w) => w.table === table).map((w) => w.column));
}

// 화이트리스트·알려진 미해결 항목 자체가 실재 컬럼을 가리키는지(오타로 조용히 무력화되는
// 사고 방지 — EXCLUDED_FILES 존재 확인과 동일 패턴, §B 위 참조).
[..._writeGapWhitelist, ..._writeGapKnownIssues].forEach((entry) => {
  const real = realColumnsOf(entry.table);
  check(`[쓰기 공백 §C] 화이트리스트/알려진 미해결 항목이 실재 컬럼을 가리킨다: ${entry.table}.${entry.column}`, real.has(entry.column));
});

// ── 자가검증 — 진단 로직 자체가 실제로 "안 쓴 컬럼"을 잡는지 합성 fixture로 확인한다
// (client `server_response_dto_drift_regression_test.dart` §7과 대칭 — 실제 파일 없이
// 파서·대조 로직만 검증). 실제 파일 기반 검증(아래)과는 별개다 — 둘 다 있어야
// "로직이 맞는가"와 "진짜 경로에서 도는가"를 각각 증명한다(팀리드 지시).
(function selfTestWriteGapDetection() {
  const { scanOneStatement } = require('./sqlSourceScanner');
  const fixtureTables = new Set(['widgets']);
  const fixtureSql = 'INSERT INTO widgets (id, name) VALUES ($1, $2)';
  const { refs } = scanOneStatement(fixtureSql, fixtureTables);
  const writtenCols = new Set(refs.filter((r) => r.clause === 'INSERT columns').map((r) => r.column));
  check('[쓰기 공백 §C 자가검증] INSERT 컬럼이 실제로 "쓴 컬럼"으로 잡힌다', writtenCols.has('id') && writtenCols.has('name'));
  check(
    '[쓰기 공백 §C 자가검증] ⚠️ INSERT에 없는 컬럼(예: created_at)은 "안 쓴 컬럼"으로 남는다 — 이게 이 장치의 존재 이유다',
    !writtenCols.has('created_at')
  );
})();

// ── 실제 파일 대조 — TARGET_FILES(§B와 공유, 읽기만) + job 파일 3개를 다시 스캔해
// 테이블별 "실제로 쓴 컬럼" 집합을 만들고 스키마 전체 컬럼과 차집합한다.
const writeGapWrittenColumns = new Map(); // table -> Set(column)
[...TARGET_FILES, ...WRITE_GAP_EXTRA_FILES].forEach((relPath) => {
  const abs = path.join(repoRoot, relPath);
  const { refs } = scanFile(abs, allTables);
  refs.forEach(({ table, column, clause }) => {
    if (clause !== 'INSERT columns' && clause !== 'UPDATE SET') return;
    if (!writeGapWrittenColumns.has(table)) writeGapWrittenColumns.set(table, new Set());
    writeGapWrittenColumns.get(table).add(column);
  });
});

// job 파일 3개가 실제로 존재하는지(오타 방지 — EXCLUDED_FILES 존재 확인과 동일 패턴).
WRITE_GAP_EXTRA_FILES.forEach((relPath) => {
  check(`[쓰기 공백 §C] job 파일이 실제로 존재한다: ${relPath}`, fs.existsSync(path.join(repoRoot, relPath)));
});

let writeGapKnownIssueHits = 0;
allTables.forEach((table) => {
  let schemaCols;
  try {
    schemaCols = extractTableColumns(schemaSql, table);
  } catch (e) {
    return; // 파티션 자식 테이블 — 부모에서 컬럼을 상속받아 자체 컬럼 선언이 없다.
  }
  if (!schemaCols || schemaCols.length === 0) return;

  const written = writeGapWrittenColumns.get(table) || new Set();
  const whitelisted = writeGapWhitelistFor(table);
  const known = writeGapKnownIssuesFor(table);

  schemaCols.filter((col) => !written.has(col)).forEach((col) => {
    if (known.has(col)) {
      writeGapKnownIssueHits += 1;
      // 실패로 세지 않는다(§ 위 "화이트리스트 vs 알려진 미해결" 근거) — 대신 실행마다
      // 눈에 띄게 출력한다. "고쳐지면 목록에서 빠지게 해라"를 사람이 알아채려면 계속 보여야 한다.
      console.log(`⚠️  [쓰기 공백 §C — 알려진 미해결] ${table}.${col} — INSERT·UPDATE SET 어디에도 여전히 없음(실패로 세지 않음, 고쳐지면 _writeGapKnownIssues에서 빼라)`);
      return;
    }
    check(
      `[쓰기 공백 §C] ${table}.${col} — INSERT·UPDATE SET 어디에도 없음(화이트리스트 없음)`,
      whitelisted.has(col)
    );
  });
});

console.log(`\n[쓰기 공백 §C] 화이트리스트 ${_writeGapWhitelist.length}건 · 알려진 미해결 ${_writeGapKnownIssues.length}건(이번 실행에서 ${writeGapKnownIssueHits}건 재확인) · 스캔 파일 ${TARGET_FILES.length + WRITE_GAP_EXTRA_FILES.length}개(§B TARGET_FILES ${TARGET_FILES.length} + job 파일 ${WRITE_GAP_EXTRA_FILES.length}).`);

console.log(`\n[allDaoSchemaColumnRegression 전체] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건 — §A + §B + §C 합산)`);

if (failures.length) {
  console.log('\n--- 실패 목록 ---');
  failures.forEach((f) => console.log(' - ' + f));
  process.exitCode = 1;
}
