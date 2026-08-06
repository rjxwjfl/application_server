/**
 * src/utils/recurrenceRule.js
 * =========================================
 * RLY-20260806-034 — 범위 편집(fork)의 "구간은 서로소다" 요건(domain.md §3-13) 구현.
 *
 * 원본 이벤트/태스크가 fork로 분리된 뒤, 원본에 남은(경계 이전) 회차 수로 원본의 r_rule을
 * 조정해 "원본의 r_rule이 실제로 남은 회차 수보다 많은 회차를 약속하는" 불일치를 막는다.
 *
 * RLY-20260806-061 — COUNT 계열만 다루던 것을 UNTIL 계열까지 확장한다. 결함이었다:
 * `COUNT=` 텍스트 치환만 했고, 원본이 UNTIL만 쓰면 아무 것도 조정하지 않았다 — 원본의
 * r_rule은 옛 UNTIL을 그대로 유지한 채 실제 인스턴스 수만 줄어, 다음 번 그 계열을 편집할 때
 * RLY-20260806-037의 독립 전개 대조(`assertOccurrencesMatchRule`)가 "규칙이 약속하는 회차 수
 * (옛 UNTIL 기준, 많음)"와 "실제 제출된 회차 수(적음)"의 불일치로 422 OCCURRENCE_INVALID를
 * 던진다 — 서버가 자기 자신이 만든 데이터를 거부한다(재현·근거는 구현 보고서 참조).
 *
 * UNTIL 조정은 **새 전개 코드를 만들지 않는다** — `recurrenceExpansion.js`(037)의
 * `expandOccurrences`를 그대로 재사용해 원본 r_rule을 독립 전개하고, 남아야 할 개수만큼의
 * 마지막 회차를 새 UNTIL로 쓴다. 이렇게 하면 이 함수도, `assertOccurrencesMatchRule`도
 * 같은 전개 로직을 신뢰하므로 "이 함수가 계산한 값"과 "다음 편집 때 서버가 검증하는 값"이
 * 항상 같은 알고리즘에서 나온다(불일치 재발 방지).
 *
 * 이 저장소에는 `rrule`(037이 들인 npm 의존성) 외 RRULE 전개 라이브러리가 없고, 새 의존성을
 * 추가하지 않는다(User 승인 없이 금지) — `expandOccurrences`가 내부적으로 `rrule`을 쓴다.
 */

const { expandOccurrences } = require('./recurrenceExpansion');

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

/**
 * 실제 UTC instant(expandOccurrences가 반환하는 Date)를 RFC 5545 UNTIL 값으로 인코딩한다.
 * all-day는 순수 달력 날짜(`YYYYMMDD`, expandOccurrences가 UTC 자정으로 통일해 반환한 값을
 * 그대로 UTC 필드로 읽으면 된다) — 클라(`rrule_format.dart:applyRRuleUntil`)의 all-day 인코딩과
 * 동일 형태. timed는 `YYYYMMDDTHHMMSSZ`(리터럴 UTC instant) — `expandOccurrences`가 이미
 * civil-as-UTC 왕복 변환을 마치고 돌려준 진짜 UTC instant이므로, 그 UTC 필드를 그대로
 * 포맷하면 된다(추가 시간대 변환이 필요 없다) — 클라의 `.toUtc()` 직렬화와 동일 형태.
 * @param {Date} date
 * @param {boolean} isAllDay
 * @returns {string}
 */
function formatUntilValue(date, isAllDay) {
  const y = date.getUTCFullYear();
  const mo = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  if (isAllDay) return `${y}${mo}${d}`;
  const h = pad(date.getUTCHours());
  const mi = pad(date.getUTCMinutes());
  const s = pad(date.getUTCSeconds());
  return `${y}${mo}${d}T${h}${mi}${s}Z`;
}

/**
 * r_rule 문자열을 remainingCount에 맞게 조정한다 — COUNT 계열은 토큰 치환(기존 동작
 * 그대로, 불변), UNTIL 계열은 독립 전개로 실제 마지막 회차를 찾아 그 날짜로 UNTIL을
 * 다시 쓴다. 둘 다 없는 무제한 규칙(상한 365 계약상 존재하면 안 되지만 방어적으로)은
 * 손대지 않는다.
 *
 * @param {string|null} rRule
 * @param {number} remainingCount - 0 이상. 0이면 이 조각에 더 이상 회차가 없다는 뜻이지만
 *   r_rule 자체를 지우지는 않는다(이벤트/태스크 행 자체를 삭제하는 것은 이 함수의 책임이 아니다).
 *   COUNT·UNTIL 둘 다 명확히 "0개"를 표현할 방법이 없는 건 UNTIL뿐이라(UNTIL이 DTSTART보다
 *   앞이어도 되지만 애매하다) 0이면 UNTIL이었더라도 COUNT=0으로 바꾼다 — 의미가 모호하지 않다.
 * @param {object} [expansionContext] - UNTIL 조정에만 필요하다(COUNT 경로는 안 쓴다).
 *   remainingCount > 0인 UNTIL 규칙을 조정하려는데 이 인자가 없으면(호출부가 안 넘겼거나
 *   컨텍스트를 못 구했으면) 안전하게 원본을 그대로 둔다 — 잘못된 UNTIL을 쓰느니 조정하지
 *   않는 편이 낫다(호출부가 그 경우를 로그로 남기는 건 이 함수의 책임 밖).
 * @param {boolean} expansionContext.isAllDay
 * @param {string|null} expansionContext.recurrenceTimezone
 * @param {Date|string} expansionContext.dtstartInstant - 원본 계열의 진짜 시작점(fork로
 *   새로 만든 조각의 시작점이 아니다 — 원본은 fork 이후에도 자기 자신의 원래 시작점을
 *   그대로 쓴다. 호출부가 findEarliestActiveInstance로 구한다).
 * @returns {string|null}
 */
function adjustRuleCount(rRule, remainingCount, expansionContext) {
  if (!rRule) return rRule;
  const safeCount = Math.max(0, Math.trunc(remainingCount));

  if (/COUNT=\d+/.test(rRule)) {
    // 기존 동작 그대로 — 불변(RLY-20260806-061 AC: "COUNT 경로 기존 동작을 바꾸지 마라").
    return rRule.replace(/COUNT=\d+/, `COUNT=${safeCount}`);
  }

  if (!/UNTIL=/.test(rRule)) {
    // COUNT도 UNTIL도 없는 무제한 규칙 — 자르기가 의미를 가지려면 새 UNTIL/COUNT를 지어내야
    // 하는데 그럴 근거(원래 의도한 종료 조건)가 없다. 상한 365 계약상 이런 규칙이 저장돼
    // 있으면 안 되지만(모듈 헤더 참조), 방어적으로 그대로 통과시킨다 — 여기서 실패시키면
    // fork 자체가 막혀 더 나쁘다.
    return rRule;
  }

  // UNTIL 계열.
  if (safeCount === 0) {
    // "0개 남음"을 UNTIL로 모호함 없이 표현할 방법이 없다 — COUNT=0으로 바꾼다(기존
    // COUNT 경로가 이미 이 값을 쓰는 것과 같은 의미: "이 규칙은 더 이상 회차를 갖지 않는다").
    return rRule.replace(/UNTIL=[^;]+/, 'COUNT=0');
  }

  if (!expansionContext) return rRule;
  const { isAllDay, recurrenceTimezone, dtstartInstant } = expansionContext;
  if (dtstartInstant === undefined || dtstartInstant === null) return rRule;

  const occurrences = expandOccurrences({ rRule, isAllDay, recurrenceTimezone, dtstartInstant });
  if (occurrences.length < safeCount) {
    // 독립 전개 결과가 DB의 remainingCount보다 적다 — 둘이 어긋난다는 신호다. 여기서
    // 임의의 UNTIL을 지어내지 않고 원본을 그대로 둔다(호출부가 이미 이 값을 DB round-trip
    // 검증에 쓰지 않으므로 조용한 실패보다 "조정 안 됨"이 안전하다).
    return rRule;
  }

  const cutoff = occurrences[safeCount - 1];
  const newUntil = formatUntilValue(cutoff, !!isAllDay);
  return rRule.replace(/UNTIL=[^;]+/, `UNTIL=${newUntil}`);
}

module.exports = { adjustRuleCount, formatUntilValue };
