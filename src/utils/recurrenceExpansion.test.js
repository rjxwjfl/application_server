/**
 * src/utils/recurrenceExpansion.test.js
 * =========================================
 * RLY-20260806-037 회귀 스위트 — system.md §4-7 "서버가 클라 제출 회차 집합을 r_rule로
 * 독립 전개해 대조한다"의 핵심 단위(recurrenceExpansion.js)를 직접 검증한다.
 *
 * 순수 함수 단위 테스트라 mock DB가 필요 없다 — `expandOccurrences`/`assertOccurrencesMatchRule`을
 * 직접 호출한다. 서비스 레이어 배선(EventService.createEvent 등)은
 * `src/services/reminderGenerationRegression.test.js`(생성 경로)·
 * `src/services/recurrenceScopeRegression.test.js`(범위 편집 경로)에서 함께 검증한다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js` 직접 실행.
 *
 * 실행: node src/utils/recurrenceExpansion.test.js
 */

const assert = require('assert');
const { expandOccurrences, assertOccurrencesMatchRule } = require('./recurrenceExpansion');

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond) {
  if (cond) pass++;
  else { fail++; failures.push(desc); }
}
function expectThrows(desc, fn, statusCode, errorCode) {
  try {
    fn();
    fail++;
    failures.push(`${desc}: 에러를 기대했지만 통과함`);
  } catch (err) {
    check(`${desc} (statusCode)`, err.statusCode === statusCode);
    check(`${desc} (errorCode)`, err.errorCode === errorCode);
  }
}
function expectOk(desc, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    fail++;
    failures.push(`${desc}: 정상 통과를 기대했지만 에러 — ${err.message}`);
  }
}

// ① 규칙과 일치하는 회차는 통과한다.
{
  const dtstart = new Date('2026-09-01T09:00:00Z'); // 화요일
  const submitted = [
    { original_date: '2026-09-01T09:00:00Z' },
    { original_date: '2026-09-08T09:00:00Z' },
    { original_date: '2026-09-15T09:00:00Z' },
  ];
  expectOk('① 규칙과 일치하는 회차 3개(FREQ=WEEKLY;COUNT=3) 통과', () => assertOccurrencesMatchRule({
    rRule: 'FREQ=WEEKLY;COUNT=3',
    isAllDay: false,
    recurrenceTimezone: 'Asia/Seoul',
    dtstartInstant: dtstart,
    submittedInstances: submitted,
  }));
}

// ② 규칙 밖 회차가 섞이면 422 OCCURRENCE_INVALID.
{
  const dtstart = new Date('2026-09-01T09:00:00Z');
  const submitted = [
    { original_date: '2026-09-01T09:00:00Z' },
    { original_date: '2026-09-08T09:00:00Z' },
    { original_date: '2026-09-10T09:00:00Z' }, // 규칙(매주 화)과 무관한 날짜
  ];
  expectThrows('② 규칙 밖 회차가 섞인 제출 → 422 OCCURRENCE_INVALID', () => assertOccurrencesMatchRule({
    rRule: 'FREQ=WEEKLY;COUNT=3',
    isAllDay: false,
    recurrenceTimezone: 'Asia/Seoul',
    dtstartInstant: dtstart,
    submittedInstances: submitted,
  }), 422, 'OCCURRENCE_INVALID');
}

// ③ 개수만 다른 경우(전부 규칙 안의 유효한 날짜라도 부분집합/초과집합)도 422.
{
  const dtstart = new Date('2026-09-01T09:00:00Z');
  const submittedTooFew = [
    { original_date: '2026-09-01T09:00:00Z' },
    { original_date: '2026-09-08T09:00:00Z' },
    // 세 번째(9/15) 누락 — 개수 불일치
  ];
  expectThrows('③ 개수 부족(2/3) → 422 OCCURRENCE_INVALID', () => assertOccurrencesMatchRule({
    rRule: 'FREQ=WEEKLY;COUNT=3',
    isAllDay: false,
    recurrenceTimezone: 'Asia/Seoul',
    dtstartInstant: dtstart,
    submittedInstances: submittedTooFew,
  }), 422, 'OCCURRENCE_INVALID');
}

// ④ 대조는 recurrence_timezone 기준이다 — 서버 프로세스 로케일(TZ 환경변수)과 무관해야 한다.
// process.env.TZ를 바꿔가며 같은 입력이 같은 결과를 내는지 직접 확인한다.
{
  const dtstart = new Date('2026-03-01T15:00:00Z'); // America/New_York 기준 3/1 10:00 EST(DST 이전)
  const submitted = [
    { original_date: '2026-03-01T15:00:00Z' },
    { original_date: '2026-03-08T15:00:00Z' }, // DST 전환(3/8) 이후 — 벽시계 10:00 유지하려면 UTC로는 14:00
  ];
  // 잘못 넣으면(civil-as-UTC 변환 없이 순수 UTC 산술) 3/8도 15:00Z가 나와야 통과하는데,
  // 실제로는 EDT 전환으로 14:00Z가 "벽시계 10시"다 — 즉 이 테스트는 위 ①에 이미 내재된
  // civil-as-UTC 로직이 실제로 작동하는지를 별도로 재확인한다.
  const correctSubmitted = [
    { original_date: '2026-03-01T15:00:00Z' },
    { original_date: '2026-03-08T14:00:00Z' }, // DST 이후 벽시계 10:00 EDT = 14:00Z
  ];

  const savedTz = process.env.TZ;
  for (const serverTz of ['UTC', 'America/Los_Angeles', 'Asia/Seoul']) {
    process.env.TZ = serverTz;
    expectThrows(
      `④[서버TZ=${serverTz}] DST 미보정 시각(순수 UTC 산술)이 섞이면 422`,
      () => assertOccurrencesMatchRule({
        rRule: 'FREQ=WEEKLY;COUNT=2',
        isAllDay: false,
        recurrenceTimezone: 'America/New_York',
        dtstartInstant: dtstart,
        submittedInstances: submitted,
      }),
      422, 'OCCURRENCE_INVALID'
    );
    expectOk(
      `④[서버TZ=${serverTz}] recurrence_timezone 기준으로 DST 보정된 회차는 통과(서버 로케일 무관)`,
      () => assertOccurrencesMatchRule({
        rRule: 'FREQ=WEEKLY;COUNT=2',
        isAllDay: false,
        recurrenceTimezone: 'America/New_York',
        dtstartInstant: dtstart,
        submittedInstances: correctSubmitted,
      })
    );
  }
  process.env.TZ = savedTz;
}

// ⑤ UNTIL 규칙도 COUNT 규칙과 동일하게 통과한다(034가 UNTIL을 지원하지 않는다고 명시했으므로
//   037의 검증이 UNTIL 규칙 자체를 거부하면 안 된다).
{
  const dtstart = new Date('2026-09-01T00:00:00Z');
  const submitted = [
    { original_date: '2026-09-01T00:00:00Z' },
    { original_date: '2026-09-02T00:00:00Z' },
    { original_date: '2026-09-03T00:00:00Z' },
  ];
  expectOk('⑤ UNTIL 규칙(FREQ=DAILY;UNTIL=20260903) 통과', () => assertOccurrencesMatchRule({
    rRule: 'FREQ=DAILY;UNTIL=20260903',
    isAllDay: true,
    recurrenceTimezone: null,
    dtstartInstant: dtstart,
    submittedInstances: submitted,
  }));
}

// ⑥ 월말 케이스 — 표준(RFC 5545)대로 그 달을 건너뛴 집합이 통과한다. 표준은 BYMONTHDAY=31이
//   없는 달(2월 등)을 클램핑하지 않고 스킵한다(User 판정 037 — 클라가 이 표준에 맞춰 정렬될
//   예정. 이 서버 검증은 클라의 구 클램핑 동작을 흉내내지 않는다).
{
  const dtstart = new Date('2026-01-31T00:00:00Z');
  // 표준 전개: 1/31, 3/31, 5/31 (2월·4월은 31일이 없어 스킵)
  const standardSubmitted = [
    { original_date: '2026-01-31T00:00:00Z' },
    { original_date: '2026-03-31T00:00:00Z' },
    { original_date: '2026-05-31T00:00:00Z' },
  ];
  expectOk('⑥ 월말(BYMONTHDAY=31) 표준대로 건너뛴 집합(1월→3월→5월) 통과', () => assertOccurrencesMatchRule({
    rRule: 'FREQ=MONTHLY;BYMONTHDAY=31;COUNT=3',
    isAllDay: true,
    recurrenceTimezone: null,
    dtstartInstant: dtstart,
    submittedInstances: standardSubmitted,
  }));

  // 구 클라 클램핑 방식(2월 말일로 당김)은 표준과 달라 거부돼야 한다 — 이게 이번 판정의 본체다.
  const clampedSubmitted = [
    { original_date: '2026-01-31T00:00:00Z' },
    { original_date: '2026-02-28T00:00:00Z' }, // 클램핑(구 클라 동작) — 표준 전개엔 없는 날짜
    { original_date: '2026-03-31T00:00:00Z' },
  ];
  expectThrows('⑥ 구 클램핑(2월 말일 당김) 집합은 표준과 달라 422로 거부', () => assertOccurrencesMatchRule({
    rRule: 'FREQ=MONTHLY;BYMONTHDAY=31;COUNT=3',
    isAllDay: true,
    recurrenceTimezone: null,
    dtstartInstant: dtstart,
    submittedInstances: clampedSubmitted,
  }), 422, 'OCCURRENCE_INVALID');
}

// ⑦ 비반복(r_rule 없음)은 그대로 단일 회차만 허용 — 회차가 여럿이면 대조 없이도 잡혀야 한다
//   (r_rule=null이면 회차 1건짜리 one-off라는 system.md 계약의 자연스러운 부산물).
{
  expectOk('⑦ r_rule 없음 + 인스턴스 1개 → 통과', () => assertOccurrencesMatchRule({
    rRule: null,
    isAllDay: false,
    recurrenceTimezone: null,
    dtstartInstant: new Date('2026-09-01T00:00:00Z'),
    submittedInstances: [{ original_date: '2026-09-01T00:00:00Z' }],
  }));
  expectThrows('⑦ r_rule 없음 + 인스턴스 2개 → 422(one-off인데 회차가 여럿)', () => assertOccurrencesMatchRule({
    rRule: null,
    isAllDay: false,
    recurrenceTimezone: null,
    dtstartInstant: new Date('2026-09-01T00:00:00Z'),
    submittedInstances: [
      { original_date: '2026-09-01T00:00:00Z' },
      { original_date: '2026-09-02T00:00:00Z' },
    ],
  }), 422, 'OCCURRENCE_INVALID');
}

// ⑧ 365 상한과는 독립 — expandOccurrences 자체도 방어적으로 자른다(무한 반복 방지 안전판,
//   034의 365 cap 검사와 별개 경로 — 이 모듈은 그 검사를 대체하지 않는다).
{
  const occ = expandOccurrences({
    rRule: 'FREQ=DAILY', // COUNT·UNTIL 없음 — 무제한
    isAllDay: true,
    recurrenceTimezone: null,
    dtstartInstant: new Date('2026-01-01T00:00:00Z'),
  });
  check('⑧ COUNT/UNTIL 없는 규칙도 365개로 잘림(무한 전개 방지)', occ.length === 365);
}

console.log(`\n[recurrenceExpansion] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
if (failures.length) {
  console.log('--- 실패 목록 ---');
  failures.forEach((f) => console.log(' - ' + f));
  process.exitCode = 1;
}
