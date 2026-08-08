/**
 * src/daos/notificationBulkDeleteSyncRegression.test.js
 * =========================================
 * RLY-20260806-216 — User 판정: "오래된 알림 삭제"(SC-notifications.md E22 — 알림함 헤더의
 * "오래된 알림 삭제(30일 이상)")가 지금은 클라 로컬(NotificationsDao.softDeleteOlderThan)
 * 에서만 일어나고 서버 API가 없다(RLY-20260806-213 발견). "서버에도 알려 모든 기기에서
 * 지운다" — 이 파일이 그 서버 경로(NotificationDAO.softDeleteOlderThan)와, 그게 다른
 * 기기로 실제로 전파되는지(SyncDAO.getNotifications)를 함께 검증한다.
 *
 * 기준: 클라 NotificationsActions.deleteOlderThan30Days()가 쓰는 것과 정확히 같다 —
 * recipient 소유·created_at 기준 30일 이전·읽음 여부 무관(lib/presentation/controller/
 * notifications/notifications_notifier.dart 직접 확인, 클라 코드는 읽기만 했다).
 *
 * ⚠️ 핵심 발견(이 파일이 증명) — `SyncDAO.getNotifications`가 원래 `created_at > $2`로
 * 델타를 걸렀다. 이 파일의 다른 모든 델타 쿼리는 `updated_at`을 쓰는데(파일 내 20여 곳)
 * notifications만 예외였고, schema.sql의 `idx_noti_sync(recipient_id, updated_at)` 인덱스는
 * 애초에 그 용도로 만들어져 있었다. `created_at` 그대로였다면 오늘 일괄 삭제해도
 * "오래전에 생성된" 행이라 델타에 다시는 안 잡혀 다른 기기가 영원히 이전 상태로 남는다 —
 * "모든 기기에서 지운다"는 목적 자체가 무산된다. `updated_at`으로 고쳤다(같은 Task).
 *
 * mock이 실제로 무엇을 검증하는지 확인(RLY-20260806-135 교훈) — 아래 모든 시나리오는
 * 프로덕션 코드를 임시로 되돌려(cp 백업 + 복원) 실제로 실패하는지 확인했다(구현
 * 보고서 참조) — 특히 ⑤(동기화 전파)가 이번 Task의 핵심이라 가장 공들여 확인했다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert 없이 check() 헬퍼 + `node <file>.js`.
 * config/db를 가짜로 교체(sendAlertTwoChannelRegression.test.js와 동일 패턴) — SQL
 * 텍스트 자체를 매칭해 JS가 독자적으로 판단하지 않게 한다.
 *
 * 실행: node src/daos/notificationBulkDeleteSyncRegression.test.js
 */

process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test';
process.env.PGDATABASE = process.env.PGDATABASE || 'test';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test';

const dbPath = require.resolve('../../config/db');
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

// ── 픽스처: u1의 알림 2건(오래된 것·최근 것) + u2(다른 사용자)의 오래된 알림 1건 ──
function makeNotification(id, recipientId, ageDays) {
  const t = new Date(NOW - ageDays * DAY);
  return { id, recipient_id: recipientId, created_at: t, updated_at: t, deleted_at: null, is_read: false };
}
let notifications;
function resetFixtures() {
  notifications = {
    n1: makeNotification('n1', 'u1', 40), // u1 소유, 40일 전 — 삭제 대상
    n2: makeNotification('n2', 'u1', 10), // u1 소유, 10일 전 — 기준 밖(남아야 함)
    n3: makeNotification('n3', 'u2', 40), // u2 소유, 40일 전 — 남의 것(안 건드려야 함)
  };
}
resetFixtures();

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();

  // NotificationDAO.softDeleteOlderThan — SQL 텍스트에 deleted_at IS NULL 가드까지 확인한다.
  if (s.startsWith('UPDATE notifications') && s.includes('SET deleted_at = now(), updated_at = now()')
    && s.includes('WHERE recipient_id = $1 AND created_at < $2 AND deleted_at IS NULL')) {
    const [recipientId, cutoff] = params;
    for (const n of Object.values(notifications)) {
      if (n.recipient_id === recipientId && n.created_at < cutoff && !n.deleted_at) {
        n.deleted_at = new Date();
        n.updated_at = new Date();
      }
    }
    return { rows: [] };
  }
  // SyncDAO.getNotifications — ⚠️ updated_at 기준인지 SQL 텍스트로 확인한다(RLY-20260806-135
  // 교훈 — created_at 기준으로 되돌아가도 이 mock이 계속 통과하면 이 회귀는 아무것도
  // 증명하지 못한다).
  if (s.startsWith('SELECT * FROM notifications') && s.includes('WHERE recipient_id = $1 AND updated_at > $2')) {
    const [recipientId, since] = params;
    const rows = Object.values(notifications)
      .filter((n) => n.recipient_id === recipientId && n.updated_at > since)
      .sort((a, b) => b.updated_at - a.updated_at);
    return { rows };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { NotificationDAO } = require('./notificationDAO');
const { SyncDAO } = require('./syncDAO');

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond, detail) { if (cond) pass++; else { fail++; failures.push(detail ? `${desc}: ${detail}` : desc); } }

async function run() {
  const cutoff = new Date(NOW - 30 * DAY); // 클라와 동일한 30일 기준
  // "직전 동기화 시점" — n1(40일 전 생성, 이후 미변경)보다는 뒤, n2(10일 전 생성)보다는 앞.
  // n1은 이 시점 이후로 아무 변화가 없었으므로 삭제 전에는 델타에 잡히지 않아야 하고,
  // n2는 그 자체로 최근이라 델타에 잡혀야 한다(삭제와 무관하게 — 대조군).
  const since = new Date(NOW - 35 * DAY);

  // ============ ①(사전) 삭제 전 델타 — n1은 안 잡히고(오래전 값 그대로) n2만 잡힌다 ============
  {
    const before = await SyncDAO.getNotifications({ query: mockQuery }, 'u1', since);
    check('① 삭제 전: n1은 아직 델타에 안 잡힌다(마지막 동기화 이후 변화 없음)', !before.some((r) => r.id === 'n1'), `실제=${JSON.stringify(before.map((r) => r.id))}`);
    check('① 삭제 전: n2(최근 생성)는 델타에 잡힌다(대조군)', before.some((r) => r.id === 'n2'));
  }

  // ============ ② 일괄 삭제 실행 ============
  await NotificationDAO.softDeleteOlderThan({ query: mockQuery }, 'u1', cutoff);

  // ============ ③ 내 알림만 지운다 — 30일 넘은 내 것(n1)은 deleted_at 설정 ============
  check('③ n1(u1, 40일 전)은 소프트 삭제됐다', !!notifications.n1.deleted_at);

  // ============ ④ 기준 밖 알림은 남는다 — n2(10일 전, u1 소유)는 안 지워진다 ============
  check('④ n2(u1, 10일 전 — 기준 밖)는 지워지지 않는다', !notifications.n2.deleted_at);

  // ============ ⑤(핵심) 남의 알림은 안 건드린다 — n3(u2 소유, 40일 전)는 그대로 ============
  check('⑤ n3(u2 소유, 40일 전)는 recipient_id가 달라 건드려지지 않는다(대조군)', !notifications.n3.deleted_at);

  // ============ ⑥ 하드 삭제가 아니다 — 행 자체는 여전히 존재한다 ============
  check('⑥ 하드 삭제가 아니다 — n1 행이 여전히 존재한다(deleted_at만 설정)', notifications.n1 !== undefined && notifications.n1.id === 'n1');

  // ============ ⑦(이 Task의 핵심) 삭제 후 델타 — n1이 이제 deleted_at과 함께 다른 기기로 전파된다 ============
  {
    const after = await SyncDAO.getNotifications({ query: mockQuery }, 'u1', since);
    const n1After = after.find((r) => r.id === 'n1');
    check('⑦ 삭제 후: n1이 델타에 새로 나타난다(다른 기기가 이 tombstone을 받는다)', !!n1After, `실제=${JSON.stringify(after.map((r) => r.id))}`);
    check('⑦ n1의 deleted_at이 델타 응답에 실제로 실려 있다', n1After && !!n1After.deleted_at, `실제=${n1After && n1After.deleted_at}`);
    const n2After = after.find((r) => r.id === 'n2');
    check('⑦ n2는 여전히 deleted_at 없이 남아 있다(영향 없음 재확인)', n2After && !n2After.deleted_at);
  }

  console.log(`\n[notificationBulkDeleteSyncRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[notificationBulkDeleteSyncRegression] 실행 실패:', error);
  process.exitCode = 1;
});
