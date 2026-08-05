/**
 * src/services/messageAttachmentQuotaRegression.test.js
 * =========================================
 * RLY-20260806-014 (F-S9b) 섹션 메시지 첨부 — 네 번째 용량 한도 우회 경로 회귀 스위트.
 *
 * 배경: POST /sections/:sectionId/messages → messageService.createMessage →
 * messageDAO.insertAttachments가 attachments에 직접 INSERT한다. mediaService.presign/confirm을
 * 전혀 거치지 않으므로 402 한도 검사와 applyStorageDelta 집계 둘 다 실행되지 않던 경로였다.
 *
 * storageQuotaRegression.test.js와 동일한 관행 — plain assert + `node <file>.js` 직접 실행,
 * 가짜 DB connection(require.cache 주입)으로 실제 서비스·DAO 코드를 구동한다. 이 저장소에는
 * 테스트 프레임워크가 없다(`npm test`는 실패하는 placeholder).
 *
 * 실행: node src/services/messageAttachmentQuotaRegression.test.js
 */

const assert = require('assert');

process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test';
process.env.PGDATABASE = process.env.PGDATABASE || 'test';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test';

// ── 가짜 relational state ────────────────────────────────────────────────
const db = {
  sections: {},
  binder_boosts: {},
  binder_storage_usage: {},
  attachments: {},
  section_messages: {},
};

db.sections.s1 = { id: 's1', binder_id: 'b1', title: 't', access_scope: 0, is_default: false, deleted_at: null };
db.sections.s2 = { id: 's2', binder_id: 'b2', title: 't', access_scope: 0, is_default: false, deleted_at: null }; // Boost Lite
db.binder_boosts.b2 = { binder_id: 'b2', tier: 1, status: 'ACTIVE' };

const queryLog = [];

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  queryLog.push({ sql: s, params });

  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // SectionDAO.findById
  if (s.startsWith('SELECT id, binder_id, title, access_scope, is_default, created_at, updated_at, deleted_at FROM sections')) {
    const row = db.sections[params[0]];
    return { rows: row && !row.deleted_at ? [row] : [] };
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

  // MessageDAO.create
  if (s.startsWith('INSERT INTO section_messages')) {
    const [id, section_id, user_id, parent_id, content, mention_everyone] = params;
    const row = {
      id, section_id, user_id, parent_id, content, mention_everyone,
      is_pinned: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    db.section_messages[id] = row;
    return { rows: [row] };
  }

  // MessageDAO.insertAttachments — 한 행씩 INSERT (F-S9b)
  if (s.startsWith('INSERT INTO attachments')) {
    const [id, binder_id, context_id, storage_key, filename, file_size, content_type, uploader_id] = params;
    db.attachments[id] = {
      id, binder_id, context_type: 'SECTION_MESSAGE', context_id, storage_key,
      filename, file_size, content_type, uploader_id, status: 'ready', deleted_at: null,
    };
    return { rows: [{ id, message_id: context_id, filename, file_size, content_type, storage_key, status: 'ready' }] };
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

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
}

const mockDb = {
  query: mockQuery,
  connect: async () => ({ query: mockQuery, release() {} }),
};

const dbPath = require.resolve('../../config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { MessageService } = require('./messageService');

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

const attachment = (overrides) => ({
  id: overrides.id,
  filename: overrides.filename || 'f.png',
  file_size: overrides.file_size,
  content_type: 'image/png',
  storage_key: overrides.storage_key || `attachments/b1/2026/08/${overrides.id}.png`,
});

async function run() {
  const FREE_LIMIT = 5 * 1024 ** 3;

  // ═══════════════════════════════════════════════════════════════
  // AC-1 — 첨부 없는 메시지는 한도 검사를 건너뛰고 정상 생성된다
  // ═══════════════════════════════════════════════════════════════
  await check('AC-1 — 첨부 없는 메시지는 정상 생성', async () => {
    const result = await MessageService.createMessage('s1', { id: 'm-noattach', content: 'hi' }, ctx('u1'));
    assert.strictEqual(result.id, 'm-noattach');
    assert.strictEqual(db.section_messages['m-noattach'].content, 'hi');
  });

  // ═══════════════════════════════════════════════════════════════
  // AC-2 — 단건 첨부가 한도를 넘으면 402 BOOST_STORAGE_LIMIT
  // ═══════════════════════════════════════════════════════════════
  await expectStatus(
    'AC-2 — 단건 첨부 한도 초과 402(BOOST_STORAGE_LIMIT)',
    () => MessageService.createMessage('s1', {
      id: 'm-over-1',
      content: 'big',
      attachments: [attachment({ id: 'a-over-1', file_size: FREE_LIMIT + 1 })],
    }, ctx('u1')),
    402,
    'BOOST_STORAGE_LIMIT'
  );

  // ═══════════════════════════════════════════════════════════════
  // AC-3 — 개별로는 한도 이내지만 배열 합계로는 초과 → 402 (배열 우회 방지)
  // ═══════════════════════════════════════════════════════════════
  await expectStatus(
    'AC-3 — 배열 합계 초과 시 402(개별 항목은 한도 이내)',
    () => MessageService.createMessage('s1', {
      id: 'm-over-sum',
      content: 'sum',
      attachments: [
        attachment({ id: 'a-sum-1', file_size: Math.floor(FREE_LIMIT * 0.6) }),
        attachment({ id: 'a-sum-2', file_size: Math.floor(FREE_LIMIT * 0.6) }),
      ],
    }, ctx('u1')),
    402,
    'BOOST_STORAGE_LIMIT'
  );

  // ═══════════════════════════════════════════════════════════════
  // AC-4 — 402일 때 partial write 0건 — 메시지도 첨부도 남지 않는다
  // ═══════════════════════════════════════════════════════════════
  await check('AC-4 — 402 이후 메시지·첨부 어느 쪽도 저장되지 않음', async () => {
    assert.strictEqual(db.section_messages['m-over-1'], undefined);
    assert.strictEqual(db.section_messages['m-over-sum'], undefined);
    assert.strictEqual(db.attachments['a-over-1'], undefined);
    assert.strictEqual(db.attachments['a-sum-1'], undefined);
    assert.strictEqual(db.attachments['a-sum-2'], undefined);
    // 트랜잭션 진입 전에 거부되므로 BEGIN 자체가 없어야 한다.
    const beginCount = queryLog.filter((q) => q.sql === 'BEGIN').length;
    const insertMsgCount = queryLog.filter((q) => q.sql.startsWith('INSERT INTO section_messages')).length;
    assert.strictEqual(beginCount, insertMsgCount, 'BEGIN 횟수와 실제 메시지 INSERT 횟수가 같아야 한다(402 케이스는 BEGIN 자체가 없음)');
  });

  // ═══════════════════════════════════════════════════════════════
  // AC-5 — 한도 이내 첨부 생성 시 bytes_used 가 정확히 반영된다
  // ═══════════════════════════════════════════════════════════════
  await check('AC-5 — 한도 이내 첨부 생성 → binder_storage_usage 반영', async () => {
    const before = db.binder_storage_usage.b1 ? db.binder_storage_usage.b1.bytes_used : 0;
    const result = await MessageService.createMessage('s1', {
      id: 'm-ok-1',
      content: 'ok',
      attachments: [
        attachment({ id: 'a-ok-1', file_size: 100 }),
        attachment({ id: 'a-ok-2', file_size: 200 }),
      ],
    }, ctx('u1'));
    assert.strictEqual(result.attachments.length, 2);
    assert.strictEqual(db.binder_storage_usage.b1.bytes_used - before, 300);
    assert.ok(db.attachments['a-ok-1'] && db.attachments['a-ok-2']);
  });

  // ═══════════════════════════════════════════════════════════════
  // AC-6 — 같은 storage_key 를 배열 안에서 공유하는 첨부는 한 번만 집계된다
  // ═══════════════════════════════════════════════════════════════
  await check('AC-6 — 배치 내 storage_key 공유 시 한 번만 집계(중복 과금 없음)', async () => {
    const before = db.binder_storage_usage.b1.bytes_used;
    const SHARED_KEY = 'attachments/b1/2026/08/shared-in-batch.png';
    const result = await MessageService.createMessage('s1', {
      id: 'm-dup-key',
      content: 'dup',
      attachments: [
        attachment({ id: 'a-dup-1', file_size: 500, storage_key: SHARED_KEY }),
        attachment({ id: 'a-dup-2', file_size: 500, storage_key: SHARED_KEY }),
      ],
    }, ctx('u1'));
    assert.strictEqual(result.attachments.length, 2, '행은 둘 다 생성된다(복제 승계) — 회계만 한 번');
    assert.strictEqual(db.binder_storage_usage.b1.bytes_used - before, 500, '같은 storage_key 형제는 최초 등장만 과금');
  });

  // ═══════════════════════════════════════════════════════════════
  // AC-7 — Boost Lite(tier=1) 바인더는 50GB 한도로 통과(Free라면 402였을 크기)
  // ═══════════════════════════════════════════════════════════════
  await check('AC-7 — Boost Lite 바인더는 Free 한도를 넘는 크기도 통과', async () => {
    const overFreeUnderLite = 10 * 1024 ** 3; // Free는 거부, Lite(50GB)는 통과
    const result = await MessageService.createMessage('s2', {
      id: 'm-lite-1',
      content: 'lite',
      attachments: [attachment({ id: 'a-lite-1', file_size: overFreeUnderLite, storage_key: 'attachments/b2/2026/08/a-lite-1.mp4' })],
    }, ctx('u1'));
    assert.strictEqual(result.id, 'm-lite-1');
    assert.strictEqual(db.binder_storage_usage.b2.bytes_used, overFreeUnderLite);
  });

  // ═══════════════════════════════════════════════════════════════
  // 결과 출력
  // ═══════════════════════════════════════════════════════════════
  console.log(`\nmessageAttachmentQuotaRegression: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    for (const { name, error } of failures) {
      console.error(`\n✗ ${name}`);
      console.error(error);
    }
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
