/**
 * src/jobs/mediaWorkerJobs.test.js
 * =========================================
 * RLY-20260806-047 — media.md §4-4 Worker 파이프라인 회귀 스위트.
 *
 * 이 저장소에는 테스트 프레임워크가 없다(`npm test`는 실패하는 placeholder). 기존 관행(plain
 * assert + `node <file>.js` 직접 실행, require.cache로 config/db·@google-cloud/storage를 가짜로
 * 교체 후 실제 서비스·DAO·워커 코드를 구동) — storageQuotaRegression.test.js와 동일 패턴.
 *
 * GCS만 스텁한다. sharp·piexifjs·png-chunks-*·ffmpeg-static은 전부 실제 라이브러리를 그대로
 * 써서 진짜 JPEG/PNG/비디오 바이트로 파이프라인을 구동한다(문서 §4-4 Step1·3·4의 실질 동작을
 * 검증하려면 매직 바이트 감지·EXIF 조작·프레임 추출이 실제로 일어나야 한다).
 *
 * 최소 6건(team-lead 지시):
 *   ① MIME 위변조 검출  ② 상태 전이 pending→processing→ready  ③ 실패 시 처리(결정적/일시적)
 *   ④ 용량 집계 시점 불변(processing→ready 전환에 델타가 안 움직임)
 *   ⑤ 크기 재확인 불변 — storageQuotaRegression.test.js(23/23) 재검증으로 충족(그 파일 참조)
 *   ⑥ Step2(악성코드 스캔) 미구현 고정
 *
 * 실행: node src/jobs/mediaWorkerJobs.test.js
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

// ── 가짜 DB ─────────────────────────────────────────────────────────────
const db = { attachments: {}, binder_storage_usage: {} };

let nextId = 1;
function seedAttachment(fields) {
  const id = `att-${nextId++}`;
  db.attachments[id] = {
    id,
    binder_id: 'b1',
    context_type: 'SECTION_MESSAGE',
    context_id: null,
    uploader_id: 'u1',
    filename: 'f',
    display_order: 0,
    storage_class: 'standard',
    thumbnail_url: null,
    claim_token: null,
    claimed_at: null,
    attempt_count: 0,
    next_attempt_at: null,
    deleted_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...fields,
  };
  return id;
}

function norm(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

async function mockQuery(sql, params = []) {
  const s = norm(sql);
  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // MediaService.confirm — 사전 확인
  if (s.startsWith("SELECT id, binder_id, storage_key, file_size FROM attachments WHERE id = $1 AND uploader_id = $2 AND status = 'pending'")) {
    const [id, uploaderId] = params;
    const att = db.attachments[id];
    if (!att || att.uploader_id !== uploaderId || att.status !== 'pending') return { rows: [] };
    return { rows: [{ id: att.id, binder_id: att.binder_id, storage_key: att.storage_key, file_size: att.file_size }] };
  }

  // MediaService.confirm — 최종 확정. RLY-20260806-047: status='processing'로 바뀐 지점.
  if (s.startsWith("UPDATE attachments SET status = 'processing'")) {
    const [id, uploaderId, actualSize] = params;
    const att = db.attachments[id];
    if (!att || att.uploader_id !== uploaderId || att.status !== 'pending') return { rows: [] };
    att.status = 'processing';
    att.file_size = actualSize;
    att.updated_at = new Date().toISOString();
    return { rows: [{ ...att }] };
  }

  // AttachmentDAO.applyStorageDelta — 경계 판정 SELECT
  if (s.startsWith('SELECT NOT EXISTS')) {
    const [binderId, storageKey, attachmentId] = params;
    const exists = Object.values(db.attachments).some(
      (a) => a.binder_id === binderId && a.storage_key === storageKey && !a.deleted_at && a.id !== attachmentId
    );
    return { rows: [{ is_boundary: !exists }] };
  }
  // AttachmentDAO.applyStorageDelta — upsert
  if (s.startsWith('INSERT INTO binder_storage_usage')) {
    const [binderId, delta] = params;
    if (!db.binder_storage_usage[binderId]) db.binder_storage_usage[binderId] = { binder_id: binderId, bytes_used: 0 };
    db.binder_storage_usage[binderId].bytes_used += delta;
    return { rows: [] };
  }

  // AttachmentDAO.claimProcessingBatch — 단일 원자 UPDATE...WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)
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

  // AttachmentDAO.markFailed
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

  // AttachmentDAO.markError
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

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
const dbPath = require.resolve('../../config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

// ── 가짜 GCS ────────────────────────────────────────────────────────────
// storage_key/derivativeKey → Buffer. 버킷 이름으로 media/cdn을 구분한다(실제 코드가 쓰는
// 기본값 'rally-media'/'rally-cdn' — env 미설정 시 mediaService.js·mediaWorkerJobs.js 둘 다
// 같은 기본값을 쓴다).
const gcsMedia = {};
const gcsCdn = {};
const gcsDeleteLog = [];
let downloadFailureOnce = null; // { key, error } — 다음 해당 key 다운로드 1회만 실패시킨다.

function makeBucketStub(store) {
  return {
    file(key) {
      return {
        async download({ destination }) {
          if (downloadFailureOnce && downloadFailureOnce.key === key) {
            const err = downloadFailureOnce.error;
            downloadFailureOnce = null;
            throw err;
          }
          const buf = store[key];
          if (!buf) {
            const err = new Error('No such object');
            err.code = 404;
            throw err;
          }
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

const { MediaService } = require('../services/mediaService');
const logger = require('../utils/logger');
const eventBus = require('../events/eventBus');
const { dispatchMediaWorker } = require('./mediaWorkerJobs');

Module._load = originalLoad; // 이후 일반 require는 정상 경로로.

const ctx = (userId) => ({ sender_id: userId, device_uuid: 'dev-1' });

// ── 로그·이벤트 스파이 ──────────────────────────────────────────────────
const warnLog = [];
const originalWarn = logger.warn;
logger.warn = (message, meta) => {
  warnLog.push({ message, meta });
  return originalWarn(message, meta);
};

const wsEvents = [];
eventBus.on('ws:broadcast', (payload) => wsEvents.push(payload));

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

// ── 픽스처 생성 헬퍼 ────────────────────────────────────────────────────
async function makeJpegWithGpsAndOrientation() {
  const base = await sharp({ create: { width: 8, height: 16, channels: 3, background: { r: 200, g: 10, b: 10 } } }).jpeg().toBuffer();
  const zeroth = { [piexif.ImageIFD.Make]: 'ExampleCorp', [piexif.ImageIFD.Model]: 'PhoneX', [piexif.ImageIFD.Orientation]: 6 };
  const exifIfd = { [piexif.ExifIFD.DateTimeOriginal]: '2026:08:06 12:00:00' };
  const gps = { [piexif.GPSIFD.GPSLatitudeRef]: 'N', [piexif.GPSIFD.GPSLatitude]: [[37, 1], [33, 1], [0, 1]] };
  const exifBytes = piexif.dump({ '0th': zeroth, Exif: exifIfd, GPS: gps });
  return Buffer.from(piexif.insert(exifBytes, base.toString('binary')), 'binary');
}

async function makePng() {
  return sharp({ create: { width: 6, height: 6, channels: 3, background: { r: 0, g: 200, b: 0 } } }).png().toBuffer();
}

async function run() {
  // ═══════════════════════════════════════════════════════════════════
  // ① MIME 위변조 검출 — content_type은 image/png인데 실제 바이트는 JPEG.
  // ═══════════════════════════════════════════════════════════════════
  await check('① MIME 위변조 → status=rejected + GCS 객체 삭제 + attachment_rejected 브로드캐스트', async () => {
    const jpegBytes = await makeJpegWithGpsAndOrientation();
    const key = 'attachments/b1/2026/08/mime-mismatch.png';
    gcsMedia[key] = jpegBytes;
    const id = seedAttachment({ status: 'processing', storage_key: key, content_type: 'image/png', file_size: jpegBytes.length });
    // F-S9 — confirm()이 이미 반영했을 quota를 흉내낸다(실제로는 confirm 시점에 적용됨).
    // 이 UPDATE는 rally-media 안 file_size가 이미 binder_storage_usage에 잡혀 있다는 전제만
    // 재현하면 되므로 quota를 직접 세팅한다.
    db.binder_storage_usage.b1 = { binder_id: 'b1', bytes_used: (db.binder_storage_usage.b1?.bytes_used || 0) + jpegBytes.length };
    const quotaBefore = db.binder_storage_usage.b1.bytes_used;

    wsEvents.length = 0;
    // claimProcessingBatch부터 정식으로 태워야 claim_token이 실제로 채워져 markRejected의
    // claim_token 일치 검사(경합 방지)를 통과한다 — dispatchOne을 임의 토큰으로 직접 부르면
    // claim_token 불일치로 markRejected가 조용히 no-op된다.
    await dispatchMediaWorker();

    assert.strictEqual(db.attachments[id].status, 'rejected', '위조 MIME은 거부돼야 한다');
    assert.ok(gcsDeleteLog.includes(key), 'GCS 원본이 삭제돼야 한다');
    assert.strictEqual(
      db.binder_storage_usage.b1.bytes_used, quotaBefore - jpegBytes.length,
      'confirm 시점에 이미 반영된 quota를 거부 시 되돌려줘야 한다(GCS 객체도 지웠으므로) — Worker가 confirm 이후 거부를 새로 도입해 생긴 지점, deleteAttachment와 동일 패턴으로 해소'
    );
    assert.ok(
      wsEvents.some((e) => e.type === 'attachment_rejected' && e.payload.attachment_id === id),
      'attachment_rejected 브로드캐스트가 나가야 한다'
    );
  });

  // ═══════════════════════════════════════════════════════════════════
  // ② 상태 전이 pending → processing → ready (confirm + Worker 풀 사이클)
  // ═══════════════════════════════════════════════════════════════════
  await check('② pending→processing(confirm)→ready(Worker) — EXIF 파기·썸네일까지 실제로 수행', async () => {
    const jpegBytes = await makeJpegWithGpsAndOrientation();
    const key = 'attachments/b1/2026/08/happy.jpg';
    gcsMedia[key] = jpegBytes;
    const id = seedAttachment({ status: 'pending', storage_key: key, content_type: 'image/jpeg', file_size: jpegBytes.length });

    await MediaService.confirm(id, ctx('u1'));
    assert.strictEqual(db.attachments[id].status, 'processing', 'confirm 직후는 processing이어야 한다(예전엔 ready로 직행했다)');

    wsEvents.length = 0;
    await dispatchMediaWorker();

    const att = db.attachments[id];
    assert.strictEqual(att.status, 'ready', 'Worker 완료 후 ready여야 한다');
    assert.ok(att.thumbnail_url && att.thumbnail_url.includes(`derivatives/${id}/thumb.webp`), '썸네일 URL이 채워져야 한다');
    assert.strictEqual(att.claim_token, null, 'claim이 해제돼야 한다');
    assert.ok(gcsCdn[`derivatives/${id}/thumb.webp`], 'rally-cdn에 실제 썸네일 오브젝트가 있어야 한다');

    // Step3 — 원본이 EXIF 파기된 채로 덮어써졌는가(GPS 제거·Orientation 보존)를 실측한다.
    const storedOriginal = gcsMedia[key];
    const reloaded = piexif.load(storedOriginal.toString('binary'));
    assert.deepStrictEqual(reloaded.GPS, {}, 'Step3: GPS는 제거돼야 한다');
    assert.strictEqual(reloaded['0th'][piexif.ImageIFD.Orientation], 6, 'Step3: Orientation은 보존돼야 한다(회전 정보 손실 방지)');
    assert.strictEqual(reloaded['0th'][piexif.ImageIFD.Make], undefined, 'Step3: 기기 모델은 제거돼야 한다');

    // 픽셀 데이터는 원본과 동일해야 한다(재인코딩 없음).
    const rawBefore = await sharp(jpegBytes).raw().toBuffer();
    const rawAfter = await sharp(storedOriginal).raw().toBuffer();
    assert.ok(rawBefore.equals(rawAfter), 'Step3: 픽셀 데이터가 원본과 바이트 단위로 동일해야 한다(재인코딩 없음)');

    assert.ok(
      wsEvents.some((e) => e.type === 'attachment_ready' && e.payload.attachment_id === id),
      'attachment_ready 브로드캐스트가 나가야 한다'
    );
  });

  // PNG 경로도 대칭으로 확인 — 청크 단위 제거가 실제로 동작하는가.
  await check('② PNG도 동일 경로로 ready 전환 + eXIf 청크 제거(픽셀 불변)', async () => {
    const pngBytes = await makePng();
    const withExif = await sharp(pngBytes).withMetadata({ exif: { IFD0: { Copyright: 'secret' } } }).png().toBuffer();
    const key = 'attachments/b1/2026/08/happy.png';
    gcsMedia[key] = withExif;
    const id = seedAttachment({ status: 'processing', storage_key: key, content_type: 'image/png', file_size: withExif.length });

    await dispatchMediaWorker();

    assert.strictEqual(db.attachments[id].status, 'ready');
    const rawBefore = await sharp(withExif).raw().toBuffer();
    const rawAfter = await sharp(gcsMedia[key]).raw().toBuffer();
    assert.ok(rawBefore.equals(rawAfter), 'PNG도 픽셀 데이터가 동일해야 한다');
  });

  // 비디오 — Step4가 ffmpeg로 실제 포스터를 뽑는가.
  await check('② 비디오는 EXIF 단계 없이 포스터(webp)만 생성', async () => {
    const { execFile } = require('child_process');
    const ffmpegPath = require('ffmpeg-static');
    const os = require('os');
    const path = require('path');
    const tmpVideo = path.join(os.tmpdir(), `rally-test-${Date.now()}.mp4`);
    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x48:rate=5', '-pix_fmt', 'yuv420p', tmpVideo], (err) => (err ? reject(err) : resolve()));
    });
    const videoBytes = await fs.readFile(tmpVideo);
    await fs.rm(tmpVideo, { force: true });

    const key = 'attachments/b1/2026/08/happy.mp4';
    gcsMedia[key] = videoBytes;
    const id = seedAttachment({ status: 'processing', storage_key: key, content_type: 'video/mp4', file_size: videoBytes.length });

    await dispatchMediaWorker();

    const att = db.attachments[id];
    assert.strictEqual(att.status, 'ready');
    assert.ok(att.thumbnail_url.includes(`derivatives/${id}/poster.webp`), '비디오는 poster.webp를 써야 한다');
    assert.ok(gcsCdn[`derivatives/${id}/poster.webp`], 'rally-cdn에 포스터가 있어야 한다');
  });

  // ═══════════════════════════════════════════════════════════════════
  // ③ 실패 시 처리 — 결정적 실패(콘텐츠 손상) vs 일시적 실패(GCS 네트워크)
  // ═══════════════════════════════════════════════════════════════════
  await check('③-a 손상된 이미지 바이트(Step3 파싱 실패) → 재시도 없이 즉시 error', async () => {
    const garbage = Buffer.from('not a real jpeg but declared as one — garbage bytes for exif parsing');
    const key = 'attachments/b1/2026/08/corrupt.jpg';
    gcsMedia[key] = garbage;
    const id = seedAttachment({ status: 'processing', storage_key: key, content_type: 'image/jpeg', file_size: garbage.length });

    await dispatchMediaWorker();

    assert.strictEqual(db.attachments[id].status, 'error', '콘텐츠 처리 실패는 재시도하지 않고 즉시 error여야 한다');
    assert.strictEqual(db.attachments[id].attempt_count, 1, '첫 시도에서 바로 종결돼야 한다(백오프 재시도 없음)');
  });

  await check('③-b GCS 다운로드 일시 실패 → 재시도(백오프), status는 processing 유지', async () => {
    const jpegBytes = await makeJpegWithGpsAndOrientation();
    const key = 'attachments/b1/2026/08/transient.jpg';
    gcsMedia[key] = jpegBytes;
    const id = seedAttachment({ status: 'processing', storage_key: key, content_type: 'image/jpeg', file_size: jpegBytes.length });

    downloadFailureOnce = { key, error: Object.assign(new Error('ECONNRESET (fake)'), { code: 'ECONNRESET' }) };
    await dispatchMediaWorker();

    const att = db.attachments[id];
    assert.strictEqual(att.status, 'processing', '일시적 실패는 processing에 남아 재claim 가능해야 한다');
    assert.strictEqual(att.claim_token, null, '실패 후 lease를 놓아 다음 tick에 재claim 가능해야 한다');
    assert.ok(att.next_attempt_at, '백오프를 위한 next_attempt_at이 설정돼야 한다');
    assert.strictEqual(att.attempt_count, 1, '시도 횟수가 기록돼야 한다');

    // 재시도 후 성공 확인 — next_attempt_at을 과거로 되돌려 즉시 재claim 가능하게 한 뒤 재실행.
    att.next_attempt_at = new Date(Date.now() - 1000).toISOString();
    await dispatchMediaWorker();
    assert.strictEqual(db.attachments[id].status, 'ready', '재시도가 성공하면 정상적으로 ready에 도달해야 한다');
  });

  await check('③-c 재시도 상한 도달 → error로 종결(무한 재시도 금지)', async () => {
    const jpegBytes = await makeJpegWithGpsAndOrientation();
    const key = 'attachments/b1/2026/08/maxattempts.jpg';
    gcsMedia[key] = jpegBytes;
    // attempt_count=4로 시작 — claim 시 5로 올라가 MAX_ATTEMPTS(5)에 도달한다.
    const id = seedAttachment({ status: 'processing', storage_key: key, content_type: 'image/jpeg', file_size: jpegBytes.length, attempt_count: 4 });

    downloadFailureOnce = { key, error: new Error('persistent failure (fake)') };
    await dispatchMediaWorker();

    assert.strictEqual(db.attachments[id].status, 'error', '상한 도달 시 무한 재시도하지 않고 error로 종결해야 한다');
  });

  // ═══════════════════════════════════════════════════════════════════
  // ④ 용량 집계 시점 불변 — confirm(processing 전환)에서 이미 반영되고, Worker의
  //    processing→ready 전환은 bytes_used를 다시 건드리지 않는다.
  // ═══════════════════════════════════════════════════════════════════
  await check('④ confirm 시점에 이미 집계되고, Worker의 ready 전환은 집계에 영향 없음', async () => {
    const jpegBytes = await makeJpegWithGpsAndOrientation();
    const key = 'attachments/b1/2026/08/quota.jpg';
    gcsMedia[key] = jpegBytes;
    const id = seedAttachment({ status: 'pending', storage_key: key, content_type: 'image/jpeg', file_size: jpegBytes.length });

    const before = (db.binder_storage_usage.b1 && db.binder_storage_usage.b1.bytes_used) || 0;
    await MediaService.confirm(id, ctx('u1'));
    const afterConfirm = db.binder_storage_usage.b1.bytes_used;
    assert.strictEqual(afterConfirm - before, jpegBytes.length, 'confirm(processing 전환) 시점에 파일 크기만큼 집계돼야 한다');

    await dispatchMediaWorker();
    assert.strictEqual(db.attachments[id].status, 'ready');
    assert.strictEqual(db.binder_storage_usage.b1.bytes_used, afterConfirm, 'processing→ready 전환은 집계를 바꾸면 안 된다');
  });

  // ═══════════════════════════════════════════════════════════════════
  // ⑤ 크기 재확인(RLY-20260806-015) 불변 — storageQuotaRegression.test.js(23/23)가 담당.
  //   이 파일은 그 파일의 로직을 건드리지 않았음을 소스 레벨로 재확인한다(교차 점검).
  // ═══════════════════════════════════════════════════════════════════
  await check('⑤ mediaService.js의 ±10% 크기 재확인 로직이 그대로 남아 있음(참조 무결성)', () => {
    const fsSync = require('fs');
    const src = fsSync.readFileSync(require.resolve('../services/mediaService.js'), 'utf8');
    assert.ok(src.includes('SIZE_MISMATCH_TOLERANCE_RATIO'), '±10% 재확인 상수가 남아 있어야 한다(047이 건드리지 않음)');
    assert.ok(src.includes("status = 'processing'"), 'confirm 최종 상태는 processing이어야 한다(047 핵심 수정)');
  });

  // ═══════════════════════════════════════════════════════════════════
  // ⑥ Step2(악성코드 스캔) 미구현 고정 — "스캔했다"는 신호를 남기지 않는다.
  // ═══════════════════════════════════════════════════════════════════
  await check('⑥ Step2는 명시적으로 미구현 — 처리마다 경고 로그를 남기고 아무 것도 스캔하지 않는다', async () => {
    const jpegBytes = await makeJpegWithGpsAndOrientation();
    const key = 'attachments/b1/2026/08/step2.jpg';
    gcsMedia[key] = jpegBytes;
    const id = seedAttachment({ status: 'processing', storage_key: key, content_type: 'image/jpeg', file_size: jpegBytes.length });

    warnLog.length = 0;
    await dispatchMediaWorker();

    const step2Warning = warnLog.find(
      (w) => typeof w.message === 'string' && w.message.includes('Step2') && w.message.toUpperCase().includes('NOT IMPLEMENTED')
    );
    assert.ok(step2Warning, 'Step2 실행마다 "NOT IMPLEMENTED" 경고 로그가 남아야 한다 — 스캐너 도입 시 이 단언이 바뀌어야 할 지점을 가리킨다');
    assert.ok(step2Warning.meta && step2Warning.meta.attachmentId === id, '어느 첨부에 대한 경고인지 식별 가능해야 한다');

    // "스캔했다"는 신호가 DB에 전혀 없다 — attachments 스키마에 scan 관련 필드 자체가 없음을
    // 소스 레벨로도 재확인(다음 사람이 몰래 scanned=true류 필드를 넣고 이 사실을 잊는 것을 방지).
    const fsSync = require('fs');
    const daoSrc = fsSync.readFileSync(require.resolve('../daos/attachmentDAO.js'), 'utf8');
    assert.ok(!/scanned|malware_scan|virus_scan/i.test(daoSrc), 'DAO에 "스캔 완료"를 뜻하는 필드/코드가 없어야 한다(거짓 신호 금지)');
  });

  // ═══════════════════════════════════════════════════════════════════
  // ⑦ RLY-20260806-084 — media.md §3-3-1: 엔티티 이미지 3종은 거부돼도 storage delta를
  //    건드리면 안 된다(confirm에서 애초에 +1을 적립하지 않았으므로). BINDER_AVATAR는
  //    binder_id가 채워져 있어(§4-1 서버 Step7) applyStorageDelta의 null 가드만으로는
  //    걸러지지 않는다 — rejectAttachment의 명시적 context_type 제외가 실제로 동작하는지 확인.
  // ═══════════════════════════════════════════════════════════════════
  await check('⑦ BINDER_AVATAR MIME 위변조 거부 — binder_storage_usage가 전혀 바뀌지 않는다(적립한 적 없으므로)', async () => {
    const jpegBytes = await makeJpegWithGpsAndOrientation();
    const key = 'avatars/binders/b1/entity-mime-mismatch.png';
    gcsMedia[key] = jpegBytes;
    const id = seedAttachment({
      status: 'processing', storage_key: key, content_type: 'image/png', file_size: jpegBytes.length,
      context_type: 'BINDER_AVATAR', context_id: 'b1', binder_id: 'b1',
    });
    // confirm()이 BINDER_AVATAR에 대해 애초에 delta를 적립하지 않았다는 전제를 그대로 재현한다
    // (§3-3-1 — 엔티티 이미지 3종은 binder_storage_usage 대상이 아니다).
    const quotaBefore = (db.binder_storage_usage.b1 && db.binder_storage_usage.b1.bytes_used) || 0;

    await dispatchMediaWorker();

    assert.strictEqual(db.attachments[id].status, 'rejected', 'BINDER_AVATAR도 첨부와 동일하게 MIME 위변조는 거부된다');
    assert.ok(gcsDeleteLog.includes(key), 'GCS 원본이 삭제돼야 한다(첨부와 동일 규약)');
    const quotaAfter = (db.binder_storage_usage.b1 && db.binder_storage_usage.b1.bytes_used) || 0;
    assert.strictEqual(quotaAfter, quotaBefore, '적립한 적 없는 바이트를 차감하면 안 된다 — binder_storage_usage가 음수로 흐르는 결함의 회귀');
  });

  console.log(`\n[mediaWorkerJobs] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(` - ${f.name}: ${f.error.stack || f.error.message}`));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[mediaWorkerJobs] 실행 실패:', error);
  process.exitCode = 1;
});
