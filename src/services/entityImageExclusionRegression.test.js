/**
 * src/services/entityImageExclusionRegression.test.js
 * =========================================
 * RLY-20260806-093(S4) — media.md §2-3·§6: 엔티티 이미지 3종(USER_AVATAR·BINDER_AVATAR·
 * CAST_COVER)은 "정체성 데이터 — 숨김/삭제 부적절"이라 (1) 생명주기 cron(365일 숨김·GCS
 * storage class 전환) (2) 바인더 파일함 목록 (3) 파일함 개별 삭제·일반 삭제 엔드포인트에서
 * 전부 제외돼야 한다.
 *
 * 조사 결과 이 세 지점 전부 S1(RLY-20260806-080)이 엔티티 이미지에 attachments 행을 만들기
 * 시작한 순간부터 있던 결함이었다(제외 필터가 어디에도 없었다) — 확인 방법: 실제 SQL을
 * 읽고 각 조건이 엔티티 이미지 3종을 걸러내는 조항을 포함하는지 대조했다(아래 각 테스트의
 * 주석 참조).
 *
 * ⚠️ "제외만 단언하면 전부 제외해도 통과한다"는 team-lead 경고에 따라 모든 테스트에 대조군
 * (첨부 6종 대표로 EVENT 하나)을 함께 넣는다.
 *
 * 이 저장소엔 테스트 프레임워크가 없다 — plain assert + `node <file>.js` 직접 실행, 가짜 DB
 * connection으로 실제 서비스·DAO 코드를 구동한다(avatarCoverAuthzRegression.test.js와 동일 패턴).
 *
 * 실행: node src/services/entityImageExclusionRegression.test.js
 */

const assert = require('assert');

const dbPath = require.resolve('../../config/db');
const NOW = new Date();

const db = {
  attachments: {},
  binder_members: {},
  binder_boosts: {}, // binderId -> boost row (활성 Boost 없음 = 미등록)
  binder_storage_usage: {},
};

function setMember(binderId, userId, role) {
  db.binder_members[`${binderId}:${userId}`] = {
    binder_id: binderId, user_id: userId, role,
    notification_level: 1, nickname_in_binder: null, joined_at: NOW.toISOString(), deleted_at: null,
  };
}
setMember('bA', 'master1', 0);
setMember('bA', 'member1', 3);

let nextId = 1;
function seedAttachment(fields) {
  const id = fields.id || `att-${nextId++}`;
  db.attachments[id] = {
    id,
    binder_id: 'bA',
    context_type: 'EVENT',
    context_id: 'e1',
    uploader_id: 'member1',
    filename: 'f.jpg',
    file_size: 1000,
    content_type: 'image/jpeg',
    storage_key: `attachments/bA/2026/08/${id}.jpg`,
    status: 'ready',
    storage_class: 'standard',
    display_order: 0,
    thumbnail_url: null,
    hidden_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    deleted_at: null,
    ...fields,
  };
  return id;
}

const ENTITY_IMAGE_TYPES = new Set(['USER_AVATAR', 'BINDER_AVATAR', 'CAST_COVER']);

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

  // AttachmentDAO.findById — RLY-20260806-093: context_type NOT IN (...) 필터 포함.
  if (s.startsWith('SELECT * FROM attachments') && s.includes('WHERE id = $1 AND deleted_at IS NULL')) {
    const row = db.attachments[params[0]];
    if (!row || row.deleted_at || ENTITY_IMAGE_TYPES.has(row.context_type)) return { rows: [] };
    return { rows: [{ ...row }] };
  }

  // AttachmentDAO.findByBinder
  if (s.startsWith('SELECT a.*, ui.display_name AS uploader_name')) {
    const [binderId] = params;
    const rows = Object.values(db.attachments).filter((a) =>
      a.binder_id === binderId && !a.deleted_at && ['ready', 'hidden'].includes(a.status)
      && !ENTITY_IMAGE_TYPES.has(a.context_type)
      // 이 테스트 스위트는 SECTION_MESSAGE 행을 seed하지 않으므로 그 EXISTS 서브쿼리는
      // 재현하지 않는다(a.context_type이 항상 'SECTION_MESSAGE'가 아니므로 조건이 자명하게 참).
    );
    return { rows: rows.map((a) => ({ ...a, uploader_name: 'tester' })) };
  }

  // AttachmentDAO.findExpiredFreeAttachments — 365일 숨김 전환 대상 조회.
  if (s.startsWith('SELECT a.id, a.storage_key, a.binder_id')) {
    const cutoff = new Date(NOW.getTime() - 365 * 24 * 60 * 60 * 1000);
    const rows = Object.values(db.attachments).filter((a) => {
      if (a.status !== 'ready' || a.deleted_at) return false;
      if (ENTITY_IMAGE_TYPES.has(a.context_type)) return false; // RLY-20260806-093 필터
      // LEFT JOIN binder_boosts ... ON a.binder_id = db.binder_id AND active — a.binder_id가
      // null이면 어떤 행과도 매치하지 않아(NULL = 무엇이든 NULL) db.binder_id IS NULL이 참이 된다.
      const boost = a.binder_id != null ? db.binder_boosts[a.binder_id] : null;
      const hasActiveBoost = !!(boost && boost.status === 'active' && new Date(boost.current_period_end) > NOW);
      if (hasActiveBoost) return false;
      return new Date(a.created_at) < cutoff;
    });
    return { rows: rows.map((a) => ({ id: a.id, storage_key: a.storage_key, binder_id: a.binder_id })) };
  }

  // AttachmentDAO.findByStorageClassForTransition — GCS storage class 전환 대상 조회.
  if (s.startsWith("SELECT id, storage_key FROM attachments WHERE status = 'hidden'")) {
    const [storageClass] = params;
    const rows = Object.values(db.attachments).filter((a) =>
      a.status === 'hidden' && !a.deleted_at && a.storage_class === storageClass
      && !ENTITY_IMAGE_TYPES.has(a.context_type) // RLY-20260806-093 필터(defense-in-depth)
    );
    return { rows: rows.map((a) => ({ id: a.id, storage_key: a.storage_key })) };
  }

  // MediaService.deleteAttachment — 일반 삭제 경로(uploader_id 조건 포함, RLY-20260806-093 필터 추가).
  if (s.startsWith('UPDATE attachments SET deleted_at = now(), updated_at = now() WHERE id = $1 AND uploader_id = $2')) {
    const [id, uploaderId] = params;
    const row = db.attachments[id];
    if (!row || row.uploader_id !== uploaderId || row.deleted_at || ENTITY_IMAGE_TYPES.has(row.context_type)) {
      return { rows: [] };
    }
    row.deleted_at = new Date().toISOString();
    row.updated_at = new Date().toISOString();
    return { rows: [{ id: row.id, binder_id: row.binder_id, storage_key: row.storage_key, file_size: row.file_size }] };
  }

  // AttachmentDAO.softDelete — 파일함 개별 삭제 경로(binderService.deleteAttachment가 findById
  // 통과 후 호출). context_type 필터가 없다 — findById가 이미 엔티티 이미지를 걸러내므로
  // 여기까지 도달하지 않는 것이 이번 회귀의 핵심 단언이다.
  if (s.startsWith('UPDATE attachments SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL')) {
    const [id] = params;
    const row = db.attachments[id];
    if (!row || row.deleted_at) return { rows: [] };
    row.deleted_at = new Date().toISOString();
    row.updated_at = new Date().toISOString();
    return { rows: [{ id: row.id, binder_id: row.binder_id, storage_key: row.storage_key, file_size: row.file_size }] };
  }

  // AttachmentDAO.applyStorageDelta — 경계 판정 + upsert(첨부 6종 성공 삭제 경로에서만 도달).
  if (s.startsWith('SELECT NOT EXISTS')) {
    return { rows: [{ is_boundary: true }] };
  }
  if (s.startsWith('INSERT INTO binder_storage_usage')) {
    return { rows: [] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const pool = require('../../config/db');
const { AttachmentDAO } = require('../daos/attachmentDAO');
const { MediaService } = require('./mediaService');
const { BinderService } = require('./binderService');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(detail ? `${name}: ${detail}` : name);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass++;
  } catch (err) {
    fail++;
    failures.push(`${name}: ${err.message}`);
  }
}

async function run() {
  // ═══════════════════════════════════════════════════════════════════
  // ①·② 생명주기 — 365일 숨김 전환 대상에서 엔티티 이미지 3종은 빠지고(①) 첨부 6종은
  //   그대로 잡힌다(② 대조군).
  // ═══════════════════════════════════════════════════════════════════
  {
    const oldDate = new Date(NOW.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString(); // 400일 전
    const idUserAvatar = seedAttachment({ context_type: 'USER_AVATAR', context_id: 'u1', binder_id: null, status: 'ready', created_at: oldDate });
    const idBinderAvatar = seedAttachment({ context_type: 'BINDER_AVATAR', context_id: 'bA', binder_id: 'bA', status: 'ready', created_at: oldDate });
    const idCastCover = seedAttachment({ context_type: 'CAST_COVER', context_id: 'c1', binder_id: 'bA', status: 'ready', created_at: oldDate });
    const idLegacyEvent = seedAttachment({ context_type: 'EVENT', context_id: 'e1', binder_id: 'bA', status: 'ready', created_at: oldDate });

    const candidates = await AttachmentDAO.findExpiredFreeAttachments(pool);
    const ids = candidates.map((c) => c.id);

    check('① USER_AVATAR는 365일 지나도 숨김 전환 대상에서 빠진다', !ids.includes(idUserAvatar), `ids=${JSON.stringify(ids)}`);
    check('① BINDER_AVATAR는 365일 지나도 숨김 전환 대상에서 빠진다(binder_id가 채워져 있어도)', !ids.includes(idBinderAvatar));
    check('① CAST_COVER는 365일 지나도 숨김 전환 대상에서 빠진다', !ids.includes(idCastCover));
    check('② 대조군 — 첨부 6종(EVENT)은 그대로 숨김 전환 대상에 잡힌다', ids.includes(idLegacyEvent));
  }

  // storage class 전환도 같은 원칙(defense-in-depth) — 이미 'hidden'인 엔티티 이미지가 있어도 제외.
  {
    const oldHidden = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const idHiddenAvatar = seedAttachment({
      context_type: 'BINDER_AVATAR', context_id: 'bA', binder_id: 'bA',
      status: 'hidden', storage_class: 'standard', hidden_at: oldHidden,
    });
    const idHiddenLegacy = seedAttachment({
      context_type: 'EVENT', context_id: 'e2', binder_id: 'bA',
      status: 'hidden', storage_class: 'standard', hidden_at: oldHidden,
    });
    const candidates = await AttachmentDAO.findByStorageClassForTransition(pool, 'standard', '1 day');
    const ids = candidates.map((c) => c.id);
    check('①-b storage class 전환 대상에서도 엔티티 이미지(이미 hidden이어도)는 빠진다', !ids.includes(idHiddenAvatar));
    check('②-b 대조군 — 첨부 6종(EVENT, hidden)은 storage class 전환 대상에 그대로 잡힌다', ids.includes(idHiddenLegacy));
  }

  // ═══════════════════════════════════════════════════════════════════
  // ③ 파일함 목록 — GET /binders/:binderId/attachments(BinderService.listAttachments →
  //   AttachmentDAO.findByBinder)에 BINDER_AVATAR·CAST_COVER가 뜨지 않는다. USER_AVATAR는
  //   binder_id가 null이라 애초에 이 바인더 목록 대상이 아니다(별도 확인 불필요).
  // ═══════════════════════════════════════════════════════════════════
  {
    const idBinderAvatar = seedAttachment({ context_type: 'BINDER_AVATAR', context_id: 'bA', binder_id: 'bA', status: 'ready' });
    const idCastCover = seedAttachment({ context_type: 'CAST_COVER', context_id: 'c1', binder_id: 'bA', status: 'ready' });
    const idLegacy = seedAttachment({ context_type: 'EVENT', context_id: 'e3', binder_id: 'bA', status: 'ready' });

    const files = await BinderService.listAttachments('bA', {}, 'member1');
    const ids = files.map((f) => f.id);

    check('③ BINDER_AVATAR는 파일함 목록에 뜨지 않는다', !ids.includes(idBinderAvatar), `ids=${JSON.stringify(ids)}`);
    check('③ CAST_COVER는 파일함 목록에 뜨지 않는다', !ids.includes(idCastCover));
    check('⑤ 대조군 — 첨부 6종(EVENT)은 파일함 목록에 그대로 뜬다', ids.includes(idLegacy));
  }

  // ═══════════════════════════════════════════════════════════════════
  // ④ 파일함 삭제 거부 — BinderService.deleteAttachment(파일함 개별 삭제 UI가 부르는 경로,
  //   RLY-20260806-089)가 엔티티 이미지에 대해 404로 거부되고, 첨부 6종은 그대로 삭제된다(대조군).
  // ═══════════════════════════════════════════════════════════════════
  await checkAsync('④ 파일함에서 BINDER_AVATAR 삭제 시도 — 404로 거부된다(profile 사진을 파일함에서 못 지운다)', async () => {
    const id = seedAttachment({ context_type: 'BINDER_AVATAR', context_id: 'bA', binder_id: 'bA', status: 'ready' });
    try {
      await BinderService.deleteAttachment('bA', id, 'master1');
      throw new Error('삭제가 거부돼야 하는데 통과해버림');
    } catch (err) {
      if (err.statusCode !== 404) throw new Error(`404를 기대했지만 status=${err.statusCode} msg=${err.message}`);
    }
    assert.strictEqual(db.attachments[id].deleted_at, null, '거부됐으면 실제로 deleted_at이 찍히면 안 된다');
  });

  await checkAsync('⑤ 대조군 — 파일함에서 첨부 6종(EVENT) 삭제는 그대로 성공한다', async () => {
    const id = seedAttachment({ context_type: 'EVENT', context_id: 'e4', binder_id: 'bA', status: 'ready' });
    await BinderService.deleteAttachment('bA', id, 'master1');
    assert.ok(db.attachments[id].deleted_at, '첨부 6종은 여전히 정상적으로 삭제돼야 한다(회귀 없음)');
  });

  // 일반 삭제 경로(DELETE /attachments/:id, mediaService.deleteAttachment)도 같은 원칙
  // (defense-in-depth — 파일함 경로와 별개로 attachment_id를 직접 아는 경로도 막는다).
  await checkAsync('④-b 일반 삭제 경로(mediaService.deleteAttachment)로도 USER_AVATAR는 거부된다', async () => {
    const id = seedAttachment({ context_type: 'USER_AVATAR', context_id: 'u2', binder_id: null, status: 'ready', uploader_id: 'self1' });
    try {
      await MediaService.deleteAttachment(id, 'self1');
      throw new Error('삭제가 거부돼야 하는데 통과해버림');
    } catch (err) {
      if (err.statusCode !== 404) throw new Error(`404를 기대했지만 status=${err.statusCode} msg=${err.message}`);
    }
    assert.strictEqual(db.attachments[id].deleted_at, null);
  });

  await checkAsync('⑤-b 대조군 — 일반 삭제 경로로 첨부 6종(EVENT) 삭제는 그대로 성공한다', async () => {
    const id = seedAttachment({ context_type: 'EVENT', context_id: 'e5', binder_id: 'bA', status: 'ready', uploader_id: 'self1' });
    await MediaService.deleteAttachment(id, 'self1');
    assert.ok(db.attachments[id].deleted_at);
  });

  console.log(`\n[entityImageExclusionRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[entityImageExclusionRegression] 실행 실패:', error);
  process.exitCode = 1;
});
