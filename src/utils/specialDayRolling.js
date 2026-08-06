/**
 * src/utils/specialDayRolling.js
 * =========================================
 * SpecialDay(target_type=2) 발송 직후 "다음 해" trigger_at 계산 (SC-reminder §5A).
 *
 * 양력 반복(is_lunar=false): 다음 해 같은 월·일. 2/29는 평년에 없으므로 2/28로 대체
 * (SC-reminder §5A "2/29 → 평년 2/28", naive +1년 금지).
 *
 * 음력 반복(is_lunar=true): `korean-lunar-calendar`(npm, 문서 §5A가 명시한 그 패키지 —
 * usingsky/korean_lunar_calendar_js, MIT, zero deps)로 "이번에 발화한 solar 날짜 → 그 해의
 * lunar 날짜 → 다음 lunar 해의 같은 lunar 월·일(윤달 여부 포함) → 그 solar 날짜"를 구한다.
 * 버전 0.4.0 고정 — 설치 시점(2026-08) npm 최신판, KARI(한국천문연구원) 표준 기준 1000~2050년
 * 범위를 지원해 서비스 수명 내 안전.
 *
 * ⚠️ 윤달(lunar leap month)은 매 해 오지 않는다 — 특정 lunar_month에 윤달이 있는 음력 기념일이
 * 다음 lunar 해에는 그 윤달이 없을 수 있다. 이 경우 `korean-lunar-calendar`의 setLunarDate가
 * false를 반환한다. 여기서 임의로 평달로 대체하지 않는다(정책 미확정) — 실패를 그대로 던져
 * 호출부(reminderJobs.js)가 로그를 남기고 그 리마인더를 다음 배치로 미루게 한다.
 * "실패를 sent_at으로 덮어 영구 미발송으로 만들지 마라"는 지시가 정확히 이 경로를 가리킨다.
 */

const KoreanLunarCalendar = require('korean-lunar-calendar');
const { localWallClockToUtc, localDateParts } = require('./localTime');

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// 양력 다음 해 같은 월·일. 2/29 → 평년이면 2/28.
function nextSolarAnniversary(year, month, day) {
  const nextYear = year + 1;
  if (month === 2 && day === 29 && !isLeapYear(nextYear)) {
    return { year: nextYear, month: 2, day: 28 };
  }
  return { year: nextYear, month, day };
}

// 음력 다음 해 같은 lunar 월·일(윤달 플래그 포함) → 그 solar 날짜. 실패(예: 그 해에 해당 윤달이
// 없음, 지원 범위 밖)하면 throw한다 — 호출부가 로그·연기 처리한다.
function nextLunarAnniversary(solarYear, solarMonth, solarDay, lunarMonth, lunarDay, lunarIsLeapMonth) {
  const cal = new KoreanLunarCalendar();

  const solarOk = cal.setSolarDate(solarYear, solarMonth, solarDay);
  if (!solarOk) {
    throw new Error(`lunar rolling: setSolarDate 실패 (${solarYear}-${solarMonth}-${solarDay})`);
  }
  const lunarNow = cal.getLunarCalendar();

  const lunarOk = cal.setLunarDate(lunarNow.year + 1, lunarMonth, lunarDay, !!lunarIsLeapMonth);
  if (!lunarOk) {
    throw new Error(
      `lunar rolling: setLunarDate 실패 (lunar ${lunarNow.year + 1}-${lunarMonth}-${lunarDay}` +
      `${lunarIsLeapMonth ? ' 윤달' : ''}) — 그 해에 해당 윤달이 없거나 지원 범위(1000~2050) 밖`
    );
  }
  return cal.getSolarCalendar(); // { year, month, day }
}

/**
 * SpecialDay 리마인더 발송 직후 다음 해 trigger_at을 계산한다.
 *
 * @param {object} params
 * @param {Date|string} params.currentTriggerAt - 방금 발화한 trigger_at(= 그 해 occurrence 09:00
 *   로컬 - triggerOffsetSeconds).
 * @param {number} params.triggerOffsetSeconds - reminders.trigger_offset(불변, 롤링 대상 아님).
 * @param {string} params.timezone - reminders.timezone(SpecialDay는 NOT NULL). 'system' 등
 *   비-IANA 값이면 localTime.js가 계산에 한해 UTC로 대체한다(저장값 자체는 여기서 안 건드림 —
 *   이 함수는 timezone 컬럼을 쓰지 않는다).
 * @param {boolean} params.isLunar
 * @param {number|null} params.lunarMonth
 * @param {number|null} params.lunarDay
 * @param {boolean|null} params.lunarIsLeapMonth
 * @returns {Date} 다음 해 trigger_at(UTC)
 * @throws {Error} 음력 계산 실패(윤달 없음 등) — 호출부가 잡아서 연기 처리해야 한다.
 */
function computeNextTriggerAt({
  currentTriggerAt, triggerOffsetSeconds, timezone,
  isLunar, lunarMonth, lunarDay, lunarIsLeapMonth,
}) {
  // trigger_at = occurrence 09:00 로컬 - offset 이었으므로, offset을 되돌려 그 해 occurrence
  // 순간을 복원한 뒤 그 순간이 로컬로 몇 년-월-일인지를 구한다.
  const occurrenceInstant = new Date(new Date(currentTriggerAt).getTime() + triggerOffsetSeconds * 1000);
  const { year, month, day } = localDateParts(occurrenceInstant, timezone);

  const next = isLunar
    ? nextLunarAnniversary(year, month, day, lunarMonth, lunarDay, lunarIsLeapMonth)
    : nextSolarAnniversary(year, month, day);

  const nextOccurrenceUtc = localWallClockToUtc(next.year, next.month, next.day, 9, 0, timezone);
  return new Date(nextOccurrenceUtc.getTime() - triggerOffsetSeconds * 1000);
}

module.exports = { computeNextTriggerAt, nextSolarAnniversary, nextLunarAnniversary };
