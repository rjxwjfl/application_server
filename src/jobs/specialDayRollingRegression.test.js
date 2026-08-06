/**
 * src/jobs/specialDayRollingRegression.test.js
 * =========================================
 * RLY-20260806-048 — 기념일 롤링 표준 정렬(User 판정 2026-08-06: "존재하지 않는 날짜는 그 해에
 * 없다. 당기지도 밀지도 않는다. 양력·음력 모두") + 음력 영구 미발송 결함 수리 회귀 스위트.
 *
 * Part A(순수 함수, DB 불필요) — `specialDayRolling.js`의 전진 루프 자체를 직접 검증한다.
 * Part B(job dispatch, mock DB) — `reminderJobs.js`의 `dispatchOne`이 롤링 성공/구조적 실패를
 * 실제로 어떻게 처리하는지 검증한다. `dispatchOne`은 이미 모듈에서 export돼 있어
 * `claimDueBatch`(trigger_at <= now() 제약)를 우회해 직접 호출할 수 있다 — 그래서 "이미 2042년
 * 상태"처럼 실시간으로는 도달 못 하는 먼 미래 시나리오도 단위 수준에서 정확히 재현할 수 있다.
 * 관행: 테스트 프레임워크 없음, plain assert + `node <file>.js` 직접 실행.
 *
 * 실행: node src/jobs/specialDayRollingRegression.test.js
 */

const assert = require('assert');

process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test';
process.env.PGDATABASE = process.env.PGDATABASE || 'test';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test';

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond) {
  if (cond) pass++;
  else { fail++; failures.push(desc); }
}
async function expectOk(desc, fn) {
  try {
    const result = await fn();
    pass++;
    return result;
  } catch (err) {
    fail++;
    failures.push(`${desc}: 정상 통과를 기대했지만 에러 — ${err.message}`);
    return undefined;
  }
}

// ════════════════════════════════════════════════════════════════════════
// Part A — specialDayRolling.js 순수 함수 검증(DB 불필요)
// ════════════════════════════════════════════════════════════════════════
const {
  nextSolarAnniversary, nextLunarAnniversary,
  RollingCapExceededError, RollingRangeExceededError,
} = require('../utils/specialDayRolling');

// ① 양력 2/29 → 다음 윤년으로 롤링(평년 건너뜀). 단순 4년 주기 + 세기 예외(100으로 나누어떨어지고
//   400으로는 안 나누어떨어지는 해는 평년이라 그 앞뒤 윤년 간격이 8년으로 벌어짐 — 1896→1904가
//   실제 사례, 1900이 평년) 둘 다 확인해야 "그냥 +4"로 하드코딩하지 않았음이 검증된다.
{
  const simple = nextSolarAnniversary(2024, 2, 29); // 2024 윤년 → 다음 윤년 2028
  check('① 2/29(단순 4년 주기) → 2028로 롤링', simple.year === 2028 && simple.month === 2 && simple.day === 29);

  const centuryException = nextSolarAnniversary(1896, 2, 29); // 1900은 평년(세기 예외) → 1904가 다음 윤년
  check('① 2/29(세기 예외, 1900 평년) → 1904로 롤링(8년 간격)', centuryException.year === 1904 && centuryException.day === 29);
}

// ② 평범한 날짜(2/29가 아님)는 이 리팩터 전과 동일하게 그냥 +1년 — 전진 루프 도입이 일반 케이스를
//   건드리지 않았음을 확인하는 회귀 안전장치.
{
  const normal = nextSolarAnniversary(2024, 5, 10);
  check('② 평범한 날짜(5/10)는 +1년 그대로', normal.year === 2025 && normal.month === 5 && normal.day === 10);
  const feb28 = nextSolarAnniversary(2023, 2, 28); // 2/28은 매해 존재 — 클램핑 대상이 아니다
  check('② 2/28(매해 존재)은 +1년 그대로, 클램핑 대상 아님', feb28.year === 2024 && feb28.day === 28);
}

// ③ 음력 윤달 기념일이 다음 유효한 해로 전진(영구 포기하지 않는다). 실측: 음력 2월 윤달은
//   2023년과 2042년에만 있다(그 사이 19년은 전부 그 윤달이 없음, korean-lunar-calendar로 직접
//   스캔해 확인) — 이전 구현이면 2024년 시점에 바로 throw해 giveUp까지 갔을 조합이다.
{
  // 2023년 음력 2월(윤달) 15일 = 양력 2023-04-05(korean-lunar-calendar로 직접 확인).
  const next = nextLunarAnniversary(2023, 4, 5, 2, 15, true);
  check('③ 음력 윤달(2월) 기념일이 19년 건너뛴 다음 유효 해(2042)로 롤링', next.year === 2042 && next.month === 4 && next.day === 5);

  // 대조군 — 윤달이 아닌 평범한 음력 기념일(예: 음력 8월 15일, 매년 존재)은 여전히 그냥 다음 해로.
  // 2024-09-17 = 음력 2024-8-15(평달)로 직접 확인.
  const normalLunar = nextLunarAnniversary(2024, 9, 17, 8, 15, false);
  check('③ 평범한 음력 기념일(윤달 아님)은 매번 정상적으로 다음 해로 롤링(회귀 안전장치)', normalLunar.year === 2025);
}

// ④ 라이브러리 지원 범위(1000~2050) 초과 → RollingRangeExceededError, .permanent=true,
//   .reason='range_exceeded'(도구 한계, 데이터/로직 문제 아님이라는 분류가 실제로 붙는지 확인).
{
  // 2042년 음력 2월 윤달 다음은 2051년인데 그건 범위 밖 — ③에서 쓴 것과 같은 조합을 한 바퀴 더 돌린다.
  let thrown = null;
  try {
    nextLunarAnniversary(2042, 4, 5, 2, 15, true); // 다음 윤달 2월은 2051년(범위 밖)
  } catch (err) {
    thrown = err;
  }
  check('④ 범위 초과 시 예외가 실제로 던져짐', thrown !== null);
  check('④ RollingRangeExceededError 인스턴스', thrown instanceof RollingRangeExceededError);
  check('④ .permanent === true(재시도 무의미 표시)', thrown && thrown.permanent === true);
  check("④ .reason === 'range_exceeded'(cap_exceeded와 구분됨)", thrown && thrown.reason === 'range_exceeded');
}

// ⑤ 전진 상한 초과 → RollingCapExceededError. 정상 데이터로는 도달 못 하므로(음력 윤달 최대
//   간격은 메톤 주기 19년 안, 위 실측대로) korean-lunar-calendar의 setLunarDate를 일시적으로
//   몽키패치해 "그 무엇을 찔러도 항상 없음"을 흉내내 상한 로직 자체가 실제로 도는지 검증한다.
//   라이브러리 코드 자체는 건드리지 않는다 — 이 프로세스 안에서만, 검증 직후 즉시 원복.
{
  const KoreanLunarCalendar = require('korean-lunar-calendar');
  const original = KoreanLunarCalendar.prototype.setLunarDate;
  KoreanLunarCalendar.prototype.setLunarDate = () => false; // 항상 실패

  let thrown = null;
  try {
    // 시작점을 1010년으로 잡아 상한(25년)을 다 채워도 지원 범위(1000~2050) 안에 머물게 한다 —
    // 그래야 range_exceeded가 아니라 cap_exceeded가 먼저 트리거된다는 걸 명확히 구분해서 본다.
    nextLunarAnniversary(1010, 3, 1, 5, 10, true);
  } catch (err) {
    thrown = err;
  } finally {
    KoreanLunarCalendar.prototype.setLunarDate = original; // 반드시 원복
  }

  check('⑤ 전진 상한 초과 시 예외가 실제로 던져짐(무한 루프 아님)', thrown !== null);
  check('⑤ RollingCapExceededError 인스턴스', thrown instanceof RollingCapExceededError);
  check('⑤ .permanent === true', thrown && thrown.permanent === true);
  check("⑤ .reason === 'cap_exceeded'(range_exceeded와 구분됨)", thrown && thrown.reason === 'cap_exceeded');

  // 원복 확인 — 몽키패치가 이 프로세스의 이후 호출에 새지 않았는지.
  check('⑤ setLunarDate 원복 확인(몽키패치가 새지 않음)', KoreanLunarCalendar.prototype.setLunarDate === original);
}

// ════════════════════════════════════════════════════════════════════════
// Part B — reminderJobs.js의 dispatchOne 통합 검증(mock DB·mock fcm)
// ════════════════════════════════════════════════════════════════════════
const dbPath = require.resolve('../../config/db');
const fcmPath = require.resolve('../utils/fcm');

// 이 스위트는 SpecialDay 롤링 경로만 본다 — 모든 시나리오에서 recipientIds를 의도적으로 비워
// (special_days를 db에 등록하지 않음) FCM 발송 분기 자체를 타지 않게 한다(recipientIds.length
// > 0 가드). fcm은 그래도 require 시점 부수효과(Firebase Admin 초기화) 회피를 위해 mock한다.
const db = { reminders: {} };

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();

  // ReminderDAO.getRecipients(special_day) — special_days에 등록된 게 없으므로 항상 빈 배열.
  if (s.startsWith('SELECT bm.user_id') && s.includes('FROM special_days sd')) {
    return { rows: [] };
  }
  // ReminderDAO.rollSpecialDay
  if (s.startsWith('UPDATE reminders') && s.includes('SET trigger_at = $1, attempt_count = 0')) {
    const [nextTriggerAt, id, claimToken] = params;
    const r = db.reminders[id];
    if (r && r.claim_token === claimToken) {
      r.trigger_at = nextTriggerAt;
      r.attempt_count = 0;
      r.claim_token = null;
      r.claimed_at = null;
      r.next_attempt_at = null;
      return { rows: [{ id }] };
    }
    return { rows: [] };
  }
  // ReminderDAO.markSent / giveUp — 둘 다 같은 SQL 텍스트(UPDATE reminders SET sent_at = now()...).
  if (s.startsWith('UPDATE reminders SET sent_at = now()')) {
    const [id, claimToken] = params;
    const r = db.reminders[id];
    if (r && r.claim_token === claimToken) {
      r.sent_at = new Date().toISOString();
      return { rows: [{ id }] };
    }
    return { rows: [] };
  }
  // ReminderDAO.markFailed
  if (s.startsWith('UPDATE reminders') && s.includes('SET claim_token = NULL, claimed_at = NULL, next_attempt_at = $1')) {
    const [nextAttemptAt, id, claimToken] = params;
    const r = db.reminders[id];
    if (r && r.claim_token === claimToken) {
      r.next_attempt_at = nextAttemptAt;
      r.claim_token = null;
      r.claimed_at = null;
      return { rows: [{ id }] };
    }
    return { rows: [] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const fcmMock = {
  sendMulticast: async () => { throw new Error('이 스위트는 recipientIds를 항상 비워 fcm이 호출되면 안 된다'); },
  sendToTopic: async () => ({}),
  subscribeToTopic: async () => ({}),
  unsubscribeFromTopic: async () => ({}),
};
require.cache[fcmPath] = { id: fcmPath, filename: fcmPath, loaded: true, exports: fcmMock };

const { dispatchOne } = require('./reminderJobs');

async function run() {
  // ── ⑥ 정상 롤링(평범한 날짜) 후에도 sent_at은 영구 NULL로 남는다(032 계약) ──────────────
  // ⚠️ 이게 핵심 회귀다 — 전진 루프를 넣다가 실수로 sent_at을 세우면 그 기념일이 영구히
  //   죽는다(지금 고치려는 결함과 같은 결과). 평범한(윤달 아닌) 음력 기념일로 검증한다.
  {
    const claimToken = 'tok-normal';
    db.reminders.r1 = {
      id: 'r1', target_type: 2, target_id: 'sd-normal', trigger_offset: 1000,
      // 2024-09-17 = 음력 2024-8-15(평달) — 트리거는 그 09:00 KST - 1000초.
      trigger_at: new Date(Date.UTC(2024, 8, 17, 0, 0, 0) - 1000 * 1000).toISOString(),
      timezone: 'Asia/Seoul', claim_token: claimToken, claimed_at: new Date().toISOString(), attempt_count: 1,
      special_day_is_lunar: true, special_day_lunar_month: 8, special_day_lunar_day: 15, special_day_lunar_is_leap_month: false,
    };
    await expectOk('⑥ 정상 롤링 dispatchOne 실행', () => dispatchOne(db.reminders.r1, claimToken));
    check('⑥ 롤링 후 sent_at NULL 유지(영구 — GC되지 않고 다음 해에 다시 발화 가능)', db.reminders.r1.sent_at == null);
    check('⑥ trigger_at이 다음 해(2025)로 전진', new Date(db.reminders.r1.trigger_at).getUTCFullYear() === 2025);
    check('⑥ 롤링 후 attempt_count가 0으로 리셋(다음 해를 위한 새 재시도 예산)', db.reminders.r1.attempt_count === 0);
    check('⑥ 롤링 후 claim_token 해제', db.reminders.r1.claim_token === null);
  }

  // ── ⑦ 구조적 실패(범위 초과) → 백오프 재시도 없이 단 1회 만에 즉시 giveUp ──────────────
  // dispatchReminders()의 claimDueBatch(trigger_at <= now() 제약)를 우회해 dispatchOne을 직접
  // 호출한다 — "이미 2042년" 상태는 실시간으로는 재현 불가능하지만 단위 호출로는 정확히 재현된다.
  {
    const claimToken = 'tok-permanent';
    db.reminders.r2 = {
      id: 'r2', target_type: 2, target_id: 'sd-permanent', trigger_offset: 1000,
      // 2042-04-05 = 음력 2042-2(윤달)-15 — 다음 윤달 2월은 2051년(범위 밖), ④에서 확인한 조합.
      trigger_at: new Date(Date.UTC(2042, 3, 5, 0, 0, 0) - 1000 * 1000).toISOString(),
      timezone: 'Asia/Seoul', claim_token: claimToken, claimed_at: new Date().toISOString(), attempt_count: 1,
      special_day_is_lunar: true, special_day_lunar_month: 2, special_day_lunar_day: 15, special_day_lunar_is_leap_month: true,
    };
    await expectOk('⑦ 구조적 실패 dispatchOne 실행(에러가 dispatchOne 밖으로 새지 않아야 함)', () => dispatchOne(db.reminders.r2, claimToken));
    check('⑦ 단 1회 시도(attempt_count=1)만에 종결됨(retryOrGiveUp의 5회 백오프를 거치지 않음)', db.reminders.r2.attempt_count === 1);
    check('⑦ sent_at이 세워져 즉시 종결됨(giveUpPermanently)', db.reminders.r2.sent_at != null);
    check('⑦ next_attempt_at이 세워지지 않음(markFailed/백오프 경로를 안 탔다는 증거)', db.reminders.r2.next_attempt_at == null);
  }

  // ── ⑧ 대조군 — 구조적이지 않은 일반 실패(FCM 등)는 여전히 백오프 재시도를 거친다 ──────────
  // (reminderDispatchRegression.test.js ⑧이 이미 이 경로를 5틱까지 검증하지만, 이 스위트
  // 안에서 "permanent 아닌 에러는 즉시 종결되지 않는다"를 직접 대조해 ⑦과의 분기 자체를 고정한다.)
  {
    const claimToken = 'tok-transient';
    db.reminders.r3 = {
      id: 'r3', target_type: 2, target_id: 'sd-transient', trigger_offset: 1000,
      // 서기 500년 — korean-lunar-calendar의 setSolarDate 자체가 지원 범위 밖으로 실패하는
      // 지점(직접 확인: setSolarDate(500,1,1) === false). 이건 nextLunarAnniversary의 전진
      // 루프에 들어가기도 전에 던져지는 **기존부터 있던 일반 Error** 경로라 `.permanent`이 안
      // 붙는다 — RollingCapExceededError/RollingRangeExceededError와 다른, 진짜 대조군이다.
      trigger_at: new Date(Date.UTC(500, 0, 1, 0, 0, 0) - 1000 * 1000).toISOString(),
      timezone: 'Asia/Seoul', claim_token: claimToken, claimed_at: new Date().toISOString(), attempt_count: 1,
      special_day_is_lunar: true, special_day_lunar_month: 8, special_day_lunar_day: 15, special_day_lunar_is_leap_month: false,
    };
    await expectOk('⑧ 일반 에러 dispatchOne 실행', () => dispatchOne(db.reminders.r3, claimToken));
    check('⑧ permanent 아닌 에러는 즉시 종결되지 않고 백오프 재시도로 감(markFailed — next_attempt_at 세워짐)', db.reminders.r3.next_attempt_at != null);
    check('⑧ sent_at은 아직 세워지지 않음(giveUp 아님, retryOrGiveUp의 재시도 분기)', db.reminders.r3.sent_at == null);
  }

  console.log(`\n[specialDayRollingRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[specialDayRollingRegression] 실행 실패:', error);
  process.exitCode = 1;
});
