/**
 * src/utils/localTime.js
 * =========================================
 * IANA 타임존 기준 로컬 벽시계 ↔ UTC 변환 유틸.
 *
 * RLY-20260806-026(specialDayService.js에서 최초 작성 — SpecialDay 생성 시 "09:00 로컬" 계산)과
 * RLY-20260806-032(reminderJobs.js — SpecialDay 발송 후 다음 해 로컬 09:00 재계산)가 공유한다.
 * 신규 프로덕션 의존성 없이 Node 내장 `Intl.DateTimeFormat`(풀 ICU)만으로 구현한다 — moment-timezone·
 * luxon 등을 새로 들이지 않는다.
 * =========================================
 */

function isValidIanaTimeZone(tz) {
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// 주어진 UTC 순간(instant)이 timeZone에서 몇 년-월-일 몇 시-분-초인지.
function localDateParts(instant, timeZone) {
  const zone = isValidIanaTimeZone(timeZone) ? timeZone : 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant));
  const map = {};
  parts.forEach((p) => { map[p.type] = p.value; });
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24, // Intl은 자정을 "24"로 표기할 수 있다
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

// timeZone에서 year-month-day의 hour:minute:00 벽시계가 UTC로 몇 시인지.
// 벽시계를 UTC로 취급한 최초 추정치를, 그 zone에서 실제로 몇 시로 읽히는지 보고 보정한다
// (DST 등 고정 오프셋이 아닌 zone도 다룬다). 2회 반복이면 실질적으로 수렴한다 — 정시 부근에서
// DST 전환이 겹치는 zone은 존재하나 극히 드물고, 그 경계 처리는 이 유틸의 스코프가 아니다.
function localWallClockToUtc(year, month, day, hour, minute, timeZone) {
  const zone = isValidIanaTimeZone(timeZone) ? timeZone : 'UTC';
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);

  let guess = desired;
  for (let i = 0; i < 2; i += 1) {
    const observed = localDateParts(guess, zone);
    const observedAsUtc = Date.UTC(
      observed.year, observed.month - 1, observed.day,
      observed.hour, observed.minute, observed.second
    );
    guess += desired - observedAsUtc;
  }
  return new Date(guess);
}

// base_date(DATE, 시각 없음)를 그 날 09:00 로컬(timeZone)의 UTC 순간으로 변환한다
// (SC-reminder §1 "SpecialDay: base_date @ 09:00 로컬").
function localNineAmUtc(baseDate, timeZone) {
  const d = new Date(baseDate);
  return localWallClockToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 9, 0, timeZone);
}

module.exports = { isValidIanaTimeZone, localDateParts, localWallClockToUtc, localNineAmUtc };
