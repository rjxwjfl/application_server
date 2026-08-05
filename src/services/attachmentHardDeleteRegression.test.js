/**
 * src/services/attachmentHardDeleteRegression.test.js
 * =========================================
 * RLY-20260806-017 (F-S6 §3 · 결정 61) GCS 객체 삭제 시점 이관 회귀 스위트.
 *
 * 결정 61: GCS 객체 삭제를 soft delete 시점(mediaService.deleteAttachment)에서 하드 삭제
 * 시점(cleanupJobs 의 attachments 단계)으로 옮긴다. 이 스위트는 두 지점을 함께 검증한다.
 *
 * 이 저장소에는 테스트 프레임워크가 없다(`npm test`는 실패하는 placeholder). authzRegression·
 * storageQuotaRegression과 동일 관행 — plain assert + `node <file>.js` 직접 실행, 가짜 DB
 * connection(require.cache 주입) + 가짜 @google-cloud/storage(Module._load 스텁)로 실제
 * 서비스·잡 코드를 구동한다. storageQuotaRegression의 gcsSizeOverrides 패턴을 참고하되,
 * 여기서는 confirm의 getMetadata가 아니라 "어떤 storage_key로 delete()가 호출됐는지"를
 * 기록한다 — "삭제가 호출됐다"만 보는 것은 무의미하므로 호출 여부·대상 키·횟수를 모두 단언한다.
 *
 * 실행: node src/services/attachmentHardDeleteRegression.test.js
 */

const assert = require('assert');
const Module = require('module');

process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test';
process.env.PGDATABASE = process.env.PGDATABASE || 'test';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test';

const NOW = new Date();
const DAY = 24 * 60 * 60 * 1000;

// ── 가짜 relational state ────────────────────────────────────────────────
const db = {
  attachments: {},
};

let nextId = 1;
function insertAttachment({ binder_id = 'b1', storage_key, uploader_id = 'u1', file_size = 100, deleted_at = null }) {
  const id = `att-${nextId++}`;
  db.attachments[id] = { id, binder_id, storage_key, uploader_id, file_size, deleted_at };
  return id;
}

function daysAgo(n) {
  return new Date(NOW.getTime() - n * DAY).toISOString();
}

const queryLog = [];

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  queryLog.push({ sql: s, params });

  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // mediaService.deleteAttachment — soft delete
  if (s.startsWith('UPDATE attachments SET deleted_at = now(), updated_at = now()') && s.includes('uploader_id = $2')) {
    const [id, uploaderId] = params;
    const att = db.attachments[id];
    if (!att || att.uploader_id !== uploaderId || att.deleted_at) return { rows: [] };
    att.deleted_at = NOW.toISOString();
    return { rows: [{ id: att.id, binder_id: att.binder_id, storage_key: att.storage_key, file_size: att.file_size }] };
  }

  // AttachmentDAO.applyStorageDelta — 경계 판정(단일 행, binder_id 스코프) — deleteAttachment 경로
  if (s.includes('AS is_boundary') && s.includes('binder_id = $1')) {
    const [binderId, storageKey, excludeId] = params;
    const isOther = Object.values(db.attachments).some(
      (a) => a.binder_id === binderId && a.storage_key === storageKey && !a.deleted_at && a.id !== excludeId
    );
    return { rows: [{ is_boundary: !isOther }] };
  }
  if (s.startsWith('INSERT INTO binder_storage_usage')) return { rows: [] };

  // cleanupJobs.cleanupAttachments — 30일 경과 후보
  if (s.startsWith('SELECT id, storage_key FROM attachments WHERE deleted_at IS NOT NULL')) {
    const rows = Object.values(db.attachments)
      .filter((att) => att.deleted_at && new Date(att.deleted_at).getTime() < NOW.getTime() - 30 * DAY)
      .map((att) => ({ id: att.id, storage_key: att.storage_key }))
      .sort((a, b) => (a.storage_key || '').localeCompare(b.storage_key || ''));
    return { rows };
  }

  // cleanupJobs.cleanupAttachments — storage_key 그룹 가드(그룹 밖 활성 행 존재 여부)
  if (s.includes('AS is_boundary') && s.includes('id <> ALL(')) {
    const [storageKey, ids] = params;
    const isOther = Object.values(db.attachments).some(
      (a) => a.storage_key === storageKey && !a.deleted_at && !ids.includes(a.id)
    );
    return { rows: [{ is_boundary: !isOther }] };
  }

  // cleanupJobs.cleanupAttachments — 그룹 단위 하드 삭제
  if (s.startsWith('DELETE FROM attachments WHERE id = ANY($1)')) {
    const [ids] = params;
    let count = 0;
    for (const id of ids) {
      if (db.attachments[id]) {
        delete db.attachments[id];
        count += 1;
      }
    }
    return { rowCount: count };
  }

  // 다른 STEPS 테이블 — 이 스위트의 관심사가 아님(안전한 no-op)
  if (s.startsWith('DELETE FROM')) return { rowCount: 0 };

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
}

const mockDb = {
  query: mockQuery,
  connect: async () => ({ query: mockQuery, release() {} }),
};

const dbPath = require.resolve('../../config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

// ── @google-cloud/storage 스텁 — 어떤 storage_key로 delete()가 몇 번 호출됐는지 기록한다.
// gcsDeleteFailKeys에 든 키는 이번 호출에서 에러를 던진다("삭제 실패" 시뮬레이션, ignoreNotFound와
// 무관하게 네트워크/권한 등 실제 오류를 흉내낸다).
const gcsDeleteCalls = [];
const gcsDeleteFailKeys = new Set();

const gcsStub = {
  Storage: class {
    bucket() {
      return {
        file(storageKey) {
          return {
            async delete() {
              gcsDeleteCalls.push(storageKey);
              if (gcsDeleteFailKeys.has(storageKey)) {
                throw new Error('fake GCS delete failure');
              }
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

const { MediaService } = require('./mediaService');
const { runCleanup } = require('../jobs/cleanupJobs');

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
  // ═══════════════════════════════════════════════════════════════
  // AC-S6-3 — deleteAttachment에 GCS 네트워크 호출이 없다
  // ═══════════════════════════════════════════════════════════════
  {
    const key = 'attachments/b1/2026/08/solo.png';
    const id = insertAttachment({ storage_key: key });
    await check('① deleteAttachment 후 GCS delete()가 전혀 호출되지 않는다(AC-S6-3) — 객체 존속', async () => {
      await MediaService.deleteAttachment(id, 'u1');
      assert.ok(db.attachments[id].deleted_at, 'DB 행은 soft delete되어야 한다');
      assert.strictEqual(gcsDeleteCalls.length, 0, 'deleteAttachment는 GCS를 만지지 않아야 한다');
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // AC-S6-4 — soft delete 후 30일 이내에는 객체가 남아 있다 + 30일 경과 후 배치가 정리
  // ═══════════════════════════════════════════════════════════════
  {
    const key = 'attachments/b1/2026/08/fresh.png';
    const id = insertAttachment({ storage_key: key });
    await MediaService.deleteAttachment(id, 'u1'); // 방금 삭제 — 아직 30일 안 지남
    gcsDeleteCalls.length = 0;
    await check('② 30일 미경과 행은 runCleanup에도 살아남고 객체 delete() 호출이 없다(AC-S6-4)', async () => {
      await runCleanup();
      assert.ok(db.attachments[id], '아직 30일이 안 지났으므로 행이 남아 있어야 한다');
      assert.strictEqual(gcsDeleteCalls.includes(key), false);
    });
  }

  {
    const key = 'attachments/b1/2026/08/expired.png';
    const id = insertAttachment({ storage_key: key, deleted_at: daysAgo(31) });
    gcsDeleteCalls.length = 0;
    await check('③ 30일 경과 배치가 객체+행을 함께 정리한다', async () => {
      await runCleanup();
      assert.deepStrictEqual(gcsDeleteCalls, [key], 'GCS delete()가 정확히 그 키로 1회 호출돼야 한다');
      assert.strictEqual(db.attachments[id], undefined, '행도 하드 삭제돼야 한다');
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // 같은 storage_key를 가리키는 다른 행이 남아 있으면 객체를 지우지 않는다
  // ═══════════════════════════════════════════════════════════════
  {
    const key = 'attachments/b1/2026/08/shared-active.png';
    const idExpired = insertAttachment({ storage_key: key, deleted_at: daysAgo(31) }); // 30일 경과 — 하드 삭제 대상
    const idActive = insertAttachment({ storage_key: key, deleted_at: null }); // 아직 활성 — 이 키를 필요로 함
    gcsDeleteCalls.length = 0;
    await check('④ 키 공유 시 — 다른 활성 행이 있으면 객체를 보존하고 만료 행만 지운다', async () => {
      await runCleanup();
      assert.strictEqual(gcsDeleteCalls.includes(key), false, '활성 행이 그 키를 쓰고 있으므로 객체를 지우면 안 된다');
      assert.strictEqual(db.attachments[idExpired], undefined, '만료 행 자체는 30일 DB 보존 기간이 지났으므로 지운다');
      assert.ok(db.attachments[idActive], '활성 행은 그대로 남아야 한다');
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // 객체 삭제 실패 시 행이 남아 다음 배치에서 재시도된다
  // ═══════════════════════════════════════════════════════════════
  {
    const key = 'attachments/b1/2026/08/gcs-down.png';
    const id = insertAttachment({ storage_key: key, deleted_at: daysAgo(31) });
    gcsDeleteCalls.length = 0;
    gcsDeleteFailKeys.add(key);
    await check('⑤ 객체 삭제 실패 시 이번 배치는 행을 보존한다(배치 전체는 중단되지 않음)', async () => {
      await runCleanup();
      assert.ok(gcsDeleteCalls.includes(key), '삭제 시도는 있어야 한다');
      assert.ok(db.attachments[id], '삭제 실패했으므로 행은 다음 배치를 위해 남아야 한다');
    });

    gcsDeleteFailKeys.delete(key); // 다음 날 배치 — GCS 복구됐다고 가정
    gcsDeleteCalls.length = 0;
    await check('⑤ 다음 배치에서 재시도 성공 — 객체+행 정리', async () => {
      await runCleanup();
      assert.deepStrictEqual(gcsDeleteCalls, [key]);
      assert.strictEqual(db.attachments[id], undefined);
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // 같은 배치 안에서 동일 키를 가리키는 다중 행 — 순서와 무관하게 안전
  // (첨부 복제(F-S6 §2)가 아직 없어 실제로는 발생하지 않지만, cleanupAttachments의 그룹 처리가
  //  가정과 무관하게 안전한지 규약으로 고정한다.)
  // ═══════════════════════════════════════════════════════════════
  {
    const key = 'attachments/b1/2026/08/multi.png';
    // storage_key 알파벳 정렬과 무관하게 섞어 삽입 — id 순서가 삭제 순서를 좌우하지 않음을 확인.
    const idB = insertAttachment({ storage_key: key, deleted_at: daysAgo(35) });
    const idA = insertAttachment({ storage_key: key, deleted_at: daysAgo(31) });
    const idC = insertAttachment({ storage_key: key, deleted_at: daysAgo(40) });
    gcsDeleteCalls.length = 0;
    await check('⑥ 같은 배치 안 동일 키 다중 행 — 객체 delete()는 정확히 1회, 세 행 모두 정리, 고아 없음', async () => {
      await runCleanup();
      assert.strictEqual(gcsDeleteCalls.filter((k) => k === key).length, 1, '같은 키로 여러 번 GCS delete()를 호출하면 안 된다(그룹 처리)');
      assert.strictEqual(db.attachments[idA], undefined);
      assert.strictEqual(db.attachments[idB], undefined);
      assert.strictEqual(db.attachments[idC], undefined);
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // 결과 출력
  // ═══════════════════════════════════════════════════════════════
  Module._load = originalLoad;

  console.log(`\nattachmentHardDeleteRegression: ${pass} passed, ${fail} failed`);
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
