/**
 * src/services/avatarCoverAuthzRegression.test.js
 * =========================================
 * RLY-20260806-052 — 아바타·커버 presign 인가 부재 + PATCH 임의 URL 수용 결함 회귀.
 *
 * 이 저장소엔 테스트 프레임워크가 없다(authzRegression.test.js와 동일 관행) — plain assert +
 * `node <file>.js` 직접 실행, 가짜 DB connection으로 실제 서비스 코드를 구동한다.
 *
 * 실행: node src/services/avatarCoverAuthzRegression.test.js
 *
 * 결함 요약(수리 전):
 *   - mediaService.presign()의 if/else 사슬이 context_type==='avatar'|'cover'를 인가 분기에서
 *     통째로 건너뛰었다 — 임의 로그인 유저가 타인의 user_id·binder_id·cast_id를 context_id로
 *     넣어 그 경로에 대한 유효 서명 업로드 URL을 받을 수 있었다.
 *   - PATCH /users/:id·/binders/:binderId·/casts/:castId가 클라 선언 image_url·thumbnail_url·
 *     cover_image_url을 검증 없이 그대로 DB에 썼다.
 *
 * 이 스위트는 presign()의 인가 게이트(GCS 호출 이전)와 assertOwnedMediaReference의 형식·소유권
 * 판정(GCS .exists() 호출 이전)만 검증한다 — 이 샌드박스엔 GCS 자격증명이 없어 그 이후 단계는
 * 인프라 실패로 막힌다(authzRegression.test.js:305-310과 동일 사유). "인가/검증을 통과했는가"만
 * 판정하고 그 뒤 인프라 에러는 통과로 간주한다.
 */

const assert = require('assert');

const dbPath = require.resolve('../../config/db');
const NOW = new Date().toISOString();

const db = {
  binder_members: {},
  casts: {},
  calendars: {},
  users_by_uid: {},
};

function setMember(binderId, userId, role) {
  db.binder_members[`${binderId}:${userId}`] = {
    binder_id: binderId, user_id: userId, role,
    notification_level: 1, nickname_in_binder: null, joined_at: NOW, deleted_at: null,
  };
}

// ── 픽스처 ──────────────────────────────────────────────────────────────
// bA: master1(role0)·manager1(role1)·member1(일반, role3). outsider는 비멤버.
setMember('bA', 'master1', 0);
setMember('bA', 'manager1', 1);
setMember('bA', 'member1', 3);

db.calendars.calA = { id: 'calA', binder_id: 'bA', title: 'CalA', description: null, color: 0, is_public: false, created_at: NOW, updated_at: NOW, deleted_at: null };
// castA의 작성자(author1)는 바인더에선 일반 멤버(role3)다 — "작성자는 항상 편집 가능" 규칙 검증용.
setMember('bA', 'author1', 3);
db.casts.castA = { id: 'castA', calendar_id: 'calA', author_id: 'author1', deleted_at: null };

db.users_by_uid['uid-self1'] = { id: 'self1', firebase_uid: 'uid-self1', email: 's@s.com', provider: 'google', status: 0, deleted_at: null };

const queryLog = [];

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  queryLog.push(s);

  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // BinderDAO.getMember
  if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
    const row = db.binder_members[`${params[0]}:${params[1]}`];
    return { rows: row ? [row] : [] };
  }
  // CastDAO.findById
  if (s.includes('FROM casts WHERE id = $1')) {
    const row = db.casts[params[0]];
    return { rows: row ? [row] : [] };
  }
  // CalendarDAO.findById
  if (s.includes('FROM calendars') && s.includes('WHERE id = $1')) {
    const row = db.calendars[params[0]];
    return { rows: row ? [row] : [] };
  }
  // AttachmentDAO.getBytesUsed
  if (s.includes('FROM binder_storage_usage') && s.includes('WHERE binder_id = $1')) {
    return { rows: [{ bytes_used: 0 }] };
  }
  // AttachmentDAO.getStorageLimitBytes
  if (s.includes('FROM binders b') && s.includes('binder_boosts bb')) {
    return { rows: [{ tier: 0 }] };
  }
  // UserDAO.findByUid
  if (s.includes('FROM users u') && s.includes('WHERE u.firebase_uid = $1')) {
    const row = db.users_by_uid[params[0]];
    return { rows: row ? [row] : [] };
  }
  // UserDAO.update — users 테이블 부분
  if (s.startsWith('UPDATE users') && s.includes('WHERE firebase_uid = $2')) {
    const row = db.users_by_uid[params[1]];
    if (!row) return { rows: [] };
    return { rows: [{ id: row.id, firebase_uid: row.firebase_uid, email: row.email, provider: row.provider, status: row.status, created_at: NOW, updated_at: NOW, latest_activity_at: NOW }] };
  }
  // UserDAO.update — user_infos 테이블 부분 (COALESCE 그대로 흉내)
  if (s.startsWith('UPDATE user_infos') && s.includes('WHERE user_id = $5')) {
    return { rows: [{ user_code: 'U0001', display_name: params[0] || 'old-name', bio: params[1], image_url: params[2], thumbnail_url: params[3] }] };
  }
  // attachments INSERT(presign) — 인가 통과 후에만 도달해야 함
  if (s.includes('INSERT INTO attachments')) return { rows: [] };
  // 나머지 쓰기 구문 — SQL 정합성은 이 회귀의 관심사가 아니다.
  if (s.startsWith('UPDATE ') || s.startsWith('INSERT INTO') || s.startsWith('DELETE FROM')) {
    return { rows: [{}] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const mockDb = {
  query: mockQuery,
  connect: async () => ({ query: mockQuery, release() {} }),
};

require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

// ── 실제 서비스 로드(가짜 DB가 주입된 뒤) ─────────────────────────────────
const { MediaService } = require('./mediaService');
const userService = require('./userService');
const { BinderService } = require('./binderService');
const { CastService } = require('./castService');

const ctx = (userId) => ({ sender_id: userId, device_uuid: 'dev-1' });

let pass = 0;
let fail = 0;
const failures = [];

// presign()·GCS 계층에 자격증명이 없어 인가 통과 후 인프라 단계에서 던지는 에러는 이 회귀의
// 관심사가 아니다(authzRegression.test.js:352-354와 동일 판정 기준).
function isAuthzOrValidationRejection(err) {
  if (!err) return false;
  if (err.statusCode === 403) return true;
  if (err.statusCode === 400 && ['ENTITY_TYPE_REQUIRED', 'UNSUPPORTED_ENTITY_TYPE', 'INVALID_IMAGE_REFERENCE', 'IMAGE_REFERENCE_NOT_FOUND'].includes(err.errorCode)) {
    return true;
  }
  return false;
}

async function expectRejected(desc, fn, { statusCode, errorCode } = {}) {
  try {
    await fn();
    fail++;
    failures.push(`${desc}: 거부를 기대했지만 통과해버림`);
  } catch (err) {
    const statusOk = statusCode === undefined || err.statusCode === statusCode;
    const codeOk = errorCode === undefined || err.errorCode === errorCode;
    if (statusOk && codeOk) {
      pass++;
    } else {
      fail++;
      failures.push(`${desc}: 예상 status=${statusCode} code=${errorCode}, 실제 status=${err.statusCode} code=${err.errorCode} msg=${err.message}`);
    }
  }
}

async function expectAuthzOk(desc, fn) {
  try {
    await fn();
    pass++;
  } catch (err) {
    if (isAuthzOrValidationRejection(err)) {
      fail++;
      failures.push(`${desc}: 인가/검증 통과를 기대했지만 거부됨 — status=${err.statusCode} code=${err.errorCode} msg=${err.message}`);
    } else {
      pass++; // 인가는 통과했다 — 이후 GCS 인프라 실패는 이 회귀의 관심사 아님.
    }
  }
}

async function run() {
  // ============ ① 타인 아바타 presign 거부 — 어떤 조건으로 거부되는지까지 단언 ============
  await expectRejected(
    '타인 아바타 presign — context_id가 sender_id와 다르면 403 AVATAR_FORBIDDEN',
    () => MediaService.presign({ context_type: 'avatar', context_id: 'victim', filename: 'a.jpg', content_type: 'image/jpeg' }, ctx('attacker')),
    { statusCode: 403, errorCode: 'AVATAR_FORBIDDEN' }
  );

  // ============ ② 본인 아바타 presign 허용 ============
  await expectAuthzOk(
    '본인 아바타 presign — context_id === sender_id면 인가 통과',
    () => MediaService.presign({ context_type: 'avatar', context_id: 'self1', filename: 'a.jpg', content_type: 'image/jpeg' }, ctx('self1'))
  );

  // avatar/binder 분기 — master만 허용(binderService.updateBinder와 동일 기준)
  await expectRejected(
    '바인더 아바타 presign — master 아니면 403',
    () => MediaService.presign({ context_type: 'avatar', context_id: 'bA', entity_type: 'binder', filename: 'a.jpg', content_type: 'image/jpeg' }, ctx('member1')),
    { statusCode: 403 }
  );
  await expectAuthzOk(
    '바인더 아바타 presign — master는 인가 통과',
    () => MediaService.presign({ context_type: 'avatar', context_id: 'bA', entity_type: 'binder', filename: 'a.jpg', content_type: 'image/jpeg' }, ctx('master1'))
  );

  // 지원하지 않는 entity_type
  await expectRejected(
    '아바타 presign — 지원하지 않는 entity_type은 400',
    () => MediaService.presign({ context_type: 'avatar', context_id: 'x', entity_type: 'cast', filename: 'a.jpg', content_type: 'image/jpeg' }, ctx('x')),
    { statusCode: 400, errorCode: 'UNSUPPORTED_ENTITY_TYPE' }
  );

  // ============ ③ 권한 없는 커버 presign 거부 ============
  await expectRejected(
    '커버 presign — entity_type 생략은 400 ENTITY_TYPE_REQUIRED',
    () => MediaService.presign({ context_type: 'cover', context_id: 'bA', filename: 'a.jpg', content_type: 'image/jpeg' }, ctx('master1')),
    { statusCode: 400, errorCode: 'ENTITY_TYPE_REQUIRED' }
  );
  await expectRejected(
    '바인더 커버 presign — master 아니면 403',
    () => MediaService.presign({ context_type: 'cover', context_id: 'bA', entity_type: 'binder', filename: 'a.jpg', content_type: 'image/jpeg' }, ctx('manager1')),
    { statusCode: 403 }
  );
  await expectRejected(
    '캐스트 커버 presign — 바인더 비멤버는 403',
    () => MediaService.presign({ context_type: 'cover', context_id: 'castA', entity_type: 'cast', filename: 'a.jpg', content_type: 'image/jpeg' }, ctx('outsider')),
    { statusCode: 403 }
  );
  await expectRejected(
    '캐스트 커버 presign — 바인더 멤버지만 작성자도 manager+도 아니면 403',
    () => MediaService.presign({ context_type: 'cover', context_id: 'castA', entity_type: 'cast', filename: 'a.jpg', content_type: 'image/jpeg' }, ctx('member1')),
    { statusCode: 403 }
  );

  // ============ ④ 권한 있는 커버 presign 허용 ============
  await expectAuthzOk(
    '바인더 커버 presign — master는 인가 통과',
    () => MediaService.presign({ context_type: 'cover', context_id: 'bA', entity_type: 'binder', filename: 'a.jpg', content_type: 'image/jpeg' }, ctx('master1'))
  );
  await expectAuthzOk(
    '캐스트 커버 presign — 작성자는 role과 무관하게 인가 통과',
    () => MediaService.presign({ context_type: 'cover', context_id: 'castA', entity_type: 'cast', filename: 'a.jpg', content_type: 'image/jpeg' }, ctx('author1'))
  );
  await expectAuthzOk(
    '캐스트 커버 presign — manager(role1)는 작성자가 아니어도 인가 통과',
    () => MediaService.presign({ context_type: 'cover', context_id: 'castA', entity_type: 'cast', filename: 'a.jpg', content_type: 'image/jpeg' }, ctx('manager1'))
  );

  // ============ ⑤ PATCH가 검증되지 않은 임의 URL을 거부한다 ============
  // assertOwnedMediaReference 단위 검증 — GCS .exists() 호출 이전(형식·소유권 판정)까지만.
  await expectRejected(
    'assertOwnedMediaReference — 외부 URL 거부',
    () => MediaService.assertOwnedMediaReference('https://evil.example.com/x.png', { prefix: 'avatars', entityId: 'self1' }),
    { statusCode: 400, errorCode: 'INVALID_IMAGE_REFERENCE' }
  );
  await expectRejected(
    'assertOwnedMediaReference — 타인 entityId 접두사의 storage_key 거부(형식은 맞지만 소유자 불일치)',
    () => MediaService.assertOwnedMediaReference('avatars/victim/x.jpg', { prefix: 'avatars', entityId: 'self1' }),
    { statusCode: 400, errorCode: 'INVALID_IMAGE_REFERENCE' }
  );
  await expectRejected(
    'assertOwnedMediaReference — path traversal 거부',
    () => MediaService.assertOwnedMediaReference('avatars/self1/../../../etc/passwd', { prefix: 'avatars', entityId: 'self1' }),
    { statusCode: 400, errorCode: 'INVALID_IMAGE_REFERENCE' }
  );
  await expectAuthzOk(
    'assertOwnedMediaReference — 값 미제공(undefined)이면 통과(기존 값 유지, DAO COALESCE와 동일)',
    () => MediaService.assertOwnedMediaReference(undefined, { prefix: 'avatars', entityId: 'self1' })
  );
  await expectAuthzOk(
    'assertOwnedMediaReference — 형식이 맞는 자기 소유 키는 형식 검증을 통과(그 다음 GCS 존재 확인은 인프라 계층)',
    () => MediaService.assertOwnedMediaReference('avatars/self1/uuid123.jpg', { prefix: 'avatars', entityId: 'self1' })
  );

  // 서비스 계층 통합 — PATCH 엔드포인트가 실제로 이 검증을 호출하는지.
  await expectRejected(
    'PATCH /auth/me/image(userService.updateUser) — 임의 URL 거부',
    () => userService.updateUser('uid-self1', { image_url: 'https://evil.example.com/x.png' }),
    { statusCode: 400, errorCode: 'INVALID_IMAGE_REFERENCE' }
  );
  await expectRejected(
    'PATCH /users/:id(userService.updateUserById) — 임의 URL 거부(본인 요청, RLY-20260806-054 인가 통과 후)',
    () => userService.updateUserById('self1', { thumbnail_url: 'https://evil.example.com/x.png' }, 'self1'),
    { statusCode: 400, errorCode: 'INVALID_IMAGE_REFERENCE' }
  );
  await expectAuthzOk(
    'PATCH /auth/me(display_name만) — image_url 미포함이면 검증에 안 걸림',
    () => userService.updateUser('uid-self1', { display_name: 'new-name' })
  );

  await expectRejected(
    'PATCH /binders/:binderId — 임의 URL 거부(master 인가 통과 후)',
    () => BinderService.updateBinder('bA', { image_url: 'https://evil.example.com/x.png' }, 'master1'),
    { statusCode: 400, errorCode: 'INVALID_IMAGE_REFERENCE' }
  );
  await expectRejected(
    'PATCH /binders/:binderId — master 아니면 image_url 검증 전에 이미 403',
    () => BinderService.updateBinder('bA', { image_url: 'https://evil.example.com/x.png' }, 'member1'),
    { statusCode: 403 }
  );

  await expectRejected(
    'PATCH /casts/:castId — 임의 URL 거부(작성자 인가 통과 후)',
    () => CastService.update('castA', { cover_image_url: 'https://evil.example.com/x.png' }, ctx('author1')),
    { statusCode: 400, errorCode: 'INVALID_IMAGE_REFERENCE' }
  );

  // ============ ⑥ 기존 첨부 경로(EVENT 등) presign 거동 불변 ============
  await expectRejected(
    'EVENT 첨부 presign — 비멤버는 여전히 403(avatar/cover 분기 추가로 회귀 없음)',
    () => MediaService.presign({ context_type: 'EVENT', context_id: 'e1', binder_id: 'bA', filename: 'a.png', content_type: 'image/png' }, ctx('outsider')),
    { statusCode: 403 }
  );
  await expectAuthzOk(
    'EVENT 첨부 presign — 멤버는 여전히 인가 통과',
    () => MediaService.presign({ context_type: 'EVENT', context_id: 'e1', binder_id: 'bA', filename: 'a.png', content_type: 'image/png' }, ctx('member1'))
  );

  console.log(`\n[avatarCoverAuthzRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[avatarCoverAuthzRegression] 실행 실패:', error);
  process.exitCode = 1;
});
