/**
 * src/services/messageAttachmentQuotaRegression.test.js
 * =========================================
 * RLY-20260806-014 (F-S9b, 정정판) 섹션 메시지 첨부 — "링크" 경로 회귀 스위트.
 *
 * 배경(정정 이력): 최초 구현은 messageDAO가 attachments에 직접 INSERT하는 것을 전제로
 * 402 한도 검사·applyStorageDelta를 이 경로에 추가했었다. 그러나 mediaService.presign이
 * 클라가 보낸 id로 이미 attachments를 INSERT하므로(status='pending'), 같은 id로 다시
 * INSERT하면 PK 중복으로 애초에 성립 불가능한 설계였다 — 즉 이 경로는 처음부터 "INSERT"가
 * 아니라 media.md:299-334(Phase 5)가 규정한 "링크"(UPDATE attachments SET context_id)여야
 * 했다. Architect 판정(가)에 따라 messageDAO.insertAttachments → linkAttachments로 교체하고,
 * 402 검사·applyStorageDelta는 이 경로에서 철회했다(presign/confirm 시점에 이미 끝나 있어
 * 여기서 또 하면 이중 계상이 된다). 이 스위트는 그 새 계약을 검증한다.
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
  binder_storage_usage: {},
  attachments: {},
  section_messages: {},
};

db.sections.s1 = { id: 's1', binder_id: 'b1', title: 't', access_scope: 0, is_default: false, deleted_at: null };

// 링크 대상 후보들 — 전부 presign/confirm으로 이미 만들어져 있다고 가정(멀티 시나리오용).
db.attachments['att-ready'] = { id: 'att-ready', binder_id: 'b1', context_type: 'SECTION_MESSAGE', context_id: null, uploader_id: 'u1', status: 'ready', filename: 'f.png', file_size: 100, content_type: 'image/png', storage_key: 'k1', deleted_at: null };
db.attachments['att-pending'] = { id: 'att-pending', binder_id: 'b1', context_type: 'SECTION_MESSAGE', context_id: null, uploader_id: 'u1', status: 'pending', filename: 'f2.png', file_size: 100, content_type: 'image/png', storage_key: 'k2', deleted_at: null };
db.attachments['att-other-user'] = { id: 'att-other-user', binder_id: 'b1', context_type: 'SECTION_MESSAGE', context_id: null, uploader_id: 'u2', status: 'ready', filename: 'f3.png', file_size: 100, content_type: 'image/png', storage_key: 'k3', deleted_at: null };
db.attachments['att-other-binder'] = { id: 'att-other-binder', binder_id: 'b2', context_type: 'SECTION_MESSAGE', context_id: null, uploader_id: 'u1', status: 'ready', filename: 'f4.png', file_size: 100, content_type: 'image/png', storage_key: 'k4', deleted_at: null };
db.attachments['att-linked-elsewhere'] = { id: 'att-linked-elsewhere', binder_id: 'b1', context_type: 'SECTION_MESSAGE', context_id: 'm-some-other-message', uploader_id: 'u1', status: 'ready', filename: 'f5.png', file_size: 100, content_type: 'image/png', storage_key: 'k5', deleted_at: null };
db.attachments['att-retry'] = { id: 'att-retry', binder_id: 'b1', context_type: 'SECTION_MESSAGE', context_id: null, uploader_id: 'u1', status: 'ready', filename: 'f6.png', file_size: 100, content_type: 'image/png', storage_key: 'k6', deleted_at: null };

const queryLog = [];

// BEGIN에서 스냅샷을 뜨고 ROLLBACK에서 복원한다 — AC-8(부분 실패 시 트랜잭션 전체 롤백)을
// 실제로 검증하려면 단순 no-op으로는 부족하다(withTransaction이 던진 에러를 ROLLBACK으로
// 처리하는 실제 Postgres 동작을 흉내내야 "일부만 조용히 남지 않는다"를 상태로 확인할 수 있다).
let txSnapshot = null;

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  queryLog.push({ sql: s, params });

  if (s === 'BEGIN') {
    txSnapshot = JSON.parse(JSON.stringify({ attachments: db.attachments, section_messages: db.section_messages }));
    return { rows: [] };
  }
  if (s === 'COMMIT') {
    txSnapshot = null;
    return { rows: [] };
  }
  if (s === 'ROLLBACK') {
    if (txSnapshot) {
      db.attachments = txSnapshot.attachments;
      db.section_messages = txSnapshot.section_messages;
      txSnapshot = null;
    }
    return { rows: [] };
  }

  // SectionDAO.findById
  if (s.startsWith('SELECT id, binder_id, title, access_scope, is_default, created_at, updated_at, deleted_at FROM sections')) {
    const row = db.sections[params[0]];
    return { rows: row && !row.deleted_at ? [row] : [] };
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

  // MessageDAO.linkAttachments — F-S9b(정정): INSERT가 아니라 UPDATE ... SET context_id
  if (s.startsWith('UPDATE attachments SET context_id')) {
    const [ids, messageId, binderId, uploaderId] = params;
    const matched = [];
    for (const id of ids) {
      const att = db.attachments[id];
      if (!att) continue;
      if (att.deleted_at) continue;
      if (att.context_type !== 'SECTION_MESSAGE') continue;
      if (att.binder_id !== binderId) continue;
      if (att.uploader_id !== uploaderId) continue;
      if (att.status !== 'ready') continue;
      if (!(att.context_id === null || att.context_id === messageId)) continue;
      att.context_id = messageId;
      matched.push({ id: att.id, message_id: att.context_id, filename: att.filename, file_size: att.file_size, content_type: att.content_type, storage_key: att.storage_key, status: att.status });
    }
    return { rows: matched };
  }

  throw new Error(`[mock] Unhandled query(회계 쿼리가 이 경로에서 실행되면 안 된다 — 이중 계상 가드): ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
}

const mockDb = {
  query: mockQuery,
  connect: async () => ({ query: mockQuery, release() {} }),
};

const dbPath = require.resolve('../../config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { MessageDAO } = require('../daos/messageDAO');
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

async function run() {
  // ═══════════════════════════════════════════════════════════════
  // AC-1 — 본인 소유·ready 상태 첨부는 정상 링크된다(end-to-end)
  // ═══════════════════════════════════════════════════════════════
  await check('AC-1 — 정상 첨부 링크(end-to-end createMessage)', async () => {
    const result = await MessageService.createMessage('s1', {
      id: 'm1', content: 'hi', attachments: [{ id: 'att-ready' }],
    }, ctx('u1'));
    assert.strictEqual(result.attachments.length, 1);
    assert.strictEqual(result.attachments[0].id, 'att-ready');
    assert.strictEqual(db.attachments['att-ready'].context_id, 'm1');
  });

  // ═══════════════════════════════════════════════════════════════
  // AC-2 — 이 경로는 회계 쿼리를 전혀 실행하지 않는다(이중 계상 방지)
  // ═══════════════════════════════════════════════════════════════
  await check('AC-2 — 링크 경로는 binder_storage_usage/is_boundary 쿼리를 실행하지 않음', async () => {
    const accountingQueries = queryLog.filter(
      (q) => q.sql.includes('binder_storage_usage') || q.sql.includes('is_boundary')
    );
    assert.strictEqual(accountingQueries.length, 0, 'AC-1 실행 이후에도 회계 쿼리가 하나도 없어야 한다');
  });

  // ═══════════════════════════════════════════════════════════════
  // AC-3 — 멱등: 같은 메시지·같은 첨부로 링크를 다시 호출해도 부작용 없이 통과
  // (message INSERT 자체의 재전송 처리는 이 함수의 관심사가 아니므로 linkAttachments를 직접 호출)
  // ═══════════════════════════════════════════════════════════════
  await check('AC-3 — 멱등 재확인(같은 messageId로 재호출해도 성공·부작용 없음)', async () => {
    const first = await MessageDAO.linkAttachments(mockDb, 'm-retry', 'b1', 'u1', [{ id: 'att-retry' }]);
    assert.strictEqual(first.length, 1);
    assert.strictEqual(db.attachments['att-retry'].context_id, 'm-retry');

    const second = await MessageDAO.linkAttachments(mockDb, 'm-retry', 'b1', 'u1', [{ id: 'att-retry' }]);
    assert.strictEqual(second.length, 1, '재호출도 동일하게 1건 반환(no-op성 재확정)');
    assert.strictEqual(db.attachments['att-retry'].context_id, 'm-retry', 'context_id 불변');
  });

  // ═══════════════════════════════════════════════════════════════
  // AC-4 — 남의 첨부는 링크할 수 없다(uploader_id 불일치) → 403
  // ═══════════════════════════════════════════════════════════════
  await expectStatus(
    'AC-4 — 다른 사용자가 업로드한 첨부 링크 시도 → 403',
    () => MessageDAO.linkAttachments(mockDb, 'm-hostile-1', 'b1', 'u1', [{ id: 'att-other-user' }]),
    403,
    'SECTION_ACCESS_DENIED'
  );

  // ═══════════════════════════════════════════════════════════════
  // AC-5 — 다른 바인더 소속 첨부는 링크할 수 없다 → 403
  // ═══════════════════════════════════════════════════════════════
  await expectStatus(
    'AC-5 — 다른 바인더 소속 첨부 링크 시도 → 403',
    () => MessageDAO.linkAttachments(mockDb, 'm-hostile-2', 'b1', 'u1', [{ id: 'att-other-binder' }]),
    403,
    'SECTION_ACCESS_DENIED'
  );

  // ═══════════════════════════════════════════════════════════════
  // AC-6 — 업로드 미완료(pending) 첨부는 링크할 수 없다 → 403
  // ═══════════════════════════════════════════════════════════════
  await expectStatus(
    'AC-6 — status=pending 첨부 링크 시도 → 403',
    () => MessageDAO.linkAttachments(mockDb, 'm-hostile-3', 'b1', 'u1', [{ id: 'att-pending' }]),
    403,
    'SECTION_ACCESS_DENIED'
  );

  // ═══════════════════════════════════════════════════════════════
  // AC-7 — 이미 다른 메시지에 링크된 첨부는 재링크할 수 없다 → 403
  // ═══════════════════════════════════════════════════════════════
  await expectStatus(
    'AC-7 — 이미 다른 메시지에 링크된 첨부 재링크 시도 → 403',
    () => MessageDAO.linkAttachments(mockDb, 'm-hostile-4', 'b1', 'u1', [{ id: 'att-linked-elsewhere' }]),
    403,
    'SECTION_ACCESS_DENIED'
  );

  // ═══════════════════════════════════════════════════════════════
  // AC-8 — 배열 중 하나라도 권한 없으면 전체 거부(일부만 조용히 누락 X) + partial write 없음
  // MessageService.createMessage(withTransaction 경유)로 실행해 실제 ROLLBACK 경로를 태운다 —
  // linkAttachments를 트랜잭션 밖에서 단독 호출하면 부분 UPDATE가 롤백되지 않아 이 불변식을
  // 검증할 수 없다.
  // ═══════════════════════════════════════════════════════════════
  await check('AC-8 — 배열 일부만 유효해도 전부 거부, 메시지도 유효했던 첨부도 남지 않음', async () => {
    // att-fresh는 정상 대상이지만 att-other-user가 섞여 있으면 전체가 거부되어야 한다.
    db.attachments['att-fresh'] = { id: 'att-fresh', binder_id: 'b1', context_type: 'SECTION_MESSAGE', context_id: null, uploader_id: 'u1', status: 'ready', filename: 'f7.png', file_size: 100, content_type: 'image/png', storage_key: 'k7', deleted_at: null };
    try {
      await MessageService.createMessage('s1', {
        id: 'm-mixed', content: 'mixed', attachments: [{ id: 'att-fresh' }, { id: 'att-other-user' }],
      }, ctx('u1'));
      throw new Error('expected to throw but did not');
    } catch (error) {
      assert.strictEqual(error.statusCode, 403);
    }
    assert.strictEqual(db.attachments['att-fresh'].context_id, null, '유효했던 att-fresh도 링크되지 않아야 한다(전부 아니면 전무 — 트랜잭션 롤백)');
    assert.strictEqual(db.section_messages['m-mixed'], undefined, '메시지 행도 함께 롤백되어야 한다');
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
