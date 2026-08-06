/**
 * src/jobs/specialDayRollingRegression.test.js
 * =========================================
 * RLY-20260806-048 — 기념일 롤링 표준 정렬 회귀 스위트.
 *
 * User 판정(2026-08-06): "존재하지 않는 날짜는 그 해에 없다. 당기지도 밀지도 않는다. 양력·음력
 * 모두. 없는 날은 그냥 생성하지 않으면 된다 — 굳이 복잡하게 할 필요 없다."
 * ⇒ specialDayRolling.js는 클램핑 없이 다음으로 존재하는 해까지 그냥 건너뛴다(단순 반복문 +
 * 무한 루프 방지용 상한 하나). 복잡한 오류 분류 체계는 만들지 않았다(지시).
 *
 * Part A(순수 함수, DB 불필요) — 전진 로직 자체.
 * Part B(job dispatch, mock DB) — dispatchOne이 롤링 성공 후 sent_at을 영구 NULL로 유지하는지
 * (032 계약 — 전진 로직을 넣다가 실수로 발송완료 표시를 세우면 그 기념일이 영구히 죽는다).
 *
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
const { nextSolarAnniversary, nextLunarAnniversary } = require('../utils/specialDayRolling');

// ① 양력 2/29 → 다음 윤년으로 롤링(평년 건너뜀). 단순 4년 주기 + 세기 예외(100으로 나누어떨어지고
//   400으로는 안 나누어떨어지는 해는 평년이라 그 앞뒤 윤년 간격이 8년으로 벌어짐 — 1896→1904가
//   실제 사례, 1900이 평년) 둘 다 확인해야 "그냥 +4"로 하드코딩하지 않았음이 검증된다.
{
  const simple = nextSolarAnniversary(2024, 2, 29); // 2024 윤년 → 다음 윤년 2028
  check('① 2/29(단순 4년 주기) → 2028로 롤링', simple.year === 2028 && simple.month === 2 && simple.day === 29);

  const centuryException = nextSolarAnniversary(1896, 2, 29); // 1900은 평년(세기 예외) → 1904가 다음 윤년
  check('① 2/29(세기 예외, 1900 평년) → 1904로 롤링(8년 간격)', centuryException.year === 1904 && centuryException.day === 29);
}

// ② 평범한 날짜(2/29가 아님)는 종전대로 그냥 +1년 — 전진 처리가 일반 케이스를 건드리지
//   않았음을 확인하는 회귀 안전장치.
{
  const normal = nextSolarAnniversary(2024, 5, 10);
  check('② 평범한 날짜(5/10)는 +1년 그대로', normal.year === 2025 && normal.month === 5 && normal.day === 10);
  const feb28 = nextSolarAnniversary(2023, 2, 28); // 2/28은 매해 존재 — 대상 아님
  check('② 2/28(매해 존재)은 +1년 그대로', feb28.year === 2024 && feb28.day === 28);
}

// ③ 음력 윤달 기념일이 다음에 있는 해로 롤링(영구 포기하지 않는다). 실측: 음력 2월 윤달은
//   2023년과 2042년에만 있다(그 사이 19년은 없음, korean-lunar-calendar로 직접 스캔해 확인) —
//   이전 구현이면 2024년 시점에 바로 throw해 재시도 끝에 giveUp까지 갔을 조합이다.
{
  // 2023년 음력 2월(윤달) 15일 = 양력 2023-04-05(korean-lunar-calendar로 직접 확인).
  const next = nextLunarAnniversary(2023, 4, 5, 2, 15, true);
  check('③ 음력 윤달(2월) 기념일이 19년 건너뛴 다음 있는 해(2042)로 롤링', next.year === 2042 && next.month === 4 && next.day === 5);

  // 대조군 — 윤달이 아닌 평범한 음력 기념일(예: 음력 8월 15일, 매년 존재)은 여전히 그냥 다음 해로.
  const normalLunar = nextLunarAnniversary(2024, 9, 17, 8, 15, false); // 2024-09-17 = 음력 2024-8-15(평달)
  check('③ 평범한 음력 기념일(윤달 아님)은 매번 정상적으로 다음 해로 롤링(회귀 안전장치)', normalLunar.year === 2025);
}

// ════════════════════════════════════════════════════════════════════════
// Part B — reminderJobs.js의 dispatchOne 통합 검증(mock DB·mock fcm)
// ════════════════════════════════════════════════════════════════════════
const dbPath = require.resolve('../../config/db');
const fcmPath = require.resolve('../utils/fcm');

// special_days를 db에 등록하지 않아 recipientIds가 항상 빈 배열이 되게 해서 FCM 발송 분기
// 자체를 타지 않게 한다(recipientIds.length > 0 가드). fcm은 require 시점 부수효과(Firebase
// Admin 초기화) 회피를 위해서만 mock한다.
const db = { reminders: {} };

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();

  if (s.startsWith('SELECT bm.user_id') && s.includes('FROM special_days sd')) {
    return { rows: [] }; // ReminderDAO.getRecipients(special_day)
  }
  if (s.startsWith('UPDATE reminders') && s.includes('SET trigger_at = $1, attempt_count = 0')) {
    const [nextTriggerAt, id, claimToken] = params; // ReminderDAO.rollSpecialDay
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
  if (s.startsWith('UPDATE reminders SET sent_at = now()')) {
    const [id, claimToken] = params; // markSent / giveUp(같은 SQL 텍스트)
    const r = db.reminders[id];
    if (r && r.claim_token === claimToken) {
      r.sent_at = new Date().toISOString();
      return { rows: [{ id }] };
    }
    return { rows: [] };
  }
  if (s.startsWith('UPDATE reminders') && s.includes('SET claim_token = NULL, claimed_at = NULL, next_attempt_at = $1')) {
    const [nextAttemptAt, id, claimToken] = params; // markFailed
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
  // ── ④ 롤링 후에도 sent_at은 영구 NULL로 남는다(032 계약) ─────────────────────────
  // ⚠️ 핵심 회귀 — 전진 처리를 넣다가 실수로 sent_at을 세우면 그 기념일이 영구히 죽는다(지금
  //   고치려는 결함과 같은 결과).
  {
    const claimToken = 'tok-normal';
    db.reminders.r1 = {
      id: 'r1', target_type: 2, target_id: 'sd-normal', trigger_offset: 1000,
      // 2024-09-17 = 음력 2024-8-15(평달) — 트리거는 그 09:00 KST - 1000초.
      trigger_at: new Date(Date.UTC(2024, 8, 17, 0, 0, 0) - 1000 * 1000).toISOString(),
      timezone: 'Asia/Seoul', claim_token: claimToken, claimed_at: new Date().toISOString(), attempt_count: 1,
      special_day_is_lunar: true, special_day_lunar_month: 8, special_day_lunar_day: 15, special_day_lunar_is_leap_month: false,
    };
    await expectOk('④ 정상 롤링 dispatchOne 실행', () => dispatchOne(db.reminders.r1, claimToken));
    check('④ 롤링 후 sent_at NULL 유지(영구 — GC되지 않고 다음 해에 다시 발화 가능)', db.reminders.r1.sent_at == null);
    check('④ trigger_at이 다음 해(2025)로 전진', new Date(db.reminders.r1.trigger_at).getUTCFullYear() === 2025);
    check('④ 롤링 후 attempt_count가 0으로 리셋(다음 해를 위한 새 재시도 예산)', db.reminders.r1.attempt_count === 0);
    check('④ 롤링 후 claim_token 해제', db.reminders.r1.claim_token === null);
  }

  // ── 윤달 기념일도 실제 dispatchOne 경로로 정상 롤링됨을 한 번 더 확인(③의 통합 버전) ──────
  {
    const claimToken = 'tok-leap';
    db.reminders.r2 = {
      id: 'r2', target_type: 2, target_id: 'sd-leap', trigger_offset: 1000,
      // 2023-04-05 = 음력 2023-2(윤달)-15 — 다음 있는 해는 2042.
      trigger_at: new Date(Date.UTC(2023, 3, 5, 0, 0, 0) - 1000 * 1000).toISOString(),
      timezone: 'Asia/Seoul', claim_token: claimToken, claimed_at: new Date().toISOString(), attempt_count: 3,
      special_day_is_lunar: true, special_day_lunar_month: 2, special_day_lunar_day: 15, special_day_lunar_is_leap_month: true,
    };
    await expectOk('윤달 기념일 dispatchOne 실행 — 19년을 건너뛰어도 정상 처리', () => dispatchOne(db.reminders.r2, claimToken));
    check('윤달 기념일도 sent_at NULL 유지', db.reminders.r2.sent_at == null);
    check('윤달 기념일 trigger_at이 2042년으로 전진', new Date(db.reminders.r2.trigger_at).getUTCFullYear() === 2042);
    check('윤달 기념일도 attempt_count가 0으로 리셋', db.reminders.r2.attempt_count === 0);
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
