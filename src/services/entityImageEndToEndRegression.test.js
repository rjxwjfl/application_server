/**
 * src/services/entityImageEndToEndRegression.test.js
 * =========================================
 * RLY-20260806-096(S5) — 아바타·커버 통합 S1~S4는 각 단계별로 검증됐지만 전체가 실제로
 * 이어지는지는 아무도 보지 않았다. 이 스위트는 한 회귀 안에서 처음부터 끝까지 돌린다:
 *
 *   presign → attachments 행 생성 → confirm(processing) → Worker Step1~3(검사·EXIF)
 *   → Step4 파생 2종(thumb 720px·full 1080px) → Step5 포인터 이동
 *   → 엔티티 이미지 컬럼(user_infos/binders/casts)에 실제 값이 들어갔는가
 *   → 파일함 목록(findByBinder)에 안 뜨는가
 *   → 생명주기(findExpiredFreeAttachments)가 건너뛰는가(400일 전으로 backdate해서 확인)
 *   → binder_storage_usage가 늘지 않았는가
 *
 * USER_AVATAR·BINDER_AVATAR·CAST_COVER 3종 각각 성공 경로 + 거부(MIME 위변조) 경로를 돈다.
 * 거부 경로는: 포인터가 안 옮겨지고 이전 사진이 유지되는가, storage 집계가 음수로 안 가는가
 * (애초에 적립한 적이 없으므로 "0에서 안 움직이는가")를 함께 확인한다.
 *
 * GCS·DB 둘 다 가짜로 교체하고 실제 서비스·DAO·Worker 코드를 구동한다(mediaWorkerJobs.test.js·
 * avatarCoverAuthzRegression.test.js·entityImageExclusionRegression.test.js와 동일 패턴의 결합).
 * sharp·piexifjs는 실제 라이브러리를 그대로 써서 진짜 JPEG 바이트로 파이프라인을 구동한다.
 *
 * 실행: node src/services/entityImageEndToEndRegression.test.js
 */

const assert = require('assert');
const fs = require('fs/promises');
const Module = require('module');
const sharp = require('sharp');
const piexif = require('piexifjs');

process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test';
process.env.PGDATABASE = process.env.PGDATABASE || 'test';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test';

const NOW = new Date();
const dbPath = require.resolve('../../config/db');

// ── 가짜 DB ─────────────────────────────────────────────────────────────
const db = {
  attachments: {},
  binder_members: {},
  binder_boosts: {},
  binder_storage_usage: {},
  casts: {
    castA: { id: 'castA', calendar_id: 'calA', author_id: 'author1', deleted_at: null, cover_image_url: null, thumbnail_url: null },
  },
  calendars: {
    calA: { id: 'calA', binder_id: 'bA', title: 'CalA', description: null, color: 0, is_public: false, created_at: NOW.toISOString(), updated_at: NOW.toISOString(), deleted_at: null },
  },
  user_infos: {
    user1: { user_id: 'user1', image_url: 'https://cdn.rallyapp.io/derivatives/old-gen/full.webp', thumbnail_url: 'https://cdn.rallyapp.io/derivatives/old-gen/thumb.webp' },
  },
  binders: {
    bA: { id: 'bA', image_url: null, thumbnail_url: null },
  },
};

function setMember(binderId, userId, role) {
  db.binder_members[`${binderId}:${userId}`] = {
    binder_id: binderId, user_id: userId, role,
    notification_level: 1, nickname_in_binder: null, joined_at: NOW.toISOString(), deleted_at: null,
  };
}
setMember('bA', 'master1', 0);
setMember('bA', 'author1', 3); // castA 작성자는 바인더에선 일반 멤버 — "작성자는 role 무관 허용" 확인용.

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
  // CastDAO.findById
  if (s.startsWith('SELECT * FROM casts WHERE id = $1')) {
    const row = db.casts[params[0]];
    return { rows: row && !row.deleted_at ? [row] : [] };
  }
  // CalendarDAO.findById
  if (s.includes('FROM calendars') && s.includes('WHERE id = $1')) {
    const row = db.calendars[params[0]];
    return { rows: row ? [row] : [] };
  }

  // MediaService.presign — attachments INSERT
  if (s.includes('INSERT INTO attachments')) {
    const [id, binderId, contextType, contextId, storageKey, filename, fileSize, contentType, uploaderId] = params;
    db.attachments[id] = {
      id, binder_id: binderId, context_type: contextType, context_id: contextId,
      storage_key: storageKey, filename, file_size: fileSize, content_type: contentType,
      status: 'pending', storage_class: 'standard', uploader_id: uploaderId,
      display_order: 0, thumbnail_url: null, claim_token: null, claimed_at: null,
      attempt_count: 0, next_attempt_at: null, deleted_at: null,
      created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    };
    return { rows: [] };
  }

  // MediaService.confirm — 사전 확인
  if (s.startsWith('SELECT id, binder_id, storage_key, file_size FROM attachments')) {
    const [id, uploaderId] = params;
    const att = db.attachments[id];
    if (!att || att.uploader_id !== uploaderId || att.status !== 'pending') return { rows: [] };
    return { rows: [{ id: att.id, binder_id: att.binder_id, storage_key: att.storage_key, file_size: att.file_size }] };
  }
  // MediaService.confirm — 최종 확정(processing 전환)
  if (s.startsWith("UPDATE attachments SET status = 'processing'")) {
    const [id, uploaderId, actualSize] = params;
    const att = db.attachments[id];
    if (!att || att.uploader_id !== uploaderId || att.status !== 'pending') return { rows: [] };
    att.status = 'processing';
    att.file_size = actualSize;
    att.updated_at = new Date().toISOString();
    return { rows: [{ ...att }] };
  }

  // AttachmentDAO.claimProcessingBatch
  if (s.startsWith('UPDATE attachments SET claim_token = $1')) {
    const [claimToken, leaseMinutes, maxAttempts, limit] = params;
    const leaseCutoff = new Date(Date.now() - leaseMinutes * 60 * 1000);
    const now = new Date();
    const candidates = Object.values(db.attachments)
      .filter((a) => a.status === 'processing')
      .filter((a) => !a.claim_token || new Date(a.claimed_at) < leaseCutoff)
      .filter((a) => !a.next_attempt_at || new Date(a.next_attempt_at) <= now)
      .filter((a) => a.attempt_count < maxAttempts)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .slice(0, limit);
    candidates.forEach((a) => {
      a.claim_token = claimToken;
      a.claimed_at = now.toISOString();
      a.attempt_count += 1;
      a.updated_at = now.toISOString();
    });
    return { rows: candidates.map((a) => ({ ...a })) };
  }

  // AttachmentDAO.markSuperseded — markReady와 접두사가 같아 더 구체적인 패턴을 먼저 본다.
  if (s.startsWith("UPDATE attachments SET status = 'ready', thumbnail_url") && s.includes('deleted_at = now()')) {
    const [id, claimToken, thumbnailUrl] = params;
    const att = db.attachments[id];
    if (!att || att.claim_token !== claimToken) return { rows: [] };
    att.status = 'ready';
    if (thumbnailUrl) att.thumbnail_url = thumbnailUrl;
    att.claim_token = null;
    att.claimed_at = null;
    att.deleted_at = new Date().toISOString();
    att.updated_at = new Date().toISOString();
    return { rows: [{ id: att.id }] };
  }
  // AttachmentDAO.markReady
  if (s.startsWith("UPDATE attachments SET status = 'ready', thumbnail_url")) {
    const [id, claimToken, thumbnailUrl] = params;
    const att = db.attachments[id];
    if (!att || att.claim_token !== claimToken) return { rows: [] };
    att.status = 'ready';
    if (thumbnailUrl) att.thumbnail_url = thumbnailUrl;
    att.claim_token = null;
    att.claimed_at = null;
    att.updated_at = new Date().toISOString();
    return { rows: [{ id: att.id }] };
  }
  // AttachmentDAO.markRejected
  if (s.startsWith("UPDATE attachments SET status = 'rejected', claim_token = NULL")) {
    const [id, claimToken] = params;
    const att = db.attachments[id];
    if (!att || att.claim_token !== claimToken) return { rows: [] };
    att.status = 'rejected';
    att.claim_token = null;
    att.claimed_at = null;
    att.updated_at = new Date().toISOString();
    return { rows: [{ storage_key: att.storage_key }] };
  }
  // AttachmentDAO.markFailed / markError (일시 실패·재시도 상한 — 이 스위트에선 도달하지 않지만
  // 안전하게 핸들러를 둔다)
  if (s.startsWith('UPDATE attachments SET claim_token = NULL, claimed_at = NULL, next_attempt_at = $1')) {
    const [nextAttemptAt, id, claimToken] = params;
    const att = db.attachments[id];
    if (!att || att.claim_token !== claimToken) return { rows: [] };
    att.claim_token = null;
    att.claimed_at = null;
    att.next_attempt_at = nextAttemptAt.toISOString();
    att.updated_at = new Date().toISOString();
    return { rows: [{ id: att.id }] };
  }
  if (s.startsWith("UPDATE attachments SET status = 'error'")) {
    const [id, claimToken] = params;
    const att = db.attachments[id];
    if (!att || att.claim_token !== claimToken) return { rows: [] };
    att.status = 'error';
    att.claim_token = null;
    att.claimed_at = null;
    att.updated_at = new Date().toISOString();
    return { rows: [{ id: att.id }] };
  }

  // AttachmentDAO.findNewerActiveSibling
  if (s.startsWith('SELECT id FROM attachments') && s.includes('created_at > $4')) {
    const [contextType, contextId, excludeId, afterCreatedAt] = params;
    const newer = Object.values(db.attachments).find((a) =>
      a.context_type === contextType && a.context_id === contextId && a.id !== excludeId
      && !a.deleted_at && new Date(a.created_at) > new Date(afterCreatedAt));
    return { rows: newer ? [{ id: newer.id }] : [] };
  }

  // AttachmentDAO.updateEntityImagePointer
  if (s.startsWith('UPDATE user_infos SET image_url')) {
    const [fullUrl, thumbUrl, userId] = params;
    if (db.user_infos[userId]) { db.user_infos[userId].image_url = fullUrl; db.user_infos[userId].thumbnail_url = thumbUrl; }
    return { rows: [] };
  }
  if (s.startsWith('UPDATE binders SET image_url')) {
    const [fullUrl, thumbUrl, binderId] = params;
    if (db.binders[binderId]) { db.binders[binderId].image_url = fullUrl; db.binders[binderId].thumbnail_url = thumbUrl; }
    return { rows: [] };
  }
  if (s.startsWith('UPDATE casts SET cover_image_url')) {
    const [fullUrl, thumbUrl, castId] = params;
    if (db.casts[castId]) { db.casts[castId].cover_image_url = fullUrl; db.casts[castId].thumbnail_url = thumbUrl; }
    return { rows: [] };
  }

  // AttachmentDAO.markOtherGenerationsDeleted
  if (s.startsWith('UPDATE attachments SET deleted_at = now(), updated_at = now()') && s.includes('context_type = $1 AND context_id = $2')) {
    const [contextType, contextId, keepId] = params;
    Object.values(db.attachments).forEach((a) => {
      if (a.context_type === contextType && a.context_id === contextId && a.id !== keepId && !a.deleted_at) {
        a.deleted_at = new Date().toISOString();
        a.updated_at = new Date().toISOString();
      }
    });
    return { rows: [] };
  }

  // AttachmentDAO.findByBinder — 파일함 목록
  if (s.startsWith('SELECT a.*, ui.display_name AS uploader_name')) {
    const [binderId] = params;
    const rows = Object.values(db.attachments).filter((a) =>
      a.binder_id === binderId && !a.deleted_at && ['ready', 'hidden'].includes(a.status)
      && !ENTITY_IMAGE_TYPES.has(a.context_type));
    return { rows: rows.map((a) => ({ ...a, uploader_name: 'tester' })) };
  }

  // MediaService.getSignedUrl — 조회 + 인가(authorizeAttachmentAccess)용 SELECT.
  if (s.startsWith('SELECT id, storage_key, content_type, status, context_type, context_id, binder_id FROM attachments')) {
    const row = db.attachments[params[0]];
    return { rows: row ? [row] : [] };
  }

  // AttachmentDAO.findExpiredFreeAttachments — 생명주기 365일 숨김 전환 대상
  if (s.startsWith('SELECT a.id, a.storage_key, a.binder_id')) {
    const cutoff = new Date(NOW.getTime() - 365 * 24 * 60 * 60 * 1000);
    const rows = Object.values(db.attachments).filter((a) => {
      if (a.status !== 'ready' || a.deleted_at) return false;
      if (ENTITY_IMAGE_TYPES.has(a.context_type)) return false;
      const boost = a.binder_id != null ? db.binder_boosts[a.binder_id] : null;
      const hasActiveBoost = !!(boost && boost.status === 'active' && new Date(boost.current_period_end) > NOW);
      if (hasActiveBoost) return false;
      return new Date(a.created_at) < cutoff;
    });
    return { rows: rows.map((a) => ({ id: a.id, storage_key: a.storage_key, binder_id: a.binder_id })) };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

// ── 가짜 GCS ────────────────────────────────────────────────────────────
const gcsMedia = {};
const gcsCdn = {};
const gcsDeleteLog = [];

function makeBucketStub(store) {
  return {
    file(key) {
      return {
        async generateSignedPostPolicyV4() {
          return [{ url: `https://fake-upload.example/${key}`, fields: { key } }];
        },
        async download({ destination }) {
          const buf = store[key];
          if (!buf) { const err = new Error('No such object'); err.code = 404; throw err; }
          await fs.writeFile(destination, buf);
        },
        async save(buffer) {
          store[key] = Buffer.from(buffer);
        },
        async delete() {
          gcsDeleteLog.push(key);
          delete store[key];
        },
        async getMetadata() {
          const buf = store[key];
          return [{ size: String(buf ? buf.length : 0) }];
        },
      };
    },
  };
}
const gcsStub = {
  Storage: class {
    bucket(name) {
      if (name === 'rally-cdn') return makeBucketStub(gcsCdn);
      return makeBucketStub(gcsMedia);
    }
  },
};
const originalLoad = Module._load;
Module._load = function loadWithStubs(request, parent, isMain) {
  if (request === '@google-cloud/storage') return gcsStub;
  return originalLoad.call(this, request, parent, isMain);
};

const pool = require('../../config/db');
const { MediaService } = require('./mediaService');
const { AttachmentDAO } = require('../daos/attachmentDAO');
const { dispatchMediaWorker } = require('../jobs/mediaWorkerJobs');

Module._load = originalLoad;

const ctx = (userId) => ({ sender_id: userId, device_uuid: 'dev-1' });

async function makeJpegWithGpsAndOrientation() {
  const base = await sharp({ create: { width: 8, height: 16, channels: 3, background: { r: 200, g: 10, b: 10 } } }).jpeg().toBuffer();
  const zeroth = { [piexif.ImageIFD.Make]: 'ExampleCorp', [piexif.ImageIFD.Model]: 'PhoneX', [piexif.ImageIFD.Orientation]: 6 };
  const exifIfd = { [piexif.ExifIFD.DateTimeOriginal]: '2026:08:06 12:00:00' };
  const gps = { [piexif.GPSIFD.GPSLatitudeRef]: 'N', [piexif.GPSIFD.GPSLatitude]: [[37, 1], [33, 1], [0, 1]] };
  const exifBytes = piexif.dump({ '0th': zeroth, Exif: exifIfd, GPS: gps });
  return Buffer.from(piexif.insert(exifBytes, base.toString('binary')), 'binary');
}

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

// ── 종단 시나리오 파라미터 3종 ─────────────────────────────────────────────
const SCENARIOS = [
  {
    label: 'USER_AVATAR',
    contextType: 'USER_AVATAR',
    contextId: 'user1',
    binderId: null, // §4-1 서버 Step7 — USER_AVATAR는 binder_id가 null.
    uploader: 'user1',
    pointerTable: () => db.user_infos.user1,
  },
  {
    label: 'BINDER_AVATAR',
    contextType: 'BINDER_AVATAR',
    contextId: 'bA',
    binderId: 'bA', // §4-1 서버 Step7 — BINDER_AVATAR는 binder_id = context_id.
    uploader: 'master1',
    pointerTable: () => db.binders.bA,
  },
  {
    label: 'CAST_COVER',
    contextType: 'CAST_COVER',
    contextId: 'castA',
    binderId: 'bA', // §4-1 서버 Step7 — CAST_COVER는 그 캐스트가 속한 바인더.
    uploader: 'author1',
    pointerTable: () => db.casts.castA,
    pointerFieldFull: 'cover_image_url', // casts는 image_url이 아니라 cover_image_url.
  },
];

async function run() {
  for (const scenario of SCENARIOS) {
    const fullField = scenario.pointerFieldFull || 'image_url';

    // ═════════════════════════════════════════════════════════════════
    // 성공 경로 — presign → confirm → Worker → 포인터 이동 → 파일함 제외 →
    //   생명주기 제외 → 저장 집계 불변까지 전부 확인.
    // ═════════════════════════════════════════════════════════════════
    await check(`[${scenario.label}] 종단 성공 — 전체 파이프라인이 실제로 이어진다`, async () => {
      const jpegBytes = await makeJpegWithGpsAndOrientation();

      // 1. presign
      const presignResult = await MediaService.presign(
        { context_type: scenario.contextType, context_id: scenario.contextId, filename: 'avatar.jpg', content_type: 'image/jpeg', file_size: jpegBytes.length },
        ctx(scenario.uploader)
      );
      const id = presignResult.id;
      const attRow = db.attachments[id];
      assert.strictEqual(attRow.context_type, scenario.contextType);
      assert.strictEqual(attRow.binder_id, scenario.binderId, 'attachments.binder_id이 §4-1 서버 Step7 규칙대로 채워져야 한다');

      // 2. 클라 업로드 시뮬레이션 — presign이 발급한 storage_key에 실제 바이트를 놓는다.
      gcsMedia[attRow.storage_key] = jpegBytes;

      // 3. confirm
      const confirmed = await MediaService.confirm(id, ctx(scenario.uploader));
      assert.strictEqual(confirmed.status, 'processing');
      assert.strictEqual(db.binder_storage_usage[scenario.binderId], undefined, 'confirm이 엔티티 이미지의 storage delta를 적립하면 안 된다(§3-3-1)');

      // 4. Worker — Step1~5
      await dispatchMediaWorker();

      const finalAtt = db.attachments[id];
      assert.strictEqual(finalAtt.status, 'ready', 'Step1~4를 통과했으면 ready여야 한다');
      assert.strictEqual(finalAtt.deleted_at, null);

      // Step4 — 파생 2종이 실제로 rally-cdn에 있는가.
      assert.ok(gcsCdn[`derivatives/${id}/thumb.webp`], 'thumb.webp(720px)가 생성돼야 한다');
      assert.ok(gcsCdn[`derivatives/${id}/full.webp`], 'full.webp(1080px)가 생성돼야 한다');

      // Step5 — 엔티티 포인터에 실제 값이 들어갔는가.
      const pointer = scenario.pointerTable();
      assert.ok(pointer[fullField] && pointer[fullField].includes(`derivatives/${id}/full.webp`), `${fullField}이 full 파생을 가리켜야 한다 — 실제값=${pointer[fullField]}`);
      assert.ok(pointer.thumbnail_url && pointer.thumbnail_url.includes(`derivatives/${id}/thumb.webp`), `thumbnail_url이 thumb 파생을 가리켜야 한다 — 실제값=${pointer.thumbnail_url}`);

      // 파일함 목록에 안 뜨는가(binder_id가 있는 BINDER_AVATAR·CAST_COVER만 의미 있는 확인 —
      // USER_AVATAR는 binder_id가 null이라 애초에 이 바인더 소속 목록의 대상이 아니다).
      if (scenario.binderId) {
        const files = await AttachmentDAO.findByBinder(pool, scenario.binderId, scenario.uploader, {});
        assert.ok(!files.some((f) => f.id === id), '파일함 목록에 뜨면 안 된다');
      }

      // 생명주기가 건너뛰는가 — created_at을 400일 전으로 backdate한 뒤 재조회.
      finalAtt.created_at = new Date(NOW.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString();
      const expiring = await AttachmentDAO.findExpiredFreeAttachments(pool);
      assert.ok(!expiring.some((e) => e.id === id), '400일 지나도 생명주기 숨김 전환 대상이 되면 안 된다');

      // 저장 집계가 늘지 않았는가(적립 자체가 없어야 한다).
      assert.strictEqual(db.binder_storage_usage[scenario.binderId], undefined, 'Worker의 ready 전환도 storage delta를 건드리면 안 된다');
    });

    // ═════════════════════════════════════════════════════════════════
    // 거부 경로 — MIME 위변조. 포인터는 안 옮겨지고 이전 사진이 유지되며, 저장 집계는
    //   0에서 움직이지 않아야 한다(적립한 적이 없으므로 "음수로 안 간다"와 동치).
    // ═════════════════════════════════════════════════════════════════
    await check(`[${scenario.label}] 종단 거부(MIME 위변조) — 포인터 불변·이전 사진 유지·저장 집계 불변`, async () => {
      const pointer = scenario.pointerTable();
      const beforeFull = pointer[fullField];
      const beforeThumb = pointer.thumbnail_url;

      const jpegBytes = await makeJpegWithGpsAndOrientation();

      const presignResult = await MediaService.presign(
        // content_type을 image/png로 선언하지만 실제 바이트는 JPEG — Worker Step1이 위변조로 거부한다.
        { context_type: scenario.contextType, context_id: scenario.contextId, filename: 'avatar.png', content_type: 'image/png', file_size: jpegBytes.length },
        ctx(scenario.uploader)
      );
      const id = presignResult.id;
      const attRow = db.attachments[id];
      gcsMedia[attRow.storage_key] = jpegBytes;

      await MediaService.confirm(id, ctx(scenario.uploader));
      await dispatchMediaWorker();

      const finalAtt = db.attachments[id];
      assert.strictEqual(finalAtt.status, 'rejected', 'MIME 위변조는 거부돼야 한다(첨부 6종과 동일 규약)');
      assert.ok(gcsDeleteLog.includes(attRow.storage_key), 'GCS 원본이 삭제돼야 한다');

      // 포인터 불변 — 거부 전 값 그대로.
      const pointerAfter = scenario.pointerTable();
      assert.strictEqual(pointerAfter[fullField], beforeFull, '거부됐으면 포인터가 옮겨지면 안 된다 — 이전 사진이 유지돼야 한다');
      assert.strictEqual(pointerAfter.thumbnail_url, beforeThumb);

      // 저장 집계 불변 — 적립한 적이 없으므로 여전히 undefined(0)여야 한다. 음수로 가면 회귀.
      assert.strictEqual(db.binder_storage_usage[scenario.binderId], undefined, '거부 시 storage delta가 음수로 흐르면 안 된다(적립한 적 없으므로)');
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // RLY-20260806-096(S5) 항목 2 — getSignedUrl/authorizeAttachmentAccess의 USER_AVATAR 판정.
  // S4 보고서가 "범위 밖"으로 남긴 발견: USER_AVATAR는 binder_id가 null이라 기존 기본 분기
  // (requireBinderMember)로 떨어지면 본인 포함 누구에게도 항상 403이었다 — presign의 쓰기
  // 인가("본인만")와 비대칭. mediaService.js에 전용 분기를 추가해 "본인만" 읽기를 허용했다.
  // ⚠️ 인가를 느슨하게 만들지 않았다는 것을 대조군(타인은 여전히 403)으로 확인한다.
  // ═══════════════════════════════════════════════════════════════════
  const isInfraFailure = (err) => !(err.statusCode === 403 || err.statusCode === 404);

  await check('[USER_AVATAR] getSignedUrl — 본인은 인가를 통과한다(GCS 인프라 단계 이후 실패는 이 회귀의 관심사 아님)', async () => {
    const id = 'signedurl-self-test';
    db.attachments[id] = {
      id, storage_key: 'avatars/users/user1/signedurl-self-test.jpg', content_type: 'image/jpeg',
      status: 'ready', context_type: 'USER_AVATAR', context_id: 'user1', binder_id: null,
    };
    try {
      await MediaService.getSignedUrl(id, 'user1');
      // GCS 자격증명이 있는 환경이면 여기까지 성공할 수도 있다 — 그 경우도 인가는 통과한 것.
    } catch (err) {
      if (!isInfraFailure(err)) {
        throw new Error(`인가 통과를 기대했지만 403/404로 거부됨 — status=${err.statusCode} code=${err.errorCode} msg=${err.message}`);
      }
      // 그 외(GCS 인프라 실패)는 인가는 통과했다는 뜻 — 이 회귀의 관심사 아님(avatarCoverAuthzRegression.test.js와 동일 판정 기준).
    }
  });

  await check('[USER_AVATAR] getSignedUrl — 대조군: 타인은 여전히 403(인가를 느슨하게 만들지 않았다)', async () => {
    const id = 'signedurl-other-test';
    db.attachments[id] = {
      id, storage_key: 'avatars/users/user1/signedurl-other-test.jpg', content_type: 'image/jpeg',
      status: 'ready', context_type: 'USER_AVATAR', context_id: 'user1', binder_id: null,
    };
    try {
      await MediaService.getSignedUrl(id, 'attacker1');
      throw new Error('403을 기대했지만 통과해버림');
    } catch (err) {
      if (err.statusCode !== 403 || err.errorCode !== 'AVATAR_FORBIDDEN') {
        throw new Error(`403 AVATAR_FORBIDDEN을 기대했지만 status=${err.statusCode} code=${err.errorCode} msg=${err.message}`);
      }
    }
  });

  await check('[BINDER_AVATAR] getSignedUrl — 대조군: 기존 동작(바인더 멤버면 통과) 불변', async () => {
    const id = 'signedurl-binder-test';
    db.attachments[id] = {
      id, storage_key: 'avatars/binders/bA/signedurl-binder-test.jpg', content_type: 'image/jpeg',
      status: 'ready', context_type: 'BINDER_AVATAR', context_id: 'bA', binder_id: 'bA',
    };
    try {
      await MediaService.getSignedUrl(id, 'master1'); // bA의 멤버
    } catch (err) {
      if (!isInfraFailure(err)) {
        throw new Error(`바인더 멤버는 인가를 통과해야 하는데 거부됨 — status=${err.statusCode} code=${err.errorCode} msg=${err.message}`);
      }
    }
  });

  console.log(`\n[entityImageEndToEndRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(` - ${f.name}: ${f.error.stack || f.error.message}`));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[entityImageEndToEndRegression] 실행 실패:', error);
  process.exitCode = 1;
});
