/**
 * src/utils/recurrenceGoldenVectorRegression.test.js
 * =========================================
 * RLY-20260806-043 — 클라·서버 회차 전개 상호 검증 상설화.
 *
 * 037(`recurrenceExpansion.js`)은 "서버가 표준 라이브러리(rrule, RFC 5545)로 독립 전개해
 * 클라 제출과 대조한다"는 계약을 구현한다. 이 계약은 **클라가 같은 표준으로 전개한다는 전제**에
 * 기대는데, 그 전제는 040(클라 반복 전개를 RFC 5545로 정렬) 병합 전까지 실제로 깨져 있었다
 * (월말 31일 반복 생성이 전부 422로 거부됨 — 손으로 한 번 대조해서 잡았을 뿐, 회귀로 지켜지지
 * 않고 있었다). 이 스위트는 그 손 대조를 상설 회귀로 대체한다.
 *
 * 클라 저장소의 골든 벡터 파일(`test/fixtures/recurrence_golden_vectors.json`)을 **읽기 전용으로
 * 직접** 읽어, 각 vector를 서버의 `expandOccurrences`로 독립 전개하고 `expectedOccurrences`와
 * 대조한다 — 클라 테스트가 같은 파일을 기대값으로 쓰므로, 어느 쪽 구현이 표준에서 벗어나도 이
 * 스위트가 걸린다. **골든 벡터를 서버 쪽에 복제하지 않는다** — 복제하면 "두 벌"이 되어 이 Task의
 * 목적(단일 진실 소스 대조) 자체가 무너진다.
 *
 * ── 저장소 경계를 넘는 파일 참조 — 판단과 한계 ──────────────────────────────────
 * 서버·클라는 별도 Git 저장소이고 커밋 이력을 공유하지 않는다. 그런데도 이 저장소 밖 파일을
 * 직접 읽기로 판단한 이유: 골든 벡터는 클라가 소유하는 "표준의 정의"이고, 서버가 그걸 복제하면
 * 복제본이 낡아도 아무도 모른다(바로 이 Task가 고치려는 것과 같은 종류의 실패 모드) — 참조가
 * 유일하게 원본성을 보존하는 방법이다.
 *
 * 이 개발 환경은 서버·클라가 **같은 부모 디렉터리 밑의 형제 디렉터리**로 존재한다(worktree는
 * `.../Projects/.wt/<task>/`, 정본은 `.../Projects/application_server/` — 두 경우 모두 클라
 * 저장소 `rally`가 어딘가의 조상 디렉터리 밑에 형제로 있다). 그 사실 하나에만 기댄다 — 정확히
 * 몇 단계 위인지는 worktree 깊이에 따라 달라지므로, 고정 단계 수(`../../rally`처럼)로 하드코딩하지
 * 않고 `__dirname`에서부터 조상 디렉터리를 순회하며 `<조상>/rally/test/fixtures/...`가 실제로
 * 존재하는 첫 지점을 찾는다(아래 `locateGoldenVectorsFile`). `RALLY_CLIENT_REPO` 환경변수로
 * 재정의할 수 있다(다른 개발 환경·CI에서 배치가 다르면 이걸로 우회).
 *
 * **한계**: 이 방식은 "서버·클라가 같은 부모 밑의 형제"라는 이 프로젝트의 현재 로컬 개발 환경
 * 배치에 의존한다. 그 전제가 깨지는 환경(예: 완전히 분리된 CI 러너)에서는 `RALLY_CLIENT_REPO`를
 * 명시적으로 넘겨야 한다 — 넘기지 않으면 아래 "파일 없음" 경로를 탄다(조용히 통과하지 않는다,
 * 아래 참조).
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js` 직접 실행.
 *
 * 실행: node src/utils/recurrenceGoldenVectorRegression.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { expandOccurrences } = require('./recurrenceExpansion');

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond) {
  if (cond) pass++;
  else { fail++; failures.push(desc); }
}

// ── 골든 벡터 파일 위치 확인 — 조상 디렉터리를 순회하며 <조상>/rally/test/fixtures/... 를 찾는다.
// 필셋 상한(20)은 파일시스템 루트까지 순회를 보장하기 위한 안전판일 뿐 실제로는 훨씬 일찍 멈춘다
// (parent === dir이면 루트 도달로 즉시 중단).
function locateGoldenVectorsFile() {
  if (process.env.RALLY_CLIENT_REPO) {
    const overridden = path.join(process.env.RALLY_CLIENT_REPO, 'test/fixtures/recurrence_golden_vectors.json');
    if (fs.existsSync(overridden)) return overridden;
  }
  let dir = __dirname;
  for (let i = 0; i < 20; i++) {
    const candidate = path.join(dir, 'rally', 'test/fixtures/recurrence_golden_vectors.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break; // 파일시스템 루트 도달
    dir = parent;
  }
  return null;
}

// ── 비교 정밀도 규칙 ────────────────────────────────────────────────────────
// 양쪽(전개 결과·골든 벡터의 expectedOccurrences)을 전부 `new Date(...).getTime()`(epoch ms)으로
// 정규화해 집합 동등 비교한다 — 순서 무관(rule.all()이 항상 정렬해 내놓지만, 골든 벡터 쪽 순서까지
// 강제하지 않기 위해 Set으로 비교).
//
// scheduleKind별로 "다른 정밀도"를 명시적으로 적용하지는 않는다 — 대신 **어느 쪽도 날짜/시각
// 문자열을 자르지 않는다**는 단일 규칙을 둘 다에 적용한다:
//   - allDay: expandOccurrences가 반환하는 값 자체가 이미 UTC 자정(civil 변환 없음, 모듈 코멘트
//     참조)이고, 골든 벡터의 "YYYY-MM-DD" 문자열도 `new Date(...)`가 UTC 자정으로 파싱한다 —
//     그래서 day 단위 비교와 ms 단위(getTime) 비교가 애초에 값이 같아 동치다. 별도로 날짜만
//     잘라내는 정규화를 하지 않는다 — 자르면 안전한 게 아니라 불필요한 것이다(값 자체가 이미
//     자정이므로).
//   - timed: expandOccurrences가 civil-as-UTC → 실제 UTC instant로 되돌린 값을 반환하고, 골든
//     벡터의 ISO 문자열도 실제 UTC instant다 — 여기서 만약 "날짜까지만" 잘라 비교하면(팀장이
//     경고한 함정) DST 경계에서 실제 UTC 시각이 1시간 어긋나도 같은 날짜라 통과해버린다. 그래서
//     여기는 반드시 getTime()(ms 정밀도) 전체를 비교해야 한다 — 이 스위트는 둘 다 getTime()으로
//     비교하므로 이 함정을 원천적으로 피한다.
function occurrencesMatch(expandedDates, expectedIsoStrings) {
  const got = new Set(expandedDates.map((d) => d.getTime()));
  const expected = new Set(expectedIsoStrings.map((s) => new Date(s).getTime()));
  if (got.size !== expected.size) return false;
  for (const t of expected) {
    if (!got.has(t)) return false;
  }
  return true;
}

function expandVector(vector) {
  return expandOccurrences({
    // eventService.js/taskService.js가 검증에 실제로 넘기는 값은 클라가 제출한 r_rule이고,
    // 골든 벡터에서 그 필드에 대응하는 것은 sourceRRule이 아니라 expectedRRule이다(sourceRRule은
    // COUNT 기반 "저작 규칙", expectedRRule은 applyUntilDate가 적용된 뒤 클라가 실제로 서버에
    // 보내는 최종 규칙 — 예: vector event_all_day_daily_date_until의 sourceRRule은
    // FREQ=DAILY;COUNT=10이지만 expectedRRule은 FREQ=DAILY;UNTIL=20260103이고,
    // expectedOccurrences는 후자를 전개한 3건이다).
    rRule: vector.expectedRRule,
    isAllDay: vector.scheduleKind === 'allDay',
    recurrenceTimezone: vector.recurrenceTimezone,
    // eventService.createEvent의 dtstartInstant 선정 규칙(제출 인스턴스 중 가장 이른
    // original_date)과 동일 — 생성 시점엔 계열의 첫 회차가 곧 진짜 시작점이다. 골든 벡터의
    // seriesStart가 바로 그 값이다.
    dtstartInstant: new Date(vector.seriesStart),
  });
}

async function run() {
  const filePath = locateGoldenVectorsFile();

  if (!filePath) {
    // 조용히 통과시키지 않는다 — 파일을 못 찾으면 이 스위트가 지키려는 대조 자체가 아예 실행되지
    // 않은 것이므로, 그 사실을 exitCode=1과 큰 배너로 명시한다.
    console.error('\n' + '='.repeat(78));
    console.error('[recurrenceGoldenVectorRegression] 골든 벡터 파일을 찾지 못했다 — 검증을 건너뛴 게');
    console.error('아니라 실패로 처리한다. RALLY_CLIENT_REPO 환경변수로 클라 저장소 경로를 지정하거나,');
    console.error('이 서버 저장소(또는 worktree)가 rally 클라이언트 저장소와 같은 부모 디렉터리 밑');
    console.error('형제 디렉터리로 있는지 확인해라. 기대 상대 경로: <조상>/rally/test/fixtures/');
    console.error('recurrence_golden_vectors.json');
    console.error('='.repeat(78) + '\n');
    process.exitCode = 1;
    return;
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.vectors) || parsed.vectors.length === 0) {
    console.error(`[recurrenceGoldenVectorRegression] 골든 벡터 파일(${filePath})에 vectors 배열이 없거나 비었다.`);
    process.exitCode = 1;
    return;
  }

  console.log(`[recurrenceGoldenVectorRegression] 골든 벡터 로드: ${filePath} (${parsed.vectors.length}건)`);

  // ── 실 vector 전수 대조 ──────────────────────────────────────────────────
  const mismatches = [];
  for (const vector of parsed.vectors) {
    const expanded = expandVector(vector);
    const matched = occurrencesMatch(expanded, vector.expectedOccurrences);
    check(`골든 벡터 '${vector.id}' — 서버 전개가 expectedOccurrences와 일치`, matched);
    if (!matched) {
      mismatches.push({
        id: vector.id,
        expected: vector.expectedOccurrences,
        got: expanded.map((d) => d.toISOString()),
      });
    }
  }

  if (mismatches.length) {
    console.log('\n--- 클라·서버 불일치(고치지 않고 보고만) ---');
    mismatches.forEach((m) => {
      console.log(` - ${m.id}`);
      console.log(`   expected: ${JSON.stringify(m.expected)}`);
      console.log(`   got:      ${JSON.stringify(m.got)}`);
    });
  }

  // ── 자가검증 — 비교 함수 자체가 실제로 불일치를 잡는지, 골든 벡터를 메모리에서만 훼손해 확인.
  //    원본 파일은 절대 건드리지 않는다(diff 없음 — 아래서 fs 쓰기를 전혀 하지 않는다).
  {
    const sample = parsed.vectors[0];
    const corrupted = [...sample.expectedOccurrences];
    // 마지막 회차를 하루 뒤로 밀어 규칙과 안 맞는 값으로 훼손 — allDay/timed 어느 쪽 포맷이든
    // ISO 문자열이라 Date 산술로 안전하게 하루를 더할 수 있다.
    const last = new Date(corrupted[corrupted.length - 1]);
    last.setUTCDate(last.getUTCDate() + 1);
    corrupted[corrupted.length - 1] = last.toISOString().slice(0, sample.expectedOccurrences[corrupted.length - 1].length);

    const expanded = expandVector(sample);
    const shouldFail = occurrencesMatch(expanded, corrupted);
    check(
      `자가검증 — '${sample.id}'의 expectedOccurrences를 메모리에서 훼손하면 대조가 실패로 뒤집힌다`,
      shouldFail === false
    );
  }

  console.log(`\n[recurrenceGoldenVectorRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[recurrenceGoldenVectorRegression] 실행 실패:', error);
  process.exitCode = 1;
});
