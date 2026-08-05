/**
 * src/services/storageQuotaRegression.test.js
 * =========================================
 * RLY-20260806-013 (F-S9) 바인더 저장 용량 집계 회귀 스위트.
 *
 * 이 저장소에는 테스트 프레임워크가 없다(`npm test`는 실패하는 placeholder). authzRegression.test.js·
 * sectionCascadeRegression.test.js와 동일한 관행 — plain assert + `node <file>.js` 직접 실행,
 * 가짜 DB connection(require.cache 주입)으로 실제 서비스·DAO 코드를 구동한다.
 *
 * 실제 Postgres가 이 환경에 없어 통합 테스트는 불가능하다. 특히 AC-S9-6(동시 업로드)은 단일 스레드
 * JS 이벤트 루프 위에서 도는 가짜 DB로는 진짜 row-lock 경합을 재현하지 못한다 — 여기서 검증하는 것은
 * "쿼리 형태가 read-then-write가 아니라 단일 원자 UPDATE(ON CONFLICT ... SET x = x + $delta)인가"와
 * "N번의 순차/동시 호출 후 합계가 정확히 맞는가"이지, 실제 Postgres row-lock 자체가 아니다.
 *
 * F-S6(복제 메커니즘 자체)이 아직 착수되지 않았으므로 AC-S9-1(복제)은 F-S6이 만들 것으로 설계된
 * INSERT...SELECT 형태를 이 테스트가 직접 시뮬레이션한다(같은 storage_key를 가진 새 행을 만들고
 * applyStorageDelta를 호출) — 실제 clone 엔드포인트가 아니라 그 엔드포인트가 반드시 지켜야 할
 * 회계 불변식을 검증한다.
 *
 * 실행: node src/services/storageQuotaRegression.test.js
 */

const assert = require('assert');
const Module = require('module');

// src/configs/db.js가 모듈 로드 시점에 PGHOST 등을 eager 검증한다(cleanupJobs.js가 logger를
// 거쳐 간접 참조). 이 스위트는 실제 커넥션을 전혀 만들지 않으므로(config/db.js 자체를 아래에서
// 가짜로 교체) 더미 값으로 그 검증만 통과시킨다.
process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test';
process.env.PGDATABASE = process.env.PGDATABASE || 'test';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test';

const NOW = new Date();
const DAY = 24 * 60 * 60 * 1000;

// ── 가짜 relational state ────────────────────────────────────────────────
const db = {
  binders: {},
  binder_members: {},
  binder_boosts: {},
  binder_storage_usage: {},
  attachments: {},
};

db.binders.b1 = { id: 'b1', deleted_at: null };
db.binder_members['b1:u1'] = { binder_id: 'b1', user_id: 'u1', role: 3, deleted_at: null };

db.binders.b2 = { id: 'b2', deleted_at: null }; // tier 확인용 — Boost Lite 활성
db.binder_members['b2:u1'] = { binder_id: 'b2', user_id: 'u1', role: 3, deleted_at: null };
db.binder_boosts.b2 = { binder_id: 'b2', tier: 1, status: 'ACTIVE' };

db.binders.b3 = { id: 'b3', deleted_at: null }; // 하드 삭제 대상(30일 경과)
db.binders.b3.deleted_at = new Date(NOW.getTime() - 31 * DAY).toISOString();
db.binder_storage_usage.b3 = { binder_id: 'b3', bytes_used: 999 };

let nextAttId = 1;
function insertAttachment({ binder_id, storage_key, file_size, uploader_id, status = 'pending', deleted_at = null }) {
  const id = `att-${nextAttId++}`;
  db.attachments[id] = { id, binder_id, storage_key, file_size, uploader_id, status, deleted_at };
  return id;
}

const queryLog = [];

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  queryLog.push({ sql: s, params });

  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // BinderDAO.getMember (requireBinderMember)
  if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
    const row = db.binder_members[`${params[0]}:${params[1]}`];
    return { rows: row ? [row] : [] };
  }

  // AttachmentDAO.findById
  if (s.startsWith('SELECT * FROM attachments WHERE id = $1 AND deleted_at IS NULL')) {
    const row = db.attachments[params[0]];
    return { rows: row && !row.deleted_at ? [row] : [] };
  }

  // MediaService.confirm — RLY-20260806-015 사전 확인(pending 소유 검증, GCS 호출 전)
  if (s.startsWith('SELECT id, binder_id, storage_key, file_size FROM attachments WHERE id = $1 AND uploader_id = $2 AND status = \'pending\'')) {
    const [id, uploaderId] = params;
    const att = db.attachments[id];
    if (!att || att.uploader_id !== uploaderId || att.status !== 'pending') return { rows: [] };
    return { rows: [{ id: att.id, binder_id: att.binder_id, storage_key: att.storage_key, file_size: att.file_size }] };
  }

  // MediaService._rejectAndCleanup
  if (s.startsWith("UPDATE attachments SET status = 'rejected'")) {
    const [id] = params;
    const att = db.attachments[id];
    if (!att || att.status !== 'pending') return { rows: [] };
    att.status = 'rejected';
    return { rows: [{ ...att }] };
  }

  // MediaService.presign — INSERT INTO attachments
  if (s.startsWith('INSERT INTO attachments')) {
    const [id, binder_id, , , storage_key, , file_size, , uploader_id] = params;
    db.attachments[id] = {
      id, binder_id, storage_key, file_size, uploader_id, status: 'pending', deleted_at: null,
    };
    return { rows: [], rowCount: 1 };
  }

  // MediaService.confirm — 최종 확정(RLY-20260806-015: file_size를 실제 재확인 값으로 갱신)
  if (s.startsWith("UPDATE attachments SET status = 'ready'")) {
    const [id, uploaderId, actualSize] = params;
    const att = db.attachments[id];
    if (!att || att.uploader_id !== uploaderId || att.status !== 'pending') return { rows: [] };
    att.status = 'ready';
    att.file_size = actualSize;
    return { rows: [{ ...att }] };
  }

  // MediaService.deleteAttachment (본인 업로드)
  if (s.startsWith('UPDATE attachments SET deleted_at = now(), updated_at = now()') && s.includes('uploader_id = $2')) {
    const [id, uploaderId] = params;
    const att = db.attachments[id];
    if (!att || att.uploader_id !== uploaderId || att.deleted_at) return { rows: [] };
    att.deleted_at = NOW.toISOString();
    return { rows: [{ id: att.id, binder_id: att.binder_id, storage_key: att.storage_key, file_size: att.file_size }] };
  }

  // AttachmentDAO.softDelete (BinderService master/manager 경로)
  if (s.startsWith('UPDATE attachments SET deleted_at = now(), updated_at = now()') && !s.includes('uploader_id')) {
    const [id] = params;
    const att = db.attachments[id];
    if (!att || att.deleted_at) return { rows: [] };
    att.deleted_at = NOW.toISOString();
    return { rows: [{ id: att.id, binder_id: att.binder_id, storage_key: att.storage_key, file_size: att.file_size }] };
  }

  // AttachmentDAO.applyStorageDelta — 경계 판정
  if (s.includes('AS is_boundary')) {
    const [binderId, storageKey, excludeId] = params;
    const isOther = Object.values(db.attachments).some(
      (a) => a.binder_id === binderId && a.storage_key === storageKey && !a.deleted_at && a.id !== excludeId
    );
    return { rows: [{ is_boundary: !isOther }] };
  }

  // AttachmentDAO.applyStorageDelta — 원자 upsert
  if (s.startsWith('INSERT INTO binder_storage_usage')) {
    const [binderId, delta] = params;
    if (!db.binder_storage_usage[binderId]) {
      db.binder_storage_usage[binderId] = { binder_id: binderId, bytes_used: delta };
    } else {
      db.binder_storage_usage[binderId].bytes_used += delta;
    }
    return { rows: [] };
  }

  // AttachmentDAO.getBytesUsed
  if (s.startsWith('SELECT bytes_used FROM binder_storage_usage')) {
    const row = db.binder_storage_usage[params[0]];
    return { rows: row ? [row] : [] };
  }

  // AttachmentDAO.getStorageLimitBytes
  if (s.includes('FROM binders b') && s.includes('binder_boosts bb')) {
    const boost = db.binder_boosts[params[0]];
    const tier = boost && boost.status === 'ACTIVE' ? boost.tier : 0;
    return { rows: [{ tier }] };
  }

  // cleanupJobs — attachments 하드 삭제 (F-S9 관점: bytes_used를 절대 건드리지 않아야 한다)
  if (s.startsWith('DELETE FROM attachments WHERE deleted_at IS NOT NULL')) {
    let count = 0;
    for (const [id, att] of Object.entries(db.attachments)) {
      if (att.deleted_at && new Date(att.deleted_at).getTime() < NOW.getTime() - 30 * DAY) {
        delete db.attachments[id];
        count += 1;
      }
    }
    return { rowCount: count };
  }

  // cleanupJobs — binder_storage_usage 정리 (F-S9 신설 스텝)
  if (s.startsWith('DELETE FROM binder_storage_usage')) {
    let count = 0;
    for (const [binderId, binder] of Object.entries(db.binders)) {
      if (binder.deleted_at && new Date(binder.deleted_at).getTime() < NOW.getTime() - 30 * DAY) {
        if (db.binder_storage_usage[binderId]) {
          delete db.binder_storage_usage[binderId];
          count += 1;
        }
      }
    }
    return { rowCount: count };
  }

  // cleanupJobs — 나머지 테이블 스텝(이 스위트의 관심사가 아님) — 안전한 no-op
  if (s.startsWith('DELETE FROM')) {
    return { rowCount: 0 };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
}

const mockDb = {
  query: mockQuery,
  connect: async () => ({ query: mockQuery, release() {} }),
};

const dbPath = require.resolve('../../config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

// ── @google-cloud/storage 스텁 — presign/confirm/delete 해피패스가 실제 GCS를 부르지 않게 ──
// RLY-20260806-015 — confirm의 getMetadata() 실제 크기 재확인 경로 검증용. 기본값은 db.attachments의
// file_size(선언값)와 동일하게 응답해(=재확인 통과) 기존 회귀의 델타 기대값을 그대로 유지하고,
// 개별 테스트가 gcsSizeOverrides로 storage_key별 응답(실제 크기 불일치·404·네트워크 오류)을 주입한다.
const gcsSizeOverrides = {};
const gcsDeleteLog = [];

const gcsStub = {
  Storage: class {
    bucket() {
      return {
        file(storageKey) {
          return {
            async generateSignedPostPolicyV4() { return ['https://fake-upload-url']; },
            async getSignedUrl() { return ['https://fake-signed-url']; },
            async delete() { gcsDeleteLog.push(storageKey); },
            async copy() {},
            async getMetadata() {
              const override = gcsSizeOverrides[storageKey];
              if (override && override.notFound) {
                const err = new Error('No such object');
                err.code = 404;
                throw err;
              }
              if (override && override.networkError) {
                throw new Error('ECONNRESET (fake)');
              }
              if (typeof override === 'number') {
                return [{ size: String(override) }];
              }
              const att = Object.values(db.attachments).find(
                (a) => a.storage_key === storageKey && !a.deleted_at
              );
              const size = att ? Number(att.file_size) || 0 : 0;
              return [{ size: String(size) }];
            },
          };
        },
      };
    }
  },
};
const originalLoad = Module._load;
Module._load = function loadWithStubs(request, parent, isMain) {
  if (request === '@google-cloud/storage') return gcsStub;
  return originalLoad.call(this, request, parent, isMain);
};

const { AttachmentDAO } = require('../daos/attachmentDAO');
const { MediaService } = require('./mediaService');
const { BinderService } = require('./binderService');
const { runCleanup } = require('../jobs/cleanupJobs');

const ctx = (userId) => ({ sender_id: userId, device_uuid: 'dev-1' });

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

async function expectStatus(name, fn, statusCode, errorCode) {
  await check(name, async () => {
    try {
      await fn();
      throw new Error('expected to throw but did not');
    } catch (error) {
      assert.strictEqual(error.statusCode, statusCode, `statusCode: ${error.message}`);
      if (errorCode) assert.strictEqual(error.errorCode, errorCode);
    }
  });
}

async function run() {
  // ═══════════════════════════════════════════════════════════════
  // AC-S9-1·2·3 — 복제 승계·비경계 삭제·경계 삭제 (같은 storage_key 두 행)
  // ═══════════════════════════════════════════════════════════════
  const KEY_SHARED = 'attachments/b1/2026/08/shared.png';
  const idA1 = insertAttachment({ binder_id: 'b1', storage_key: KEY_SHARED, file_size: 100, uploader_id: 'u1' });
  await check('confirm(A1) → +100', async () => {
    await MediaService.confirm(idA1, ctx('u1'));
    assert.strictEqual(db.binder_storage_usage.b1.bytes_used, 100);
  });

  // F-S6이 만들 clone INSERT...SELECT를 시뮬레이션: 같은 binder·같은 storage_key로 새 행 생성.
  const idA2 = insertAttachment({ binder_id: 'b1', storage_key: KEY_SHARED, file_size: 100, uploader_id: 'u1', status: 'ready' });
  await check('AC-S9-1 — 복제로 행이 늘어도 bytes_used 불변', async () => {
    const delta = await AttachmentDAO.applyStorageDelta(mockDb, {
      binderId: 'b1', storageKey: KEY_SHARED, fileSize: 100, attachmentId: idA2, sign: 1,
    });
    assert.strictEqual(delta, 0);
    assert.strictEqual(db.binder_storage_usage.b1.bytes_used, 100);
  });

  await check('AC-S9-2 — 둘 중 하나(A1) 삭제해도 bytes_used 불변(A2가 남아 있음)', async () => {
    await MediaService.deleteAttachment(idA1, 'u1');
    assert.strictEqual(db.binder_storage_usage.b1.bytes_used, 100);
    assert.ok(db.attachments[idA1].deleted_at);
  });

  await check('AC-S9-3 — 마지막(A2) 삭제 시에만 bytes_used 감소', async () => {
    await BinderService.deleteAttachment('b1', idA2, 'u1'); // master/manager 경로(다른 코드 경로도 같은 회계를 따르는지 확인)
    assert.strictEqual(db.binder_storage_usage.b1.bytes_used, 0);
  });

  // ═══════════════════════════════════════════════════════════════
  // AC-S9-4 — 하드 삭제(cleanupJobs)가 bytes_used를 건드리지 않는다
  // ═══════════════════════════════════════════════════════════════
  db.attachments[idA1].deleted_at = new Date(NOW.getTime() - 31 * DAY).toISOString();
  db.attachments[idA2].deleted_at = new Date(NOW.getTime() - 31 * DAY).toISOString();
  await check('AC-S9-4 — 하드 삭제 전후 bytes_used 불변(이중 차감 없음)', async () => {
    const before = db.binder_storage_usage.b1.bytes_used;
    await runCleanup();
    assert.strictEqual(db.attachments[idA1], undefined, '30일 경과 행은 물리 삭제되어야 한다');
    assert.strictEqual(db.attachments[idA2], undefined);
    assert.strictEqual(db.binder_storage_usage.b1.bytes_used, before);
  });

  await check('AC — 바인더 삭제 시 binder_storage_usage 행도 정리된다(cleanupJobs 신설 스텝)', async () => {
    assert.strictEqual(db.binder_storage_usage.b3, undefined, 'b3는 30일 경과 hard-delete 대상 — 위 runCleanup에서 정리되어 있어야 한다');
  });

  // ═══════════════════════════════════════════════════════════════
  // AC-S9-7 — soft delete 즉시 감소 + 30일 내 복원 시 왕복 후 원값
  // ═══════════════════════════════════════════════════════════════
  const KEY_R = 'attachments/b1/2026/08/restore.png';
  const idR = insertAttachment({ binder_id: 'b1', storage_key: KEY_R, file_size: 50, uploader_id: 'u1' });
  await MediaService.confirm(idR, ctx('u1'));
  await check('AC-S9-7 — soft delete 즉시 감소', async () => {
    assert.strictEqual(db.binder_storage_usage.b1.bytes_used, 50);
    await MediaService.deleteAttachment(idR, 'u1');
    assert.strictEqual(db.binder_storage_usage.b1.bytes_used, 0);
  });
  await check('AC-S9-7 — 30일 내 복원 시 다시 가산(왕복 후 원값)', async () => {
    // 첨부 복원 UX는 V1.1+ 검토(SC-binder-files.md:465) — 아직 REST 엔드포인트가 없다.
    // 회계 불변식만 검증: soft delete를 되돌리는 행위가 이 함수를 거쳐야 한다는 계약을 고정한다.
    db.attachments[idR].deleted_at = null;
    await AttachmentDAO.applyStorageDelta(mockDb, {
      binderId: 'b1', storageKey: KEY_R, fileSize: 50, attachmentId: idR, sign: 1,
    });
    assert.strictEqual(db.binder_storage_usage.b1.bytes_used, 50, '삭제 전 원값으로 정확히 복귀해야 한다');
  });

  // ═══════════════════════════════════════════════════════════════
  // AC-S9-6 — 동시 업로드 N건 후 bytes_used == 개별 file_size 합 (경합 손실 없음)
  // ═══════════════════════════════════════════════════════════════
  await check('AC-S9-6 — 원자 갱신 쿼리 형태(read-then-write 아님)', async () => {
    const upsert = queryLog.map((q) => q.sql).find((sql) => sql.startsWith('INSERT INTO binder_storage_usage'));
    assert.ok(upsert, 'upsert 쿼리가 실행된 적이 있어야 한다');
    assert.ok(
      upsert.includes('bytes_used = binder_storage_usage.bytes_used + $2'),
      '읽어서 계산한 값을 쓰는 게 아니라 DB가 직접 加算해야 한다(원자성)'
    );
  });
  await check('AC-S9-6 — 동시 confirm N건 후 합계 정확(경합 손실 없음)', async () => {
    const before = db.binder_storage_usage.b1.bytes_used; // 앞 시나리오(복원된 idR 등) 잔여값은 그대로 둔다 — 실제 회계는 리셋되지 않는다
    const sizes = [10, 20, 30, 40, 50];
    const ids = sizes.map((size) => insertAttachment({ binder_id: 'b1', storage_key: `k-concurrent-${size}`, file_size: size, uploader_id: 'u1' }));
    await Promise.all(ids.map((id) => MediaService.confirm(id, ctx('u1'))));
    const expectedDelta = sizes.reduce((a, b) => a + b, 0);
    assert.strictEqual(db.binder_storage_usage.b1.bytes_used - before, expectedDelta);
  });

  // ═══════════════════════════════════════════════════════════════
  // §2 집계 쿼리와의 정합 (AC-S9-5 — R22는 별도 Task이므로 여기서는 §2 산식과 내 증분값이
  // 일치한다는 것만 확인한다. R22 자체의 대조 job은 이 Task 범위가 아니다)
  // ═══════════════════════════════════════════════════════════════
  await check('§2 집계 쿼리 산식과 증분값 일치 (R22가 쓸 산식의 사전 검증)', async () => {
    const activeByKey = new Map();
    for (const att of Object.values(db.attachments)) {
      if (att.binder_id === 'b1' && !att.deleted_at) {
        activeByKey.set(att.storage_key, att.file_size); // DISTINCT ON (storage_key)
      }
    }
    const recomputed = [...activeByKey.values()].reduce((a, b) => a + b, 0);
    assert.strictEqual(db.binder_storage_usage.b1.bytes_used, recomputed);
  });

  // ═══════════════════════════════════════════════════════════════
  // AC-S9-8 — 402: bytes_used + file_size가 tier 한도 초과 시 업로드 거부(Free 5GB 기준)
  // ═══════════════════════════════════════════════════════════════
  const FREE_LIMIT = 5 * 1024 ** 3;
  db.binder_storage_usage.b1.bytes_used = FREE_LIMIT - 100; // 5GB에서 100바이트 남음

  await expectStatus(
    'AC-S9-8 — 한도 초과 업로드 402(BOOST_STORAGE_LIMIT)',
    () => MediaService.presign(
      { context_type: 'EVENT', context_id: 'e1', binder_id: 'b1', filename: 'big.mp4', content_type: 'video/mp4', file_size: 200 },
      ctx('u1')
    ),
    402,
    'BOOST_STORAGE_LIMIT'
  );

  await check('한도 이내 업로드는 통과(presign 성공)', async () => {
    const result = await MediaService.presign(
      { context_type: 'EVENT', context_id: 'e1', binder_id: 'b1', filename: 'small.png', content_type: 'image/png', file_size: 50 },
      ctx('u1')
    );
    assert.ok(result.id && result.upload_url);
  });

  await check('Boost Lite(tier=1) 바인더는 50GB 한도로 통과(Free라면 402였을 크기)', async () => {
    const overFreeUnderLite = 10 * 1024 ** 3; // 10GB — Free는 거부, Lite(50GB)는 통과
    const result = await MediaService.presign(
      { context_type: 'EVENT', context_id: 'e1', binder_id: 'b2', filename: 'huge.mp4', content_type: 'video/mp4', file_size: overFreeUnderLite },
      ctx('u1')
    );
    assert.ok(result.id);
  });

  // ═══════════════════════════════════════════════════════════════
  // RLY-20260806-015 — confirm 실제 크기 서버 재확인
  // ═══════════════════════════════════════════════════════════════
  db.binder_storage_usage.b1.bytes_used = 0; // 이전 시나리오 잔여값 리셋 — 이 블록은 절대값으로 단언한다

  await check('실제 크기 재확인 — 편차가 tolerance 이내면 실제 값(선언값 아님)으로 file_size·회계 반영', async () => {
    const key = 'attachments/b1/2026/08/close-match.png';
    const id = insertAttachment({ binder_id: 'b1', storage_key: key, file_size: 100, uploader_id: 'u1' });
    gcsSizeOverrides[key] = 105; // declared=100, actual=105 — ±10% 이내(105 <= 110)
    await MediaService.confirm(id, ctx('u1'));
    assert.strictEqual(db.attachments[id].file_size, 105, 'file_size가 실제 값으로 갱신되어야 한다');
    assert.strictEqual(db.binder_storage_usage.b1.bytes_used, 105, '회계도 실제 값으로 반영되어야 한다(선언값 100이 아님)');
  });

  {
    const key = 'attachments/b1/2026/08/fraud-declare.png';
    const id = insertAttachment({ binder_id: 'b1', storage_key: key, file_size: 1, uploader_id: 'u1' });
    gcsSizeOverrides[key] = 5 * 1024 ** 3; // 선언값 1바이트, 실제 5GB — 전형적 선언값 위조 시나리오
    const before = db.binder_storage_usage.b1.bytes_used;
    await expectStatus(
      '실제 크기가 선언값 대비 ±10% 초과 시 422 거부(ATTACHMENT_SIZE_MISMATCH)',
      () => MediaService.confirm(id, ctx('u1')),
      422,
      'ATTACHMENT_SIZE_MISMATCH'
    );
    await check('위 거부 후 — attachment rejected + GCS 객체 삭제 + bytes_used 불변', async () => {
      assert.strictEqual(db.attachments[id].status, 'rejected');
      assert.ok(gcsDeleteLog.includes(key), 'GCS 객체가 삭제 호출되어야 한다');
      assert.strictEqual(db.binder_storage_usage.b1.bytes_used, before, '거부된 첨부는 회계에 반영되지 않아야 한다');
    });
  }

  {
    // §2 Orchestrator 확정(2026-08-06): ±10% tolerance 이내면 한도를 근소 초과해도 거부하지 않는다 —
    // 위조 방어는 편차 검사가 이미 담당하고, 남는 것은 선의의 오차뿐이므로 사용자 데이터를 지우지 않는다.
    // 실제 값으로 집계하고 confirm은 통과시키며, 한도 초과 상태는 다음 presign이 402로 막아 자연 수렴한다.
    const key = 'attachments/b1/2026/08/over-limit.png';
    const declared = 100;
    const id = insertAttachment({ binder_id: 'b1', storage_key: key, file_size: declared, uploader_id: 'u1' });
    // presign 시점엔 통과했을 값(선언값 기준 딱 한도)이지만 실제 크기 반영 시 한도를 넘기도록 세팅.
    db.binder_storage_usage.b1.bytes_used = FREE_LIMIT - declared;
    gcsSizeOverrides[key] = declared + 5; // 실제는 5바이트 더 큼(±10% 이내) — 한도 초과로 전환

    await check('실제 크기가 tolerance 이내면서 한도를 근소 초과해도 confirm은 통과 + 실제 값으로 집계', async () => {
      await MediaService.confirm(id, ctx('u1'));
      assert.strictEqual(db.attachments[id].status, 'ready', '근소 초과로 거부하지 않는다');
      assert.strictEqual(db.attachments[id].file_size, declared + 5, '실제 값으로 file_size 갱신');
      assert.strictEqual(db.binder_storage_usage.b1.bytes_used, FREE_LIMIT + 5, '실제 값 그대로 집계(한도 초과 상태 허용)');
      assert.ok(!gcsDeleteLog.includes(key), '수용 경로이므로 GCS 객체를 삭제하지 않는다');
    });

    await expectStatus(
      '한도 초과 상태가 남으면 다음 presign이 402로 막아 자연 수렴한다',
      () => MediaService.presign(
        { context_type: 'EVENT', context_id: 'e1', binder_id: 'b1', filename: 'next.png', content_type: 'image/png', file_size: 1 },
        ctx('u1')
      ),
      402,
      'BOOST_STORAGE_LIMIT'
    );
  }

  {
    const key = 'attachments/b1/2026/08/gcs-down.png';
    const id = insertAttachment({ binder_id: 'b1', storage_key: key, file_size: 100, uploader_id: 'u1' });
    gcsSizeOverrides[key] = { networkError: true };
    const before = db.binder_storage_usage.b1.bytes_used;
    await expectStatus(
      'GCS 메타데이터 조회 실패(네트워크 등 일시 장애) 시 503 — 선언값으로 조용히 대체하지 않는다',
      () => MediaService.confirm(id, ctx('u1')),
      503,
      'ATTACHMENT_VERIFY_UNAVAILABLE'
    );
    await check('위 503 이후 — attachment는 pending 유지(재시도 가능), 회계 불변', async () => {
      assert.strictEqual(db.attachments[id].status, 'pending', 'GCS 조회 실패는 상태를 바꾸지 않고 재시도 가능해야 한다');
      assert.strictEqual(db.binder_storage_usage.b1.bytes_used, before);
    });
  }

  {
    const key = 'attachments/b1/2026/08/never-uploaded.png';
    const id = insertAttachment({ binder_id: 'b1', storage_key: key, file_size: 100, uploader_id: 'u1' });
    gcsSizeOverrides[key] = { notFound: true };
    await expectStatus(
      'GCS에 객체가 존재하지 않으면(404) 404 거부(선언만 하고 업로드하지 않은 경우)',
      () => MediaService.confirm(id, ctx('u1')),
      404,
      'ATTACHMENT_OBJECT_NOT_FOUND'
    );
    await check('위 404 이후 — attachment rejected 전환', async () => {
      assert.strictEqual(db.attachments[id].status, 'rejected');
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // 결과 출력
  // ═══════════════════════════════════════════════════════════════
  Module._load = originalLoad;

  console.log(`\nstorageQuotaRegression: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    for (const { name, error } of failures) {
      console.error(`\n✗ ${name}`);
      console.error(error);
    }
    process.exitCode = 1;
  }
}

run().catch((error) => {
  Module._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});
