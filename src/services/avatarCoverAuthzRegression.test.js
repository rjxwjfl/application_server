/**
 * src/services/avatarCoverAuthzRegression.test.js
 * =========================================
 * RLY-20260806-052 — 아바타·커버 presign 인가 부재 + PATCH 임의 URL 수용 결함 회귀.
 * RLY-20260806-084 (S2) — media.md §3-3-1·§4-1(2026-08-07 확정) "엔티티 이미지 3종을 첨부와
 * 같은 검사 경로로 통합"에 맞춰 이 스위트를 갱신한다:
 *   · 구 `context_type: 'avatar'|'cover'` + `entity_type` 2단 판별자 → `USER_AVATAR`·
 *     `BINDER_AVATAR`·`CAST_COVER` 3종 직접 판별자로 교체(entity_type 필드 폐기).
 *   · presign이 이제 이 3종도 attachments 행을 INSERT한다 — GCS를 스텁해(아래) 실제로 그
 *     지점까지 도달시키고 INSERT된 값을 직접 단언한다(구 스위트는 GCS 자격증명 부재로 인가
 *     통과 이후를 검증하지 못했다).
 *   · assertOwnedMediaReference(구 헬퍼)는 제거됐다 — PATCH 계열이 이제 image_url·
 *     thumbnail_url·cover_image_url을 아예 받지 않는다(null 제외 전부 400). 그 대체인
 *     assertServerOnlyImageFields를 단위·서비스 통합 양쪽에서 검증한다.
 *   · 플랫 상한(아바타 10MB·커버 20MB)·file_size 필수 회귀를 추가한다.
 *
 * 이 저장소엔 테스트 프레임워크가 없다(authzRegression.test.js와 동일 관행) — plain assert +
 * `node <file>.js` 직접 실행, 가짜 DB connection으로 실제 서비스 코드를 구동한다. GCS는
 * mediaWorkerJobs.test.js와 동일한 방식(Module._load 스텁)으로 흉내낸다 — presign 인가 통과
 * 이후(storage_key 생성 → INSERT)까지 실제로 실행해 attachments 행 생성을 직접 확인하기 위함이다.
 *
 * 실행: node src/services/avatarCoverAuthzRegression.test.js
 */

const assert = require('assert');
const Module = require('module');

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
// RLY-20260806-084 — presign이 이제 엔티티 이미지 3종도 INSERT INTO attachments를 탄다.
// GCS 스텁 덕분에 실제로 이 지점까지 도달하므로, 어떤 값으로 행이 만들어졌는지 여기 기록해
// 회귀로 직접 단언한다(AC "①3종 각각 행 생성").
const insertedAttachments = [];

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
  // AttachmentDAO.getBytesUsed (첨부 6종만 — 엔티티 이미지 3종은 이 쿼리에 도달하지 않는다)
  if (s.includes('FROM binder_storage_usage') && s.includes('WHERE binder_id = $1')) {
    return { rows: [{ bytes_used: 0 }] };
  }
  // AttachmentDAO.getTier (동일)
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
  // UserDAO.update / updateById — user_infos 테이블 부분 (COALESCE 그대로 흉내)
  if (s.startsWith('UPDATE user_infos') && (s.includes('WHERE user_id = $5'))) {
    return { rows: [{ user_code: 'U0001', display_name: params[0] || 'old-name', bio: params[1], image_url: params[2], thumbnail_url: params[3] }] };
  }
  // BinderDAO.update / updateSettings — 값을 그대로 되돌려주면 충분(이 회귀의 관심사 아님)
  if (s.startsWith('UPDATE binders') || s.startsWith('UPDATE binder_settings')) {
    return { rows: [{}] };
  }
  // CastDAO.update
  if (s.startsWith('UPDATE casts')) {
    return { rows: [{}] };
  }
  // presign — attachments INSERT. 실제로 만들어진 행 값을 기록한다(id, binder_id, context_type,
  // context_id, storage_key, filename, file_size, content_type, uploader_id 순 — mediaService.js
  // presign()의 파라미터 순서와 정합).
  if (s.includes('INSERT INTO attachments')) {
    const [id, binderId, contextType, contextId, storageKey, filename, fileSize, contentType, uploaderId] = params;
    insertedAttachments.push({ id, binderId, contextType, contextId, storageKey, filename, fileSize, contentType, uploaderId });
    return { rows: [] };
  }
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

// ── 가짜 GCS ────────────────────────────────────────────────────────────
// mediaWorkerJobs.test.js와 동일 패턴(Module._load 스텁) — 이 샌드박스엔 GCS 자격증명이
// 없으므로, presign이 인가를 통과한 뒤 storage_key 생성 → 업로드 URL 발급 → attachments
// INSERT까지 실제로 도달하려면 generateSignedPostPolicyV4를 흉내내야 한다.
const gcsStub = {
  Storage: class {
    bucket() {
      return {
        file(key) {
          return {
            async generateSignedPostPolicyV4() {
              return [{ url: `https://fake-upload.example/${key}`, fields: { key } }];
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

// ── 실제 서비스 로드(가짜 DB·GCS가 주입된 뒤) ─────────────────────────────
const { MediaService } = require('./mediaService');
const userService = require('./userService');
const { BinderService } = require('./binderService');
const { CastService } = require('./castService');

Module._load = originalLoad; // 이후 일반 require는 정상 경로로.

const ctx = (userId) => ({ sender_id: userId, device_uuid: 'dev-1' });

let pass = 0;
let fail = 0;
const failures = [];

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

async function expectOk(desc, fn) {
  try {
    await fn();
    pass++;
  } catch (err) {
    fail++;
    failures.push(`${desc}: 통과를 기대했지만 거부됨 — status=${err.statusCode} code=${err.errorCode} msg=${err.message}`);
  }
}

async function run() {
  // ============ ① 타인 아바타 presign 거부 — 어떤 조건으로 거부되는지까지 단언 ============
  await expectRejected(
    '타인 유저 아바타 presign — context_id가 sender_id와 다르면 403 AVATAR_FORBIDDEN',
    () => MediaService.presign({ context_type: 'USER_AVATAR', context_id: 'victim', filename: 'a.jpg', content_type: 'image/jpeg', file_size: 1000 }, ctx('attacker')),
    { statusCode: 403, errorCode: 'AVATAR_FORBIDDEN' }
  );

  // ============ ② 본인 아바타 presign 허용 — attachments 행 생성까지 단언(AC①) ============
  insertedAttachments.length = 0;
  await expectOk(
    '본인 유저 아바타 presign — context_id === sender_id면 통과',
    () => MediaService.presign({ context_type: 'USER_AVATAR', context_id: 'self1', filename: 'a.jpg', content_type: 'image/jpeg', file_size: 1000 }, ctx('self1'))
  );
  assert.strictEqual(insertedAttachments.length, 1, 'USER_AVATAR presign 성공 시 attachments 행이 정확히 1개 생겨야 한다');
  {
    const row = insertedAttachments[0];
    if (row.contextType === 'USER_AVATAR' && row.contextId === 'self1' && row.binderId === null && row.uploaderId === 'self1') pass++;
    else { fail++; failures.push(`USER_AVATAR INSERT 값 불일치: ${JSON.stringify(row)}`); }
  }

  // 바인더 아바타 분기 — master만 허용(binderService.updateBinder와 동일 기준)
  await expectRejected(
    '바인더 아바타 presign — master 아니면 403',
    () => MediaService.presign({ context_type: 'BINDER_AVATAR', context_id: 'bA', filename: 'a.jpg', content_type: 'image/jpeg', file_size: 1000 }, ctx('member1')),
    { statusCode: 403 }
  );
  insertedAttachments.length = 0;
  await expectOk(
    '바인더 아바타 presign — master는 통과',
    () => MediaService.presign({ context_type: 'BINDER_AVATAR', context_id: 'bA', filename: 'a.jpg', content_type: 'image/jpeg', file_size: 1000 }, ctx('master1'))
  );
  assert.strictEqual(insertedAttachments.length, 1, 'BINDER_AVATAR presign 성공 시 attachments 행이 정확히 1개 생겨야 한다');
  {
    const row = insertedAttachments[0];
    // media.md §4-1 서버 Step7: BINDER_AVATAR의 binder_id는 context_id와 동일해야 한다.
    if (row.contextType === 'BINDER_AVATAR' && row.contextId === 'bA' && row.binderId === 'bA') pass++;
    else { fail++; failures.push(`BINDER_AVATAR INSERT 값 불일치(binder_id=context_id 규칙): ${JSON.stringify(row)}`); }
  }

  // context_id 누락 — chk_att_entity_target(schema.md)이 요구하는 값이 애초에 presign 단계에서 400
  await expectRejected(
    '바인더 아바타 presign — context_id 누락은 400',
    () => MediaService.presign({ context_type: 'BINDER_AVATAR', filename: 'a.jpg', content_type: 'image/jpeg', file_size: 1000 }, ctx('master1')),
    { statusCode: 400 }
  );

  // ============ ③ 권한 없는 커버 presign 거부 ============
  await expectRejected(
    '캐스트 커버 presign — 바인더 비멤버는 403',
    () => MediaService.presign({ context_type: 'CAST_COVER', context_id: 'castA', filename: 'a.jpg', content_type: 'image/jpeg', file_size: 1000 }, ctx('outsider')),
    { statusCode: 403 }
  );
  await expectRejected(
    '캐스트 커버 presign — 바인더 멤버지만 작성자도 manager+도 아니면 403',
    () => MediaService.presign({ context_type: 'CAST_COVER', context_id: 'castA', filename: 'a.jpg', content_type: 'image/jpeg', file_size: 1000 }, ctx('member1')),
    { statusCode: 403 }
  );

  // ============ ④ 권한 있는 커버 presign 허용 — attachments 행의 binder_id 파생까지 단언 ============
  insertedAttachments.length = 0;
  await expectOk(
    '캐스트 커버 presign — 작성자는 role과 무관하게 통과',
    () => MediaService.presign({ context_type: 'CAST_COVER', context_id: 'castA', filename: 'a.jpg', content_type: 'image/jpeg', file_size: 1000 }, ctx('author1'))
  );
  await expectOk(
    '캐스트 커버 presign — manager(role1)는 작성자가 아니어도 통과',
    () => MediaService.presign({ context_type: 'CAST_COVER', context_id: 'castA', filename: 'a.jpg', content_type: 'image/jpeg', file_size: 1000 }, ctx('manager1'))
  );
  assert.strictEqual(insertedAttachments.length, 2, 'CAST_COVER presign 성공 2건이 각각 attachments 행을 만들어야 한다');
  for (const row of insertedAttachments) {
    // media.md §4-1 서버 Step7: CAST_COVER의 binder_id는 "그 캐스트가 속한 바인더"(calA.binder_id='bA').
    if (row.contextType === 'CAST_COVER' && row.contextId === 'castA' && row.binderId === 'bA') pass++;
    else { fail++; failures.push(`CAST_COVER INSERT 값 불일치(캐스트가 속한 바인더 파생): ${JSON.stringify(row)}`); }
  }

  // ============ ⑤ 플랫 상한 — 첨부 6종 tier별 상한과 다른 값(아바타 10MB·커버 20MB) ============
  await expectRejected(
    'USER_AVATAR — 10MB 초과는 413 FILE_TOO_LARGE(tier 무관 플랫)',
    () => MediaService.presign({ context_type: 'USER_AVATAR', context_id: 'self1', filename: 'a.jpg', content_type: 'image/jpeg', file_size: 10 * 1024 * 1024 + 1 }, ctx('self1')),
    { statusCode: 413, errorCode: 'FILE_TOO_LARGE' }
  );
  await expectOk(
    'USER_AVATAR — 정확히 10MB는 통과(경계값)',
    () => MediaService.presign({ context_type: 'USER_AVATAR', context_id: 'self1', filename: 'a.jpg', content_type: 'image/jpeg', file_size: 10 * 1024 * 1024 }, ctx('self1'))
  );
  await expectRejected(
    'CAST_COVER — 20MB 초과는 413 FILE_TOO_LARGE(아바타와 다른 상한값)',
    () => MediaService.presign({ context_type: 'CAST_COVER', context_id: 'castA', filename: 'a.jpg', content_type: 'image/jpeg', file_size: 20 * 1024 * 1024 + 1 }, ctx('author1')),
    { statusCode: 413, errorCode: 'FILE_TOO_LARGE' }
  );
  await expectRejected(
    'CAST_COVER — 아바타 상한(10MB)이 아니라 커버 상한(20MB)이 적용된다(11MB는 아바타면 거부·커버는 통과)',
    () => MediaService.presign({ context_type: 'CAST_COVER', context_id: 'castA', filename: 'a.jpg', content_type: 'image/jpeg', file_size: 21 * 1024 * 1024 }, ctx('author1')),
    { statusCode: 413, errorCode: 'FILE_TOO_LARGE' }
  );
  await expectOk(
    'CAST_COVER — 11MB(아바타 상한은 초과하지만 커버 상한 20MB는 이내)는 통과 — 두 상한이 실제로 다름을 확인',
    () => MediaService.presign({ context_type: 'CAST_COVER', context_id: 'castA', filename: 'a.jpg', content_type: 'image/jpeg', file_size: 11 * 1024 * 1024 }, ctx('author1'))
  );

  // ============ ⑥ file_size 누락은 400(엔티티 이미지 3종은 총량 집계가 없어 이 값이 유일한 상한) ==
  await expectRejected(
    'USER_AVATAR — file_size 누락은 400',
    () => MediaService.presign({ context_type: 'USER_AVATAR', context_id: 'self1', filename: 'a.jpg', content_type: 'image/jpeg' }, ctx('self1')),
    { statusCode: 400 }
  );

  // ============ ⑦ 엔티티 이미지는 image/ 접두사와 무관하게 이미지 전용(415) — 상세 회귀는
  //   mediaAllowedMimeRegression.test.js가 전담한다. 여기서는 인가 통과 후에도 여전히 걸리는지만
  //   교차 확인한다(순서가 바뀌어 인가가 먼저 실행되도록 리팩터링되는 회귀를 잡기 위함).
  await expectRejected(
    'BINDER_AVATAR — master가 보내도 application/octet-stream은 415(인가 통과 여부와 무관하게 막힘)',
    () => MediaService.presign({ context_type: 'BINDER_AVATAR', context_id: 'bA', filename: 'a.bin', content_type: 'application/octet-stream', file_size: 1000 }, ctx('master1')),
    { statusCode: 415, errorCode: 'UNSUPPORTED_MEDIA_TYPE' }
  );

  // ============ ⑧ 서버 전용 필드 — assertServerOnlyImageFields 단위 검증 ============
  await expectRejected(
    'assertServerOnlyImageFields — 임의 URL(외부 도메인)은 400 SERVER_ONLY_IMAGE_FIELD',
    () => MediaService.assertServerOnlyImageFields({ image_url: 'https://evil.example.com/x.png' }),
    { statusCode: 400, errorCode: 'SERVER_ONLY_IMAGE_FIELD' }
  );
  await expectRejected(
    'assertServerOnlyImageFields — 형식이 그럴듯한(자기 소유처럼 보이는) storage_key 문자열도 400 — 값 자체를 안 받으므로 형식과 무관',
    () => MediaService.assertServerOnlyImageFields({ image_url: 'avatars/users/self1/uuid123.jpg' }),
    { statusCode: 400, errorCode: 'SERVER_ONLY_IMAGE_FIELD' }
  );
  await expectOk(
    'assertServerOnlyImageFields — null은 통과(사진 제거 용도로 남겨진 유일한 값)',
    () => MediaService.assertServerOnlyImageFields({ image_url: null, thumbnail_url: null })
  );
  await expectOk(
    'assertServerOnlyImageFields — undefined(필드 자체 미포함)은 통과(기존 값 유지)',
    () => MediaService.assertServerOnlyImageFields({ image_url: undefined })
  );

  // 서비스 계층 통합 — PATCH 엔드포인트가 실제로 이 검증을 호출하는지.
  await expectRejected(
    'PATCH /auth/me/image(userService.updateUser) — 임의 URL 거부',
    () => userService.updateUser('uid-self1', { image_url: 'https://evil.example.com/x.png' }),
    { statusCode: 400, errorCode: 'SERVER_ONLY_IMAGE_FIELD' }
  );
  await expectRejected(
    'PATCH /users/:id(userService.updateUserById) — 임의 URL 거부(본인 요청, RLY-20260806-054 인가 통과 후)',
    () => userService.updateUserById('self1', { thumbnail_url: 'https://evil.example.com/x.png' }, 'self1'),
    { statusCode: 400, errorCode: 'SERVER_ONLY_IMAGE_FIELD' }
  );
  await expectOk(
    'PATCH /auth/me(display_name만) — image_url 미포함이면 검증에 안 걸림',
    () => userService.updateUser('uid-self1', { display_name: 'new-name' })
  );
  await expectOk(
    'PATCH /auth/me — image_url: null(사진 제거)은 여전히 허용된다',
    () => userService.updateUser('uid-self1', { image_url: null, thumbnail_url: null })
  );

  await expectRejected(
    'PATCH /binders/:binderId — 임의 URL 거부(master 인가 통과 후)',
    () => BinderService.updateBinder('bA', { image_url: 'https://evil.example.com/x.png' }, 'master1'),
    { statusCode: 400, errorCode: 'SERVER_ONLY_IMAGE_FIELD' }
  );
  await expectRejected(
    'PATCH /binders/:binderId — master 아니면 image_url 검증 전에 이미 403',
    () => BinderService.updateBinder('bA', { image_url: 'https://evil.example.com/x.png' }, 'member1'),
    { statusCode: 403 }
  );

  await expectRejected(
    'PATCH /casts/:castId — 임의 URL 거부(작성자 인가 통과 후)',
    () => CastService.update('castA', { cover_image_url: 'https://evil.example.com/x.png' }, ctx('author1')),
    { statusCode: 400, errorCode: 'SERVER_ONLY_IMAGE_FIELD' }
  );

  // ============ ⑨ 기존 첨부 경로(EVENT 등) presign 거동 불변 ============
  await expectRejected(
    'EVENT 첨부 presign — 비멤버는 여전히 403(엔티티 이미지 분기 추가로 회귀 없음)',
    () => MediaService.presign({ context_type: 'EVENT', context_id: 'e1', binder_id: 'bA', filename: 'a.png', content_type: 'image/png' }, ctx('outsider')),
    { statusCode: 403 }
  );
  await expectOk(
    'EVENT 첨부 presign — 멤버는 여전히 통과(binder_storage_usage 대상 경로도 정상 동작)',
    () => MediaService.presign({ context_type: 'EVENT', context_id: 'e1', binder_id: 'bA', filename: 'a.png', content_type: 'image/png', file_size: 1000 }, ctx('member1'))
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
