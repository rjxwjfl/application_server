/**
 * src/utils/recurrenceRuleUntilRegression.test.js
 * =========================================
 * RLY-20260806-061 — `adjustRuleCount`가 COUNT 계열만 다루고 UNTIL 계열은 그대로 두던 결함의
 * 회귀. 결함 설명은 `recurrenceRule.js` 모듈 헤더 참조.
 *
 * 이 저장소엔 테스트 프레임워크가 없다 — plain assert + `node <file>.js` 직접 실행.
 * DB 접근이 필요 없는 순수 함수만 다룬다(recurrenceRule.js·recurrenceExpansion.js).
 *
 * 실행: node src/utils/recurrenceRuleUntilRegression.test.js
 */

const assert = require('assert');
const { adjustRuleCount, formatUntilValue } = require('./recurrenceRule');
const { expandOccurrences, assertOccurrencesMatchRule } = require('./recurrenceExpansion');

let pass = 0;
let fail = 0;
const failures = [];

function check(desc, cond) {
  if (cond) pass++;
  else { fail++; failures.push(desc); }
}

function throws(desc, fn, matcher) {
  try {
    fn();
    fail++;
    failures.push(`${desc}: 예외를 기대했지만 통과함`);
  } catch (err) {
    if (matcher(err)) pass++;
    else { fail++; failures.push(`${desc}: 예외는 났지만 조건 불일치 — ${err.message}`); }
  }
}

function notThrows(desc, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    fail++;
    failures.push(`${desc}: 통과를 기대했지만 예외 — ${err.statusCode || ''} ${err.message}`);
  }
}

const D = (day, hour = 9) => new Date(Date.UTC(2026, 8, day, hour, 0, 0)); // 2026-09-{day}

// ════════════════════════════════════════════════════════════════════════
// ① 재현 — UNTIL 규칙을 this_and_future로 자른 뒤, 원본을 다시 편집하면 422가 난다
//    (수리 전 동작 — adjustRuleCount에 UNTIL 컨텍스트를 안 주면 여전히 이 경로를 탄다).
// ════════════════════════════════════════════════════════════════════════
(function reproduceBug() {
  const dtstart = D(1);
  const origRule = 'FREQ=DAILY;UNTIL=20261231T000000Z'; // 원본은 연말까지 무제한처럼 넓다.

  const full = expandOccurrences({ rRule: origRule, isAllDay: false, recurrenceTimezone: 'Asia/Seoul', dtstartInstant: dtstart });
  const boundary = full[9]; // 10번째 회차(0-index 9)부터 fork로 분리한다고 가정.
  const remaining = full.filter((d) => d < boundary);
  assert.strictEqual(remaining.length, 9, '테스트 전제 확인 — 경계 이전에 9개가 남아야 함');

  // 컨텍스트 없이 호출 — 수리 전 시그니처와 동치(3번째 인자 없음).
  const unadjusted = adjustRuleCount(origRule, remaining.length);
  check('① 컨텍스트 없이 호출하면 UNTIL 규칙은 조정되지 않는다(옛 동작과 동치)', unadjusted === origRule);

  const submittedInstances = remaining.map((d) => ({ original_date: d.toISOString() }));
  throws(
    '① 조정 안 된 옛 UNTIL로 다음 편집을 검증하면 422 OCCURRENCE_INVALID(재현)',
    () => assertOccurrencesMatchRule({
      rRule: unadjusted, isAllDay: false, recurrenceTimezone: 'Asia/Seoul', dtstartInstant: dtstart, submittedInstances,
    }),
    (err) => err.statusCode === 422 && err.errorCode === 'OCCURRENCE_INVALID'
  );

  // ════════════════════════════════════════════════════════════════════
  // ② 수리 — 컨텍스트를 주면 UNTIL이 실제 마지막 회차로 재계산되고, 다음 편집이 통과한다.
  // ════════════════════════════════════════════════════════════════════
  const adjusted = adjustRuleCount(origRule, remaining.length, {
    isAllDay: false, recurrenceTimezone: 'Asia/Seoul', dtstartInstant: dtstart,
  });
  check('② 컨텍스트를 주면 UNTIL이 바뀐다', adjusted !== origRule);
  check('② 새 UNTIL이 실제 9번째 회차(remaining의 마지막)와 같은 날짜', adjusted.includes(formatUntilValue(remaining[remaining.length - 1], false)));

  notThrows(
    '② 수리된 UNTIL로 같은 회차 집합을 검증하면 더 이상 422가 나지 않는다',
    () => assertOccurrencesMatchRule({
      rRule: adjusted, isAllDay: false, recurrenceTimezone: 'Asia/Seoul', dtstartInstant: dtstart, submittedInstances,
    })
  );

  // r_rule과 실제 회차 집합이 정확히 일치하는지(AC) — 재전개해서 개수·값 전부 대조.
  const reExpanded = expandOccurrences({ rRule: adjusted, isAllDay: false, recurrenceTimezone: 'Asia/Seoul', dtstartInstant: dtstart });
  check('② 재전개 결과 개수가 remainingCount와 정확히 일치', reExpanded.length === remaining.length);
  check(
    '② 재전개 결과가 실제 남은 회차 집합과 시각까지 정확히 일치',
    reExpanded.every((d, i) => d.getTime() === remaining[i].getTime())
  );
})();

// ════════════════════════════════════════════════════════════════════════
// ③ COUNT 경로 — 기존 동작 불변(회귀 고정)
// ════════════════════════════════════════════════════════════════════════
check('③ COUNT 규칙 — 텍스트 치환만(컨텍스트 없이도 동작)', adjustRuleCount('FREQ=DAILY;COUNT=10', 4) === 'FREQ=DAILY;COUNT=4');
check('③ COUNT 규칙 — 다른 필드가 있어도 COUNT만 치환', adjustRuleCount('FREQ=WEEKLY;BYDAY=MO;COUNT=8', 3) === 'FREQ=WEEKLY;BYDAY=MO;COUNT=3');
check('③ COUNT 규칙 — remainingCount가 0이면 COUNT=0', adjustRuleCount('FREQ=DAILY;COUNT=10', 0) === 'FREQ=DAILY;COUNT=0');
check('③ COUNT 규칙 — 컨텍스트를 줘도(무시) 결과 동일', adjustRuleCount('FREQ=DAILY;COUNT=10', 4, { isAllDay: false, recurrenceTimezone: 'UTC', dtstartInstant: D(1) }) === 'FREQ=DAILY;COUNT=4');

// ════════════════════════════════════════════════════════════════════════
// ④ UNTIL + remainingCount=0 — COUNT=0으로 명확히 표현(모호한 UNTIL을 지어내지 않는다)
// ════════════════════════════════════════════════════════════════════════
check(
  '④ UNTIL 규칙 + remainingCount=0 — 컨텍스트 없이도 COUNT=0으로 바뀐다',
  adjustRuleCount('FREQ=DAILY;UNTIL=20261231T000000Z', 0) === 'FREQ=DAILY;COUNT=0'
);
check(
  '④ UNTIL 규칙 + remainingCount=0 — 컨텍스트가 있어도 동일(0은 특수 케이스)',
  adjustRuleCount('FREQ=DAILY;UNTIL=20261231T000000Z', 0, { isAllDay: false, recurrenceTimezone: 'UTC', dtstartInstant: D(1) }) === 'FREQ=DAILY;COUNT=0'
);

// ════════════════════════════════════════════════════════════════════════
// ⑤ COUNT도 UNTIL도 없는 무제한 규칙 — 손대지 않는다(상한 365 계약상 존재하면 안 되지만 방어적으로)
// ════════════════════════════════════════════════════════════════════════
check('⑤ 무제한 규칙(COUNT·UNTIL 둘 다 없음) — 그대로 통과', adjustRuleCount('FREQ=DAILY', 4) === 'FREQ=DAILY');
check('⑤ 무제한 규칙 — 컨텍스트를 줘도 그대로 통과', adjustRuleCount('FREQ=DAILY', 4, { isAllDay: false, recurrenceTimezone: 'UTC', dtstartInstant: D(1) }) === 'FREQ=DAILY');

// ════════════════════════════════════════════════════════════════════════
// ⑥ null/빈 규칙 — 그대로 통과(기존 가드 불변)
// ════════════════════════════════════════════════════════════════════════
check('⑥ null r_rule — 그대로 null', adjustRuleCount(null, 4) === null);

// ════════════════════════════════════════════════════════════════════════
// ⑦ all-day UNTIL — YYYYMMDD로만 인코딩(시:분:초 없음), 클라 rrule_format.dart와 동일 형태
// ════════════════════════════════════════════════════════════════════════
(function allDayCase() {
  const dtstart = new Date(Date.UTC(2026, 8, 1)); // all-day는 UTC 자정 표현.
  const origRule = 'FREQ=DAILY;UNTIL=20261231';
  const adjusted = adjustRuleCount(origRule, 3, { isAllDay: true, recurrenceTimezone: null, dtstartInstant: dtstart });
  check('⑦ all-day UNTIL — YYYYMMDD 형식(T·Z 없음)', /UNTIL=\d{8}$/.test(adjusted));
  check('⑦ all-day UNTIL — 3번째 날짜(9/3)로 계산됨', adjusted === 'FREQ=DAILY;UNTIL=20260903');
})();

// ════════════════════════════════════════════════════════════════════════
// ⑧ 방어적 폴백 — 독립 전개 결과가 remainingCount보다 적으면(데이터 불일치 신호) 원본 유지
// ════════════════════════════════════════════════════════════════════════
check(
  '⑧ 전개 결과 < remainingCount — 원본을 임의로 지어내지 않고 그대로 둔다',
  adjustRuleCount('FREQ=DAILY;UNTIL=20260903T090000Z', 100, { isAllDay: false, recurrenceTimezone: 'UTC', dtstartInstant: D(1) })
    === 'FREQ=DAILY;UNTIL=20260903T090000Z'
);

console.log(`\n[recurrenceRuleUntilRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
if (failures.length) {
  console.log('--- 실패 목록 ---');
  failures.forEach((f) => console.log(' - ' + f));
  process.exitCode = 1;
}
