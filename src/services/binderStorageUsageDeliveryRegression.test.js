/**
 * src/services/binderStorageUsageDeliveryRegression.test.js
 * =========================================
 * RLY-20260806-099 — 서버는 `binder_storage_usage`를 정확히 유지하지만(mediaService·
 * cleanupJobs가 갱신) 클라에 전달하는 채널이 없었다. `api.md:2276-2289`가 이미 문서화한
 * `GET /binders/:binderId/boost` 응답의 `storage_bytes_used`·`storage_limit_bytes` 필드를
 * `BinderService.getBoost`가 실제로 채우도록 구현했다(그 전엔 인가 통과 후 무조건 501).
 *
 * `SC-binder-files.md` §5 액션A "4. 용량 조회: binder_storage_usage.bytes_used"·§16-5가
 * 이 값의 출처를 이미 확정했고, `api.md`가 전달 endpoint를 이미 규정한다 — 새 endpoint·
 * 새 동기화 채널을 만들지 않고 그 endpoint를 실제로 구현하는 것으로 닫았다.
 *
 * ⚠️ "비멤버에게는 안 간다" — 차단만 단언하면 전부 막아도 통과하므로 대조군(멤버는 통과)을
 * 반드시 넣는다. "아바타·커버 제외가 반영된 값" — S2가 이미 쓰기 시점에 제외했으므로, 이
 * 스위트는 "전달(읽기) 경로가 그 값을 다시 부풀리지 않는가"만 확인한다(별도 계산을 하지
 * 않고 `binder_storage_usage.bytes_used`를 그대로 반환하는지).
 *
 * 이 저장소엔 테스트 프레임워크가 없다 — plain assert + `node <file>.js` 직접 실행.
 *
 * 실행: node src/services/binderStorageUsageDeliveryRegression.test.js
 */

const assert = require('assert');

const dbPath = require.resolve('../../config/db');
const NOW = new Date().toISOString();

const db = {
  binder_members: {},
  binder_boosts: {},
  binder_storage_usage: {},
};

function setMember(binderId, userId, role) {
  db.binder_members[`${binderId}:${userId}`] = {
    binder_id: binderId, user_id: userId, role,
    notification_level: 1, nickname_in_binder: null, joined_at: NOW, deleted_at: null,
  };
}
setMember('bFree', 'member1', 3);
setMember('bBoosted', 'member2', 0);

// bFree — Free tier, 실사용량 있음(아바타·커버는 여기 안 들어가야 한다 — S2가 이미 보장,
// 이 스위트는 그 값을 delivery가 그대로 전달하는지만 본다).
db.binder_storage_usage.bFree = { binder_id: 'bFree', bytes_used: 123456789 };

// bBoosted — Lite tier 활성 Boost.
db.binder_boosts.bBoosted = {
  binder_id: 'bBoosted', tier: 1, status: 'ACTIVE',
  current_period_end: '2026-09-01T00:00:00.000Z',
};
db.binder_storage_usage.bBoosted = { binder_id: 'bBoosted', bytes_used: 555 };

function norm(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

async function mockQuery(sql, params = []) {
  const s = norm(sql);
  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // BinderDAO.getMember
  if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
    const row = db.binder_members[`${params[0]}:${params[1]}`];
    return { rows: row ? [row] : [] };
  }
  // AttachmentDAO.getTier — active(status='ACTIVE') Boost 행만 본다.
  if (s.startsWith('SELECT COALESCE(bb.tier, 0) AS tier')) {
    const [binderId] = params;
    const boost = db.binder_boosts[binderId];
    const tier = boost && boost.status === 'ACTIVE' ? boost.tier : 0;
    return { rows: [{ tier }] };
  }
  // AttachmentDAO.getBytesUsed
  if (s.startsWith('SELECT bytes_used FROM binder_storage_usage')) {
    const row = db.binder_storage_usage[params[0]];
    return { rows: row ? [row] : [] };
  }
  // binderService.getBoost — status·current_period_end
  if (s.startsWith('SELECT status, current_period_end FROM binder_boosts')) {
    const row = db.binder_boosts[params[0]];
    return { rows: row ? [{ status: row.status, current_period_end: row.current_period_end }] : [] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { BinderService } = require('./binderService');

let pass = 0;
let fail = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
  } catch (error) {
    fail += 1;
    failures.push({ name, error });
  }
}

async function run() {
  await check('① 저장 사용량이 클라에 도달한다 — Free tier, 실사용량이 그대로 실린다(0이 아님)', async () => {
    const boost = await BinderService.getBoost('bFree', 'member1');
    assert.strictEqual(boost.storage_bytes_used, 123456789, '이전엔 채널 자체가 없어 항상 0/미도달이었다 — 이제 실제 값이 실려야 한다');
    assert.strictEqual(boost.storage_limit_bytes, 5 * 1024 ** 3, 'Boost 없는 바인더는 Free tier 한도(5GB)여야 한다');
    assert.strictEqual(boost.tier, 0);
    assert.strictEqual(boost.status, null, '활성 Boost 행이 없으면 status는 null이어야 한다(거짓 ACTIVE를 만들지 않는다)');
    assert.strictEqual(boost.current_period_end, null);
  });

  await check('② 활성 Boost가 있는 바인더 — tier·status·current_period_end·한도가 전부 실제 값을 반영한다', async () => {
    const boost = await BinderService.getBoost('bBoosted', 'member2');
    assert.strictEqual(boost.tier, 1);
    assert.strictEqual(boost.status, 'ACTIVE');
    assert.strictEqual(boost.current_period_end, '2026-09-01T00:00:00.000Z');
    assert.strictEqual(boost.storage_bytes_used, 555);
    assert.strictEqual(boost.storage_limit_bytes, 50 * 1024 ** 3, 'Lite tier 한도(50GB)여야 한다');
  });

  await check('③ 비멤버에게는 안 간다 — 403으로 거부(인가는 기존 requireBinderMember 그대로, 변경 없음)', async () => {
    try {
      await BinderService.getBoost('bFree', 'attacker1');
      throw new Error('403을 기대했지만 통과해버림');
    } catch (err) {
      if (err.statusCode !== 403) throw new Error(`403을 기대했지만 status=${err.statusCode} msg=${err.message}`);
    }
  });

  await check('④ 대조군 — ③과 같은 바인더의 실제 멤버는 여전히 통과한다(차단만 단언하는 회귀가 아님을 확인)', async () => {
    const boost = await BinderService.getBoost('bFree', 'member1');
    assert.strictEqual(boost.storage_bytes_used, 123456789);
  });

  await check('⑤ 아바타·커버 제외가 반영된 값이다 — delivery가 binder_storage_usage.bytes_used를 그대로 전달할 뿐 별도로 부풀리지 않는다(S2가 쓰기 시점에 이미 제외한 값)', async () => {
    // bFree.bytes_used(123456789)는 S2·S4가 이미 검증한 대로 아바타·커버가 전혀 반영되지 않은
    // 값이다(confirm()이 엔티티 이미지 3종의 applyStorageDelta를 애초에 건너뛴다 — S2). 이
    // delivery 경로가 그 값을 그대로(가공 없이) 전달하는지만 확인한다 — 별도 SUM이나 재계산을
    // 하면 §16-5가 기각한 "SUM 대안"을 몰래 재도입하는 회귀가 된다.
    const boost = await BinderService.getBoost('bFree', 'member1');
    assert.strictEqual(boost.storage_bytes_used, db.binder_storage_usage.bFree.bytes_used, 'DB의 집계값을 가공 없이 그대로 전달해야 한다');
  });

  console.log(`\n[binderStorageUsageDeliveryRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(` - ${f.name}: ${f.error.stack || f.error.message}`));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[binderStorageUsageDeliveryRegression] 실행 실패:', error);
  process.exitCode = 1;
});
