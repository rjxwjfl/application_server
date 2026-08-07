/**
 * src/services/presignDisplayOrderRegression.test.js
 * =========================================
 * RLY-20260806-108 — media.md:188·225(§4-1 서버 Step7)가 presign 요청의 display_order를
 * 받아 저장한다고 규정하지만, `mediaService.presign()`의 INSERT 컬럼 목록에 `display_order`
 * 자체가 없어(RLY-20260806-104 조사가 찾은 3건 중 하나) 클라가 무엇을 보내든 전부 스키마
 * DEFAULT(0)로만 저장됐다.
 *
 * ⚠️ 클라(`PresignRequest`, `lib/data/dto/media/presign_request.dart`)는 이 필드를 아직 안
 * 보낸다는 것을 읽기로 확인했다(이 스위트는 "서버가 받으면 저장한다"만 검증한다 — 클라가
 * 실제로 보내게 하는 배선은 별도 Task, 이번 보고서에 명시).
 *
 * ⚠️ presign은 이번 세션에 S2가 크게 고친 곳이다 — 이 스위트는 display_order 관련 단언만
 * 추가하고, 인가·MIME·플랫 상한 등 기존 로직은 건드리지 않는다(avatarCoverAuthzRegression 등
 * 기존 회귀가 이미 담당).
 *
 * 이 저장소엔 테스트 프레임워크가 없다 — plain assert + `node <file>.js` 직접 실행.
 *
 * 실행: node src/services/presignDisplayOrderRegression.test.js
 */

const assert = require('assert');
const Module = require('module');

const dbPath = require.resolve('../../config/db');
const NOW = new Date().toISOString();

const db = { binder_members: {} };
db.binder_members['bA:member1'] = {
  binder_id: 'bA', user_id: 'member1', role: 3,
  notification_level: 1, nickname_in_binder: null, joined_at: NOW, deleted_at: null,
};

const insertedAttachments = [];

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
  // AttachmentDAO.getBytesUsed / getTier — 첨부 6종(EVENT 등)에서 도달. Free tier, 사용량 0.
  if (s.startsWith('SELECT bytes_used FROM binder_storage_usage')) return { rows: [] };
  if (s.startsWith('SELECT COALESCE(bb.tier, 0) AS tier')) return { rows: [{ tier: 0 }] };
  // presign — attachments INSERT. 실제로 넘어온 display_order를 그대로 기록한다.
  if (s.includes('INSERT INTO attachments')) {
    const [id, binderId, contextType, contextId, storageKey, filename, fileSize, contentType, uploaderId, displayOrder] = params;
    insertedAttachments.push({ id, binderId, contextType, contextId, storageKey, filename, fileSize, contentType, uploaderId, displayOrder });
    return { rows: [] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

// GCS 스텁 — presign의 generateSignedPostPolicyV4만 있으면 된다(entityImageEndToEndRegression과
// 동일 패턴, 이 스위트는 업로드·Worker까지 가지 않으므로 download/save는 불필요).
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

const { MediaService } = require('./mediaService');

Module._load = originalLoad;

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

async function run() {
  await check('① presign이 display_order를 받으면 그대로 저장한다(클라가 값을 보낸 경우)', async () => {
    insertedAttachments.length = 0;
    await MediaService.presign(
      { context_type: 'EVENT', context_id: 'e1', binder_id: 'bA', filename: 'b.png', content_type: 'image/png', file_size: 1000, display_order: 2 },
      ctx('member1')
    );
    assert.strictEqual(insertedAttachments.length, 1);
    assert.strictEqual(insertedAttachments[0].displayOrder, 2, 'display_order가 클라가 보낸 값 그대로 저장돼야 한다');
  });

  await check('② 대조군 — display_order를 안 보내면 스키마 DEFAULT(0)와 같은 값으로 저장된다(기존 동작 불변)', async () => {
    insertedAttachments.length = 0;
    await MediaService.presign(
      { context_type: 'EVENT', context_id: 'e1', binder_id: 'bA', filename: 'a.png', content_type: 'image/png', file_size: 1000 },
      ctx('member1')
    );
    assert.strictEqual(insertedAttachments.length, 1);
    assert.strictEqual(insertedAttachments[0].displayOrder, 0, '생략 시 0으로 저장돼야 한다(스키마 DEFAULT와 동일 값 — 기존 클라 무영향)');
  });

  await check('③ display_order=0을 명시적으로 보내도 정상 저장된다(falsy 값 fallback 함정 회귀)', async () => {
    insertedAttachments.length = 0;
    await MediaService.presign(
      { context_type: 'EVENT', context_id: 'e1', binder_id: 'bA', filename: 'c.png', content_type: 'image/png', file_size: 1000, display_order: 0 },
      ctx('member1')
    );
    assert.strictEqual(insertedAttachments[0].displayOrder, 0, '0은 falsy지만 ?? 는 undefined/null만 대체해야 한다(|| 였다면 이 케이스가 깨졌을 것)');
  });

  console.log(`\n[presignDisplayOrderRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(` - ${f.name}: ${f.error.stack || f.error.message}`));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[presignDisplayOrderRegression] 실행 실패:', error);
  process.exitCode = 1;
});
