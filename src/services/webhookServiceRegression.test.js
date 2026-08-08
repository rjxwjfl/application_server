/**
 * src/services/webhookServiceRegression.test.js
 * =========================================
 * RLY-20260806-208 — webhookService.js는 어떤 회귀 테스트에도 걸리지 않던 파일이었다
 * (RLY-20260806-199 실측). 결제와 얽힌 경로라 **프로덕션 코드는 건드리지 않는다** —
 * 이 파일은 순수하게 테스트만 추가한다. 결함을 찾은 것은 구현 보고서에 등재했다
 * (billingDAO의 기존 TOCTOU 등재와 같은 방식 — 고치지 않고 목록에만).
 *
 * 우선순위: "욕심내지 않는다" — 결제 흐름 전체를 덮지 않고, 되돌리기 어렵거나(hard delete
 * 없음이라 이 파일엔 해당 없음) 데이터 정합성에 직결되는 경로만 우선한다:
 *   - Apple: payment_receipt_logs의 ON CONFLICT(transaction_id) DO NOTHING이 실제로
 *     "이미 처리된 트랜잭션 재수신"을 막는가(멱등성 게이트 — 웹훅 재전송은 실제로 일어난다)
 *   - Apple: FAMILY_SHARED 소유권은 개별 구독을 만들지 않는가(비즈니스 규칙)
 *   - 알 수 없는 productId·subscriptionId·notificationType·서명 없는 페이로드에서
 *     크래시하지 않는가(방어적 처리 — 외부 웹훅 페이로드는 신뢰할 수 없는 입력이다)
 *
 * ⚠️ 발견했지만 고치지 않은 것(구현 보고서 참조) — Google 경로의 `transaction_id`는
 * `google_${purchaseToken}_${notificationType}_${Date.now()}`로 매 호출마다 새로
 * 합성된다. insertReceiptLog의 멱등성 게이트는 transaction_id UNIQUE 하나에 의존하는데,
 * 이 값 자체가 매번 달라지므로 **Google 웹훅 재전송에 대해서는 멱등 게이트가 사실상
 * 작동하지 않는다**(Apple 경로는 txInfo.transactionId를 그대로 써서 진짜로 안정적이다 —
 * 같은 결함이 아니다). 이 파일은 "Google 재전송이 중복 처리된다"를 통과하는 정상 동작으로
 * 굳히는 테스트를 만들지 않는다.
 *
 * mock이 실제로 무엇을 검증하는지 확인(RLY-20260806-135 교훈) — ①(멱등성)은 프로덕션
 * 코드를 임시로 되돌려(cp 백업 + 복원) 이 테스트가 실제로 실패하는지 확인했다(구현
 * 보고서 참조).
 *
 * 관행: 테스트 프레임워크 없음. plain assert 없이 check() 헬퍼 + `node <file>.js`.
 * config/db를 가짜로 교체(sendAlertTwoChannelRegression.test.js와 동일 패턴).
 * Google Play API 호출(`_getGoogleSubscriptionState`, googleapis)은 싱글톤 인스턴스
 * 메서드를 직접 몽키패치해 대체한다 — 결제 API 자체를 흉내내지 않는다(이 파일의
 * 관심사는 그 응답을 받은 뒤의 서버 로직이다).
 *
 * 실행: node src/services/webhookServiceRegression.test.js
 */

process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test';
process.env.PGDATABASE = process.env.PGDATABASE || 'test';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test';

const dbPath = require.resolve('../../config/db');
const NOW = new Date().toISOString();

let receiptLogTxIds = new Set();
let insertedReceiptLogs = [];
let insertedSubscriptions = [];
let updatedPeriods = [];
let insertedEvents = [];
let expiredIds = [];
let subscriptionsByOriginalTxId = {};

function reset() {
  receiptLogTxIds = new Set();
  insertedReceiptLogs = [];
  insertedSubscriptions = [];
  updatedPeriods = [];
  insertedEvents = [];
  expiredIds = [];
  subscriptionsByOriginalTxId = {};
}

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();

  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // BillingDAO.insertReceiptLog — ⚠️ 멱등성 게이트가 "ON CONFLICT(transaction_id) DO
  // NOTHING" 절 자체에 있다는 걸 이 mock도 SQL 텍스트로 확인한다(RLY-20260806-135 교훈 —
  // 이 절이 사라지면 아래 브랜치가 매칭되지 않아 "Unhandled query"로 시끄럽게 죽는다.
  // JS 쪽에서 독자적으로 중복 여부를 판단하지 않는다 — 그러면 SQL이 깨져도 mock이
  // 조용히 계속 통과해버린다).
  if (s.startsWith('INSERT INTO payment_receipt_logs') && s.includes('ON CONFLICT (transaction_id) DO NOTHING')) {
    const [user_id, subscription_id, transaction_id, original_transaction_id, store_type, event_type] = params;
    if (receiptLogTxIds.has(transaction_id)) return { rows: [] }; // 이미 처리된 트랜잭션 — DO NOTHING
    receiptLogTxIds.add(transaction_id);
    const row = { id: `log-${transaction_id}`, user_id, subscription_id, transaction_id, original_transaction_id, store_type, event_type };
    insertedReceiptLogs.push(row);
    return { rows: [{ id: row.id }] };
  }
  // BillingDAO.findByOriginalTransactionId
  if (s.startsWith('SELECT * FROM user_subscriptions') && s.includes('WHERE original_transaction_id = $1')) {
    const row = subscriptionsByOriginalTxId[params[0]];
    return { rows: row ? [row] : [] };
  }
  // BillingDAO.create
  if (s.startsWith('INSERT INTO user_subscriptions')) {
    const [id, user_id, store_type, product_id, billing_cycle, status, original_transaction_id, current_period_start, current_period_end] = params;
    const row = { id, user_id, store_type, product_id, billing_cycle, status, original_transaction_id, current_period_start, current_period_end, created_at: NOW, updated_at: NOW };
    insertedSubscriptions.push(row);
    subscriptionsByOriginalTxId[original_transaction_id] = row;
    return { rows: [row] };
  }
  // BillingDAO.updatePeriod
  if (s.startsWith('UPDATE user_subscriptions') && s.includes('current_period_start = $2') && s.includes('grace_period_end = NULL')) {
    const [status, current_period_start, current_period_end, id] = params;
    updatedPeriods.push({ id, status, current_period_start, current_period_end });
    const existing = Object.values(subscriptionsByOriginalTxId).find((r) => r.id === id) || { id };
    const updated = { ...existing, status, current_period_start, current_period_end };
    if (existing.original_transaction_id) subscriptionsByOriginalTxId[existing.original_transaction_id] = updated;
    return { rows: [updated] };
  }
  // BillingDAO.expire
  if (s.startsWith('UPDATE user_subscriptions') && s.includes("status = 'EXPIRED'")) {
    const [id] = params;
    expiredIds.push(id);
    const existing = Object.values(subscriptionsByOriginalTxId).find((r) => r.id === id) || { id };
    const updated = { ...existing, status: 'EXPIRED' };
    if (existing.original_transaction_id) subscriptionsByOriginalTxId[existing.original_transaction_id] = updated;
    return { rows: [updated] };
  }
  // BillingDAO.insertSubscriptionEvent
  if (s.startsWith('INSERT INTO subscription_events')) {
    const [user_id, subscription_id, event_type] = params;
    const row = { user_id, subscription_id, event_type };
    insertedEvents.push(row);
    return { rows: [row] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { WebhookService } = require('./webhookService');
const eventBus = require('../events/eventBus');
const { SubscriptionEventType } = require('../configs/billing');

// Google Play API 호출은 싱글톤 메서드를 직접 몽키패치한다 — 실제 googleapis를 부르지 않는다.
let googleSubscriptionState = null;
WebhookService._getGoogleSubscriptionState = async () => googleSubscriptionState;

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond, detail) { if (cond) pass++; else { fail++; failures.push(detail ? `${desc}: ${detail}` : desc); } }

/** fn 실행 중 eventBus의 subscription:* emit을 모두 캡처한다(emitBinderIdRegression.test.js와 동일 패턴). */
async function captureSubscriptionEvents(fn) {
  const captured = [];
  const names = ['subscription:created', 'subscription:grace_period', 'subscription:expired', 'subscription:refunded'];
  const handlers = names.map((name) => {
    const h = (payload) => captured.push({ event: name, payload });
    eventBus.on(name, h);
    return [name, h];
  });
  try {
    await fn();
  } finally {
    handlers.forEach(([name, h]) => eventBus.off(name, h));
  }
  return captured;
}

async function run() {
  // ============ ① Apple SUBSCRIBED — 정상 신규 구독: DB 반영 + subscription:created emit ============
  reset();
  {
    const events = await captureSubscriptionEvents(() => WebhookService.handleAppleNotification({
      notificationType: 'SUBSCRIBED',
      subtype: 'INITIAL_BUY',
      data: {
        signedTransactionInfo: {
          appAccountToken: 'user-1', transactionId: 'tx-1', originalTransactionId: 'otx-1',
          productId: 'com.app.premium.monthly', inAppOwnershipType: 'PURCHASED',
          purchaseDate: '2026-08-01T00:00:00.000Z', expiresDate: '2026-09-01T00:00:00.000Z',
        },
      },
    }));
    check('① 구독이 생성된다', insertedSubscriptions.length === 1 && insertedSubscriptions[0].user_id === 'user-1');
    check('① subscription_events에 SUBSCRIBED가 기록된다', insertedEvents.some((e) => e.event_type === SubscriptionEventType.SUBSCRIBED));
    check("① eventBus.emit('subscription:created')가 발생한다", events.some((e) => e.event === 'subscription:created' && e.payload.user_id === 'user-1'));
  }

  // ============ ② 멱등성(핵심) — 같은 transaction_id 재수신은 아무 것도 하지 않는다 ============
  // Apple/Google 웹훅은 실제로 재전송된다. transaction_id UNIQUE(ON CONFLICT DO NOTHING)가
  // 이를 막는 유일한 방어선이다 — 이게 깨지면 재전송마다 구독이 새로 만들어지거나 이벤트가
  // 중복 기록된다.
  reset();
  {
    const payload = {
      notificationType: 'SUBSCRIBED', subtype: 'INITIAL_BUY',
      data: {
        signedTransactionInfo: {
          appAccountToken: 'user-2', transactionId: 'tx-dup', originalTransactionId: 'otx-2',
          productId: 'com.app.premium.monthly', inAppOwnershipType: 'PURCHASED',
          purchaseDate: '2026-08-01T00:00:00.000Z', expiresDate: '2026-09-01T00:00:00.000Z',
        },
      },
    };
    await WebhookService.handleAppleNotification(payload); // 1차 — 정상 처리
    const countAfterFirst = insertedSubscriptions.length;
    const events = await captureSubscriptionEvents(() => WebhookService.handleAppleNotification(payload)); // 2차 — 재전송(동일 transactionId)
    check('② 재전송 시 구독이 또 만들어지지 않는다', insertedSubscriptions.length === countAfterFirst, `1차 후=${countAfterFirst} 2차 후=${insertedSubscriptions.length}`);
    check('② 재전송 시 subscription_events도 추가되지 않는다', insertedEvents.filter((e) => e.event_type === SubscriptionEventType.SUBSCRIBED).length === 1);
    check('② 재전송 시 이벤트가 emit되지 않는다', events.length === 0, `실제=${JSON.stringify(events)}`);
  }

  // ============ ③ FAMILY_SHARED — 영수증은 기록되지만 개별 구독은 만들지 않는다(비즈니스 규칙) ============
  reset();
  {
    await WebhookService.handleAppleNotification({
      notificationType: 'SUBSCRIBED', subtype: 'INITIAL_BUY',
      data: {
        signedTransactionInfo: {
          appAccountToken: 'user-3', transactionId: 'tx-family', originalTransactionId: 'otx-3',
          productId: 'com.app.premium.monthly', inAppOwnershipType: 'FAMILY_SHARED',
          purchaseDate: '2026-08-01T00:00:00.000Z', expiresDate: '2026-09-01T00:00:00.000Z',
        },
      },
    });
    check('③ 영수증 로그는 남는다(멱등성 게이트 자체는 통과)', insertedReceiptLogs.some((r) => r.transaction_id === 'tx-family'));
    check('③ FAMILY_SHARED는 구독을 만들지 않는다', insertedSubscriptions.length === 0);
  }

  // ============ ④ 알 수 없는 productId — 방어적 처리(크래시 없음, 구독 미생성) ============
  reset();
  {
    await WebhookService.handleAppleNotification({
      notificationType: 'SUBSCRIBED', subtype: 'INITIAL_BUY',
      data: {
        signedTransactionInfo: {
          appAccountToken: 'user-4', transactionId: 'tx-unknown-product', originalTransactionId: 'otx-4',
          productId: 'com.app.unknown.plan', inAppOwnershipType: 'PURCHASED',
          purchaseDate: '2026-08-01T00:00:00.000Z', expiresDate: '2026-09-01T00:00:00.000Z',
        },
      },
    });
    check('④ 알 수 없는 productId는 구독을 만들지 않는다(크래시 없이 조용히 스킵)', insertedSubscriptions.length === 0);
  }

  // ============ ⑤ signedTransactionInfo 없는 페이로드 — 크래시 없이 조용히 무시(방어적) ============
  reset();
  {
    let threw = false;
    try { await WebhookService.handleAppleNotification({ notificationType: 'SUBSCRIBED', data: {} }); } catch { threw = true; }
    check('⑤ signedTransactionInfo 없는 페이로드는 예외를 던지지 않는다', !threw);
    check('⑤ DB에 아무 것도 쓰지 않는다', insertedReceiptLogs.length === 0 && insertedSubscriptions.length === 0);
  }

  // ============ ⑥ 알 수 없는 notificationType — 방어적 처리(forward-compat) ============
  reset();
  {
    let threw = false;
    try { await WebhookService.handleAppleNotification({ notificationType: 'SOME_FUTURE_TYPE_APPLE_ADDS_LATER', data: { signedTransactionInfo: { transactionId: 'tx-x' } } }); } catch { threw = true; }
    check('⑥ 모르는 notificationType은 예외를 던지지 않는다(Apple이 새 타입을 추가해도 죽지 않는다)', !threw);
  }

  // ============ ⑦ DID_RENEW — 알 수 없는 originalTransactionId(구독을 못 찾음) — 방어적 처리 ============
  reset();
  {
    let threw = false;
    try {
      await WebhookService.handleAppleNotification({
        notificationType: 'DID_RENEW',
        data: { signedTransactionInfo: { transactionId: 'tx-renew-orphan', originalTransactionId: 'otx-does-not-exist', purchaseDate: NOW, expiresDate: NOW } },
      });
    } catch { threw = true; }
    check('⑦ 존재하지 않는 구독의 갱신 알림은 예외 없이 무시된다', !threw);
    check('⑦ 존재하지 않는 구독에 대해 영수증도 기록하지 않는다(구독 조회 실패가 먼저)', insertedReceiptLogs.length === 0);
  }

  // ============ ⑧ REFUND — 구독을 만료 처리 + REFUNDED 이벤트 + subscription:refunded emit ============
  reset();
  {
    subscriptionsByOriginalTxId['otx-refund'] = { id: 'sub-refund', user_id: 'user-8', original_transaction_id: 'otx-refund', status: 'ACTIVE' };
    const events = await captureSubscriptionEvents(() => WebhookService.handleAppleNotification({
      notificationType: 'REFUND',
      data: { signedTransactionInfo: { transactionId: 'tx-refund', originalTransactionId: 'otx-refund', revocationDate: NOW, revocationReason: 1 } },
    }));
    check('⑧ 구독이 EXPIRED로 처리된다', expiredIds.includes('sub-refund'));
    check('⑧ REFUNDED 이벤트가 기록된다', insertedEvents.some((e) => e.event_type === SubscriptionEventType.REFUNDED && e.subscription_id === 'sub-refund'));
    check("⑧ eventBus.emit('subscription:refunded')가 발생한다", events.some((e) => e.event === 'subscription:refunded' && e.payload.user_id === 'user-8'));
  }

  // ============ ⑨ Google — 사용자 식별 불가(신규 구독인데 obfuscatedExternalAccountId 없음) — 방어적 ============
  reset();
  {
    googleSubscriptionState = { startTime: NOW, expiryTime: NOW }; // obfuscatedExternalAccountId 없음
    let threw = false;
    try {
      await WebhookService.handleGoogleNotification({
        subscriptionNotification: { purchaseToken: 'ptok-1', subscriptionId: 'app_premium_monthly', notificationType: 4 },
      });
    } catch { threw = true; }
    check('⑨ 사용자 식별 불가 시 예외 없이 무시된다', !threw);
    check('⑨ 사용자 식별 불가 시 구독을 만들지 않는다', insertedSubscriptions.length === 0);
  }

  // ============ ⑩ Google SUBSCRIPTION_PURCHASED — 정상 신규 구독 ============
  reset();
  {
    googleSubscriptionState = { startTime: '2026-08-01T00:00:00.000Z', expiryTime: '2026-09-01T00:00:00.000Z', obfuscatedExternalAccountId: 'user-10' };
    const events = await captureSubscriptionEvents(() => WebhookService.handleGoogleNotification({
      subscriptionNotification: { purchaseToken: 'ptok-10', subscriptionId: 'app_premium_monthly', notificationType: 4 },
    }));
    check('⑩ 구독이 생성된다', insertedSubscriptions.length === 1 && insertedSubscriptions[0].user_id === 'user-10');
    check("⑩ eventBus.emit('subscription:created')가 발생한다", events.some((e) => e.event === 'subscription:created'));
  }

  console.log(`\n[webhookServiceRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[webhookServiceRegression] 실행 실패:', error);
  process.exitCode = 1;
});
