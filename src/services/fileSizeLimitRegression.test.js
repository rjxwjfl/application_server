/**
 * src/services/fileSizeLimitRegression.test.js
 * =========================================
 * RLY-20260806-072 — media.md §3-1(단일 파일 최대 크기)이 문서화한 파일 1건당 상한이 서버
 * 어디에도 배선돼 있지 않던 결손의 회귀. 조사(구현 보고서 §1)로 확인된 사실: presign은
 * 바인더 총 저장 한도(F-S9)만 검사했고 개별 파일 크기는 전혀 보지 않았다 — 5GB 한도
 * 안에만 들면 4.9GB짜리 "이미지" 파일도 통과했다.
 *
 * 072는 이미지만 배선했다. RLY-20260806-075(User 판정 2026-08-07)로 오디오·비디오를
 * 같이 걸었다 — 이미지 분기 옆에 나란히 추가한 것이라(공통 함수로 묶지 않음, team-lead
 * 지시) 이 스위트도 세 타입을 나란한 절로 검증한다.
 *
 * document·other는 여전히 보류다(§1 설계 원칙 주석 참조 — MIME 허용 목록 자체가 없어
 * content_type을 신뢰할 근거가 없고, document/other는 prefix만으로 못 가른다). ⑤가 이
 * 보류를 회귀로 고정한다.
 *
 * 이 저장소엔 테스트 프레임워크가 없다 — storageQuotaRegression.test.js와 동일 관행:
 * plain assert + `node <file>.js` 직접 실행, 가짜 DB·GCS로 실제 서비스 코드를 구동한다.
 * 이 스위트는 F-S9 회계(binder_storage_usage 증감)를 다시 검증하지 않는다 —
 * storageQuotaRegression.test.js가 이미 담당한다. 여기서는 presign의 파일 1건당
 * 상한 분기만 좁게 구동한다.
 *
 * 실행: node src/services/fileSizeLimitRegression.test.js
 */

const Module = require('module');

process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test';
process.env.PGDATABASE = process.env.PGDATABASE || 'test';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test';

const db = {
  binder_members: {
    'b-free:u1': { binder_id: 'b-free', user_id: 'u1', role: 3, deleted_at: null },
    'b-lite:u1': { binder_id: 'b-lite', user_id: 'u1', role: 3, deleted_at: null },
    'b-plus:u1': { binder_id: 'b-plus', user_id: 'u1', role: 3, deleted_at: null },
  },
  binder_boosts: {
    'b-lite': { binder_id: 'b-lite', tier: 1, status: 'ACTIVE' },
    'b-plus': { binder_id: 'b-plus', tier: 2, status: 'ACTIVE' },
  },
  binder_storage_usage: {}, // 전 시나리오 bytes_used=0 — 이 스위트는 파일 1건당 상한만 본다
};

const queryLog = [];

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  queryLog.push({ sql: s, params });

  // requireBinderMember → BinderDAO.getMember
  if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
    const row = db.binder_members[`${params[0]}:${params[1]}`];
    return { rows: row ? [row] : [] };
  }

  // AttachmentDAO.getBytesUsed
  if (s.startsWith('SELECT bytes_used FROM binder_storage_usage')) {
    const row = db.binder_storage_usage[params[0]];
    return { rows: row ? [row] : [] };
  }

  // AttachmentDAO.getTier
  if (s.includes('FROM binders b') && s.includes('binder_boosts bb')) {
    const boost = db.binder_boosts[params[0]];
    const tier = boost && boost.status === 'ACTIVE' ? boost.tier : 0;
    return { rows: [{ tier }] };
  }

  // MediaService.presign — INSERT INTO attachments (이 스위트는 402/413로 여기 도달하지
  // 않는 케이스만 본문 검증하므로 성공 삽입은 형식만 맞추면 된다)
  if (s.startsWith('INSERT INTO attachments')) {
    return { rows: [], rowCount: 1 };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
}

const mockDb = {
  query: mockQuery,
  connect: async () => ({ query: mockQuery, release() {} }),
};

const dbPath = require.resolve('../../config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const gcsStub = {
  Storage: class {
    bucket() {
      return {
        file() {
          return {
            async generateSignedPostPolicyV4() { return ['https://fake-upload-url']; },
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

async function expectResolved(desc, fn) {
  try {
    await fn();
    pass++;
  } catch (err) {
    fail++;
    failures.push(`${desc}: 통과를 기대했지만 거부됨 — status=${err.statusCode} code=${err.errorCode} msg=${err.message}`);
  }
}

const MB = 1024 * 1024;

async function run() {
  // ============ ① Free tier(20MB) 초과 — 413 FILE_TOO_LARGE ============
  await expectRejected(
    'Free 바인더 — 이미지 20MB+1B는 413 FILE_TOO_LARGE로 거부',
    () => MediaService.presign(
      { context_type: 'EVENT', context_id: 'e1', binder_id: 'b-free', filename: 'x.png', content_type: 'image/png', file_size: 20 * MB + 1 },
      ctx('u1')
    ),
    { statusCode: 413, errorCode: 'FILE_TOO_LARGE' }
  );

  // ============ ② 정확히 한도(20MB) — 통과(초과가 아니므로 거부하지 않는다) ============
  await expectResolved(
    'Free 바인더 — 이미지 정확히 20MB는 통과(경계값, 초과 아님)',
    () => MediaService.presign(
      { context_type: 'EVENT', context_id: 'e1', binder_id: 'b-free', filename: 'x.png', content_type: 'image/png', file_size: 20 * MB },
      ctx('u1')
    )
  );

  // ============ ③ Boost Lite(50MB) — Free라면 거부됐을 크기가 통과 ============
  await expectResolved(
    'Lite 바인더 — 이미지 21MB(Free라면 413)는 Lite(50MB) 한도로 통과',
    () => MediaService.presign(
      { context_type: 'EVENT', context_id: 'e1', binder_id: 'b-lite', filename: 'x.png', content_type: 'image/png', file_size: 21 * MB },
      ctx('u1')
    )
  );
  await expectRejected(
    'Lite 바인더 — 이미지 50MB+1B는 여전히 413(Lite 한도도 초과)',
    () => MediaService.presign(
      { context_type: 'EVENT', context_id: 'e1', binder_id: 'b-lite', filename: 'x.png', content_type: 'image/png', file_size: 50 * MB + 1 },
      ctx('u1')
    ),
    { statusCode: 413, errorCode: 'FILE_TOO_LARGE' }
  );

  // ============ ④ Boost Plus(100MB) — Lite라면 거부됐을 크기가 통과 ============
  await expectResolved(
    'Plus 바인더 — 이미지 60MB(Lite라면 413)는 Plus(100MB) 한도로 통과',
    () => MediaService.presign(
      { context_type: 'EVENT', context_id: 'e1', binder_id: 'b-plus', filename: 'x.png', content_type: 'image/png', file_size: 60 * MB },
      ctx('u1')
    )
  );

  // ============ ⑤ 오디오 — 이미지와 나란한 상한(Free 20MB·Lite 100MB·Plus 300MB) ============
  await expectRejected(
    'Free 바인더 — 오디오 20MB+1B는 413 FILE_TOO_LARGE로 거부',
    () => MediaService.presign(
      { context_type: 'EVENT', context_id: 'e1', binder_id: 'b-free', filename: 'x.mp3', content_type: 'audio/mpeg', file_size: 20 * MB + 1 },
      ctx('u1')
    ),
    { statusCode: 413, errorCode: 'FILE_TOO_LARGE' }
  );
  await expectResolved(
    'Free 바인더 — 오디오 정확히 20MB는 통과(경계값, 초과 아님)',
    () => MediaService.presign(
      { context_type: 'EVENT', context_id: 'e1', binder_id: 'b-free', filename: 'x.mp3', content_type: 'audio/mpeg', file_size: 20 * MB },
      ctx('u1')
    )
  );
  await expectResolved(
    'Lite 바인더 — 오디오 90MB(Free라면 413)는 Lite(100MB) 한도로 통과',
    () => MediaService.presign(
      { context_type: 'EVENT', context_id: 'e1', binder_id: 'b-lite', filename: 'x.mp3', content_type: 'audio/mpeg', file_size: 90 * MB },
      ctx('u1')
    )
  );
  await expectRejected(
    'Plus 바인더 — 오디오 300MB+1B는 여전히 413(Plus 한도도 초과)',
    () => MediaService.presign(
      { context_type: 'EVENT', context_id: 'e1', binder_id: 'b-plus', filename: 'x.mp3', content_type: 'audio/mpeg', file_size: 300 * MB + 1 },
      ctx('u1')
    ),
    { statusCode: 413, errorCode: 'FILE_TOO_LARGE' }
  );

  // ============ ⑥ 비디오 — Free 200MB·Lite 1GB·Plus 5GB ============
  await expectRejected(
    'Free 바인더 — 비디오 200MB+1B는 413 FILE_TOO_LARGE로 거부',
    () => MediaService.presign(
      { context_type: 'EVENT', context_id: 'e1', binder_id: 'b-free', filename: 'x.mp4', content_type: 'video/mp4', file_size: 200 * MB + 1 },
      ctx('u1')
    ),
    { statusCode: 413, errorCode: 'FILE_TOO_LARGE' }
  );
  await expectResolved(
    'Free 바인더 — 비디오 정확히 200MB는 통과(경계값, 초과 아님)',
    () => MediaService.presign(
      { context_type: 'EVENT', context_id: 'e1', binder_id: 'b-free', filename: 'x.mp4', content_type: 'video/mp4', file_size: 200 * MB },
      ctx('u1')
    )
  );
  await expectResolved(
    'Lite 바인더 — 비디오 500MB(Free라면 413)는 Lite(1GB) 한도로 통과',
    () => MediaService.presign(
      { context_type: 'EVENT', context_id: 'e1', binder_id: 'b-lite', filename: 'x.mp4', content_type: 'video/mp4', file_size: 500 * MB },
      ctx('u1')
    )
  );
  await expectResolved(
    'Plus 바인더 — 비디오 2GB(Lite라면 413)는 Plus(5GB) 한도로 통과',
    () => MediaService.presign(
      { context_type: 'EVENT', context_id: 'e1', binder_id: 'b-plus', filename: 'x.mp4', content_type: 'video/mp4', file_size: 2 * 1024 * MB },
      ctx('u1')
    )
  );

  // ============ ⑦ document·other — 보류. 아무리 커도 이 검사는 안 걸림(User 판정) ============
  // MIME 허용 목록 자체가 없는 타입이라 이 Task는 손대지 않는다 — 구현 보고서 §3-1·§1.
  await expectResolved(
    'ZIP(기타)은 상한이 없다 — 크기가 얼마든 이 검사에 걸리지 않는다(User 판정으로 보류)',
    () => MediaService.presign(
      { context_type: 'EVENT', context_id: 'e1', binder_id: 'b-free', filename: 'x.zip', content_type: 'application/zip', file_size: 500 * MB },
      ctx('u1')
    )
  );

  console.log(`\n[fileSizeLimitRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
  Module._load = originalLoad;
}

run().catch((error) => {
  Module._load = originalLoad;
  console.error('[fileSizeLimitRegression] 실행 실패:', error);
  process.exitCode = 1;
});
