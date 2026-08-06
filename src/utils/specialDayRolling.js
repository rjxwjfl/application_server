/**
 * src/utils/specialDayRolling.js
 * =========================================
 * SpecialDay(target_type=2) 발송 직후 "다음 해" trigger_at 계산 (SC-reminder §5A).
 *
 * User 판정(2026-08-06)이 §16-8("2/29 → 평년 2/28")을 폐기했다: **"존재하지 않는 날짜는 그
 * 해에 없다. 당기지도 밀지도 않는다. 양력·음력 모두. 없는 날은 그냥 생성하지 않으면 된다 —
 * 굳이 복잡하게 할 필요 없다."** ⇒ 클램핑하지 않고 **다음으로 그 날짜가 실제로 존재하는 해까지
 * 그냥 건너뛴다**(양력 2/29 → 다음 윤년, 음력 윤달 → 그 윤달이 있는 다음 해). 클라는 이미 이
 * 판정대로 정렬됐다(RLY-20260806-045) — 이 모듈이 예전 §16-8대로 클램핑하면 표시(클라)와
 * 발화(서버)가 어긋난다.
 *
 * 양력(is_lunar=false): 다음 해 같은 월·일. Gregorian 달력에서 "그 해에 없는 날짜"가 될 수 있는
 * 유일한 조합은 2/29뿐이다 — 2/29면 존재하는 다음 윤년까지 건너뛴다.
 *
 * 음력(is_lunar=true): `korean-lunar-calendar`(npm, 문서 §5A가 명시한 패키지, 버전 0.4.0 고정)로
 * "이번에 발화한 solar 날짜 → 그 해의 lunar 날짜 → 같은 lunar 월·일(윤달 여부 포함)이 존재하는
 * 다음 lunar 해 → 그 solar 날짜"를 구한다. 윤달은 매 해 오지 않는데, **이전 구현은 "그 해에
 * 없으면 throw"**였고 reminderJobs.js가 그걸 일시적 실패로 다뤄 재시도하다 포기(giveUp)했다 —
 * 그 결과 그 기념일 알림이 영구히 죽었다(정책과 무관한 원래 잠재 결함, 이번 판정을 계기로
 * 드러남). 지금은 없으면 그냥 다음 해로 넘어간다 — 이 throw 경로 자체가 사라지므로 그 결함이
 * 자연히 해소된다(별도 장치 불필요, 지시).
 *
 * 전진은 반드시 끝나야 한다(무한 루프 금지) — `MAX_ROLL_YEARS` 하나로 막는다. 라이브러리 지원
 * 범위(1000~2050) 밖으로 나가면 `setLunarDate`가 그냥 false를 반환하므로(직접 확인) "그 해에
 * 없음"과 같은 취급으로 계속 전진하다 이 상한에 걸려 끝난다 — 별도 분류가 필요 없다.
 *
 * 이 모듈이 던지는 에러는 전부 `err.permanent = true`를 달고 있다 — 순수 계산(DB·네트워크 미접촉)
 * 이라 같은 입력이면 재시도해도 항상 같은 결과이므로, 호출부(reminderJobs.js)가 지수 백오프
 * 재시도 없이 바로 종결하도록 판단할 수 있는 신호다(User: "클래스·reason 분류 체계는 만들지
 * 마라, 한 줄로 되살릴 수 있으면 되살려라" — 그래서 클래스가 아니라 속성 하나만 붙인다).
 */

const KoreanLunarCalendar = require('korean-lunar-calendar');
const { localWallClockToUtc, localDateParts } = require('./localTime');

// 무한 루프 방지용 상한. 양력 2/29→다음 윤년은 세기 예외(예: 1900)로 최대 8년까지 벌어질 수
// 있고, 음력 윤달은 최대 19년(메톤 주기)까지 벌어질 수 있다(둘 다 실측 확인) — 그 최악값에
// 여유를 더한 값 하나로 둘 다 막는다.
const MAX_ROLL_YEARS = 25;

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// 양력 다음 해 같은 월·일. 2/29면 존재하는 다음 윤년까지 건너뛴다(클램핑 없음 — User 판정).
function nextSolarAnniversary(year, month, day) {
  let candidateYear = year + 1;
  for (let i = 0; i < MAX_ROLL_YEARS; i += 1) {
    if (!(month === 2 && day === 29) || isLeapYear(candidateYear)) {
      return { year: candidateYear, month, day };
    }
    candidateYear += 1;
  }
  throw Object.assign(new Error(`solar rolling: ${MAX_ROLL_YEARS}년 안에 다음 윤년을 찾지 못함 — year=${year}`), { permanent: true });
}

// 음력 다음 해 같은 lunar 월·일(윤달 플래그 포함) → 그 solar 날짜. 그 해에 없으면 있는 다음
// 해까지 그냥 건너뛴다(클램핑·에러 없음 — User 판정).
function nextLunarAnniversary(solarYear, solarMonth, solarDay, lunarMonth, lunarDay, lunarIsLeapMonth) {
  const cal = new KoreanLunarCalendar();

  const solarOk = cal.setSolarDate(solarYear, solarMonth, solarDay);
  if (!solarOk) {
    throw Object.assign(new Error(`lunar rolling: setSolarDate 실패 (${solarYear}-${solarMonth}-${solarDay})`), { permanent: true });
  }
  const lunarNow = cal.getLunarCalendar();

  let candidateLunarYear = lunarNow.year + 1;
  for (let i = 0; i < MAX_ROLL_YEARS; i += 1) {
    if (cal.setLunarDate(candidateLunarYear, lunarMonth, lunarDay, !!lunarIsLeapMonth)) {
      return cal.getSolarCalendar(); // { year, month, day }
    }
    candidateLunarYear += 1;
  }
  throw Object.assign(new Error(
    `lunar rolling: ${MAX_ROLL_YEARS}년 안에 다음 있는 해를 찾지 못함 — ` +
    `lunar_month=${lunarMonth} lunar_day=${lunarDay} leap=${!!lunarIsLeapMonth}`
  ), { permanent: true });
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
 * @throws {Error} `err.permanent = true`가 붙은 에러 — 순수 계산 실패라 재시도해도 항상 같은
 *   결과다(정상 데이터로는 도달하지 않는 방어적 상한 포함).
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
