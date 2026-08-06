/**
 * src/utils/recurrenceRule.js
 * =========================================
 * RLY-20260806-034 — 범위 편집(fork)의 "구간은 서로소다" 요건(domain.md §3-13) 중
 * COUNT 조정 부분만 구현한다.
 *
 * 이 저장소에는 RRULE 파서·전개 라이브러리가 없다(package.json에 rrule 계열 의존성 0건,
 * grep 결과 서버 어디에도 RRULE 전개 코드가 없음 — createEvent/createTask도 클라가 보낸
 * 회차를 그대로 저장할 뿐 규칙과 대조하지 않는다). 새 프로덕션 의존성 추가는 User 승인 없이
 * 금지라 이번 Task에서 rrule 라이브러리를 들이지 않는다 — 대신 COUNT=<정수> 토큰만 텍스트
 * 치환한다. **UNTIL 기반 규칙(원본이 COUNT 없이 UNTIL만 쓰는 경우)은 조정하지 않는다** —
 * UNTIL 날짜를 다시 계산하려면 전개가 필요한데 그게 없다. 이 제한은 구현 보고서에 명시한다.
 *
 * 원본 이벤트/태스크가 fork로 분리된 뒤, 원본에 남은(경계 이전) 회차 수로 원본의 COUNT를
 * 낮춰 "원본의 r_rule이 실제로 남은 회차 수보다 많은 회차를 약속하는" 불일치를 막는다.
 */

/**
 * r_rule 문자열의 COUNT=N 토큰을 remainingCount로 치환한다. COUNT 토큰이 없으면(UNTIL
 * 기반이거나 무제한 — 후자는 상한 365 계약상 존재하면 안 되지만 방어적으로 그대로 둔다)
 * 원본 문자열을 그대로 반환한다.
 *
 * @param {string|null} rRule
 * @param {number} remainingCount - 0 이상. 0이면 이 조각에 더 이상 회차가 없다는 뜻이지만
 *   r_rule 자체를 지우지는 않는다(이벤트/태스크 행 자체를 삭제하는 것은 이 함수의 책임이 아니다).
 * @returns {string|null}
 */
function adjustRuleCount(rRule, remainingCount) {
  if (!rRule) return rRule;
  if (!/COUNT=\d+/.test(rRule)) return rRule;
  const safeCount = Math.max(0, Math.trunc(remainingCount));
  return rRule.replace(/COUNT=\d+/, `COUNT=${safeCount}`);
}

module.exports = { adjustRuleCount };
