/**
 * src/utils/recurrenceExpansion.js
 * =========================================
 * RLY-20260806-037 — system.md §4-7: "클라이언트가 회차를 계산해 제출하고 서버는 그 집합을
 * r_rule로 독립 전개해 대조한다 — 대조하지 않으면 규칙과 무관한 회차를 임의로 주입할 수 있다."
 *
 * **라이브러리 판정(User, 037)**: `rrule`(npm, 2.8.1 고정) — RFC 5545 rrule 구현의 사실상
 * 표준. **"RFC 5545 표준 동작이 기준이다. 서버는 표준 라이브러리로 전개한다."** 클라
 * (`lib/core/utils/rrule_format.dart`)의 월말 BYMONTHDAY 클램핑 등 RFC 5545과 다른 커스텀
 * 로직은 이 모듈이 흉내내지 않는다 — **클라가 표준에 맞춰 별도 Task로 정렬된다.** 그래서
 * 이 검증은 **클라 정렬 Task와 함께 병합해야 한다** — 먼저 병합하면 월말 반복 생성이 전부
 * 422로 거부된다(구현보고서 참조).
 *
 * **시간대 처리(User 판정 ③, system.md §440 근거)**: 대조는 recurrence_timezone 기준이며
 * 서버 로케일에 의존하지 않는다. "civil-as-UTC" 기법을 쓴다 — recurrence_timezone의 벽시계
 * 시각을 그대로 UTC로 취급해 rrule 라이브러리에 넘기고(라이브러리 자체는 IANA 시간대를 모르고
 * DST 경계를 인식 못 한다), 결과를 다시 그 시간대의 벽시계로 해석해 실제 UTC instant로
 * 되돌린다. `lib/core/utils/rrule_format.dart`의 `_asUtcWithSameFields`/`_asLocalWithSameFields`
 * (timed 분기)와 같은 기법이며, `src/utils/localTime.js`(RLY-20260806-026/032가 이미 만든
 * 재사용 유틸, Intl.DateTimeFormat 기반 — 새 시간대 의존성 없음)를 그대로 쓴다.
 *
 * all-day 규칙은 시간대 변환이 없다(system.md §4-3 "all-day 규칙의 RRULE·UNTIL은 DATE로
 * 인코딩") — 순수 달력 날짜(UTC 자정 표현)로만 다룬다.
 *
 * **DTSTART는 반드시 "그 반복의 진짜 시작점"이어야 한다** — INTERVAL>1인 규칙(예:
 * "2주마다")은 DTSTART의 정확한 날짜가 반복 위상(어느 주가 포함되는지)을 결정한다. 회차
 * 중간의 아무 날짜나 넣으면 위상이 틀어져 정상 회차도 불일치로 잡힐 수 있다. 호출부
 * (eventService.js/taskService.js)가 올바른 DTSTART를 골라야 한다 — 이 모듈은 검증하지 않는다.
 */

const { RRule } = require('rrule');
const { localDateParts, localWallClockToUtc } = require('./localTime');
const { UnprocessableEntityError } = require('../core/errors');

// system.md §4-7·domain.md §3-13 — 회차 상한 365와 동일. 무한 반복 방지 안전판(rrule 라이브러리가
// COUNT/UNTIL 없는 규칙을 무한 전개하지 않도록 항상 이 값으로 자른다).
const MAX_EXPAND_COUNT = 365;

// 실제 UTC instant → "civil-as-UTC" Date(그 시간대 벽시계 숫자를 그대로 UTC로 취급한 값).
function toCivilAsUtc(instant, timeZone) {
  const p = localDateParts(instant, timeZone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));
}

// "civil-as-UTC" Date(벽시계 숫자) → 그 시간대에서의 실제 UTC instant.
// localWallClockToUtc는 초 단위를 받지 않는다(초=0 취급) — localTime.js의 기존 관례(리마인더·
// 기념일 09:00 계산)를 그대로 따른다. 반복 앵커의 초 단위 정밀도는 이 저장소의 다른 시간대
// 변환 경로도 요구하지 않는다.
function civilAsUtcToInstant(civilAsUtc, timeZone) {
  return localWallClockToUtc(
    civilAsUtc.getUTCFullYear(), civilAsUtc.getUTCMonth() + 1, civilAsUtc.getUTCDate(),
    civilAsUtc.getUTCHours(), civilAsUtc.getUTCMinutes(), timeZone
  );
}

/**
 * r_rule을 독립 전개한다.
 *
 * @param {object} p
 * @param {string|null} p.rRule - "FREQ=..." 또는 "RRULE:FREQ=..." (접두어 있어도/없어도 무방).
 *   null/undefined면 비반복(one-off) — dtstart 하나짜리 배열을 반환한다.
 * @param {boolean} p.isAllDay
 * @param {string|null} p.recurrenceTimezone - IANA TZID. all-day면 무시(전부 UTC 자정 취급).
 * @param {Date|string} p.dtstartInstant - 그 반복의 진짜 시작점(실제 UTC instant).
 * @param {number} [p.maxCount]
 * @returns {Date[]} 실제 UTC instant 배열(전개된 회차, 시각 순 정렬)
 */
function expandOccurrences({ rRule, isAllDay, recurrenceTimezone, dtstartInstant, maxCount = MAX_EXPAND_COUNT }) {
  const dtstartDate = dtstartInstant instanceof Date ? dtstartInstant : new Date(dtstartInstant);

  if (!rRule) return [dtstartDate];

  const ruleText = rRule.startsWith('RRULE:') ? rRule.slice(6) : rRule;
  const opts = RRule.parseString(ruleText);

  if (isAllDay) {
    // 순수 달력 날짜 — UTC 자정으로 표준화. UNTIL도 RRule.parseString이 bare YYYYMMDD를
    // 이미 UTC 자정 Date로 파싱해 두므로 추가 변환이 필요 없다.
    opts.dtstart = new Date(Date.UTC(
      dtstartDate.getUTCFullYear(), dtstartDate.getUTCMonth(), dtstartDate.getUTCDate()
    ));
  } else {
    const tz = recurrenceTimezone || 'UTC';
    opts.dtstart = toCivilAsUtc(dtstartDate, tz);
    if (opts.until) {
      opts.until = toCivilAsUtc(opts.until, tz);
    }
  }

  const rule = new RRule(opts);
  const occurrences = rule.all((_date, i) => i < maxCount);

  if (isAllDay) return occurrences;
  const tz = recurrenceTimezone || 'UTC';
  return occurrences.map((civil) => civilAsUtcToInstant(civil, tz));
}

/**
 * 클라가 제출한 회차 집합이 독립 전개 결과와 정확히 일치하는지 검증한다. 불일치 시
 * 422 OCCURRENCE_INVALID(system.md §4-7·api.md·transport.md — SC-event.md:621의 400은 낡은
 * 문면, 별건 문서 정정 대상)로 거부한다.
 *
 * 비교 단위: **`original_date`** — design_intent.md("typed schedule 전환 전까지는 fork 경계
 * 비교의 과도기 기준")가 명시하는 필드이며, 이 저장소의 applyRecurrenceScope(034)가 이미
 * boundaryDate·필터링 축으로 쓰고 있는 것과 같은 필드다. `start_date`/`end_date`는 검증 대상이
 * 아니다 — 회차별 단일 편집(§16-9 override)이 그 값을 규칙과 무관하게 바꿀 수 있기 때문이다.
 *
 * 개수 불일치와 "규칙 밖 회차 섞임"을 하나의 집합 동등 비교로 함께 잡는다(둘 다 422
 * OCCURRENCE_INVALID — api.md에 별도 코드가 없다).
 *
 * @param {object} p
 * @param {string|null} p.rRule
 * @param {boolean} p.isAllDay
 * @param {string|null} p.recurrenceTimezone
 * @param {Date|string} p.dtstartInstant - 호출부가 고른 "진짜 시작점"(모듈 헤더 참조).
 * @param {Array<{original_date: string|Date}>} p.submittedInstances
 */
function assertOccurrencesMatchRule({ rRule, isAllDay, recurrenceTimezone, dtstartInstant, submittedInstances }) {
  const expected = expandOccurrences({ rRule, isAllDay, recurrenceTimezone, dtstartInstant })
    .map((d) => d.getTime());
  const submitted = (submittedInstances || []).map((inst) => new Date(inst.original_date).getTime());

  const expectedSet = new Set(expected);
  const submittedSet = new Set(submitted);

  const mismatch = expectedSet.size !== submittedSet.size
    || [...submittedSet].some((t) => !expectedSet.has(t));

  if (mismatch) {
    throw new UnprocessableEntityError('반복 규칙과 맞지 않는 일정이 있습니다', 'OCCURRENCE_INVALID');
  }
}

module.exports = { expandOccurrences, assertOccurrencesMatchRule, MAX_EXPAND_COUNT };
