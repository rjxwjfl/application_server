/**
 * src/services/mediaAllowedMimeRegression.test.js
 * =========================================
 * RLY-20260806-056 — presign에 MIME 허용 목록 신설 회귀.
 *
 * 결함 요약(수리 전): media.md:106,127이 서술하는 "MIME 타입 허용 목록 확인"이 presign()
 * 코드에 없었다 — content_type이 무엇이든(HEIC·HEIF 포함) 그대로 통과했다.
 *
 * 허용 목록 근거(User 판정): "안드로이드가 네이티브로 여는 포맷을 허용한다" — JPEG·PNG·WebP·GIF는
 * 허용, HEIC·HEIF는 애플 전용 포맷(안드로이드 미지원)이라 거부. "검증 불가능해서"가 아니라
 * "안드로이드가 못 열어서"가 근거임을 아래 회귀에서 단언으로 고정한다. BMP는 안드로이드가
 * 열지만 판단이 안 서 목록에 넣지 않았다(team-lead 지시 "판단이 안 서면 넣지 마라" — 클라가
 * 어차피 presign 전에 webp로 바꿔 보내 안 받아서 문제 될 정상 경로가 없다).
 *
 * 이 저장소엔 테스트 프레임워크가 없다 — plain assert + `node <file>.js` 직접 실행,
 * avatarCoverAuthzRegression.test.js와 동일한 가짜 DB connection 패턴을 재사용한다.
 *
 * 실행: node src/services/mediaAllowedMimeRegression.test.js
 */


const dbPath = require.resolve('../../config/db');

const queryLog = [];

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  queryLog.push(s);
  // 이 스위트는 MIME 게이트가 DB에 닿기도 전에 거부하는지를 확인하는 것이 핵심이다 —
  // 통과 케이스는 context_type='USER_AVATAR'+본인 id만 써서(DB 호출이 없는 유일한 인가 분기,
  // mediaService.js:_authorizeUserAvatarPresign)여기까지 오지 않게 설계했다.
  // 혹시 도달하면 그 자체가 "게이트가 새는지" 신호이므로 무엇이 왔는지 남기고 던진다.
  throw new Error(`[mock] 예상치 못한 DB 호출 — MIME 게이트가 DB 이전에 걸러야 한다: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const mockDb = {
  query: mockQuery,
  connect: async () => ({ query: mockQuery, release() {} }),
};

require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { MediaService } = require('./mediaService');

const ctx = (userId) => ({ sender_id: userId, device_uuid: 'dev-1' });

let pass = 0;
let fail = 0;
const failures = [];

function isInfraRejection(err) {
  // GCS 자격증명이 이 샌드박스에 없어 인가·MIME 게이트를 통과한 뒤엔 인프라 단계에서
  // 던진다(avatarCoverAuthzRegression.test.js와 동일 판정 기준) — 그건 "통과"로 본다.
  return err && err.statusCode !== 415;
}

async function expectMimeRejected(desc, contentType, contextType = 'USER_AVATAR') {
  try {
    await MediaService.presign(
      { context_type: contextType, context_id: 'self1', filename: 'a.bin', content_type: contentType, file_size: 1000 },
      ctx('self1')
    );
    fail++;
    failures.push(`${desc}: 거부를 기대했지만 통과해버림`);
  } catch (err) {
    if (err.statusCode === 415 && err.errorCode === 'UNSUPPORTED_MEDIA_TYPE') {
      pass++;
    } else {
      fail++;
      failures.push(`${desc}: 415 UNSUPPORTED_MEDIA_TYPE을 기대했지만 실제 status=${err.statusCode} code=${err.errorCode} msg=${err.message}`);
    }
  }
}

async function expectMimeAllowed(desc, contentType, contextType = 'USER_AVATAR') {
  try {
    await MediaService.presign(
      { context_type: contextType, context_id: 'self1', filename: 'a.bin', content_type: contentType, file_size: 1000 },
      ctx('self1')
    );
    pass++; // GCS 자격증명이 있는 환경이면 여기까지 성공할 수도 있다.
  } catch (err) {
    if (isInfraRejection(err)) {
      pass++; // MIME 게이트는 통과했다 — 그 뒤 GCS 인프라 실패는 이 회귀의 관심사 아님.
    } else {
      fail++;
      failures.push(`${desc}: MIME 게이트 통과를 기대했지만 415로 거부됨 — msg=${err.message}`);
    }
  }
}

async function run() {
  // ============ ① 허용 목록 밖 이미지 타입 거부 — 조건까지 단언 ============
  await expectMimeRejected('임의 이미지 MIME(image/tiff) — 목록에 없으면 415 UNSUPPORTED_MEDIA_TYPE', 'image/tiff');

  // ============ ② 안드로이드 네이티브 포맷은 통과 ============
  await expectMimeAllowed('안드로이드 네이티브(image/jpeg) — 통과', 'image/jpeg');
  await expectMimeAllowed('안드로이드 네이티브(image/png) — 통과', 'image/png');
  await expectMimeAllowed('안드로이드 네이티브(image/webp) — 통과(059 병합 여부와 무관 — 안드로이드가 여는 포맷이라 규칙상 정당, 059 병합 전 클라 출력이기도 함)', 'image/webp');
  await expectMimeAllowed('안드로이드 네이티브(image/gif) — 통과', 'image/gif');

  // ============ ③ 애플 전용 포맷은 거부 — "검증 불가"가 아니라 "안드로이드 미지원"이 근거 ============
  await expectMimeRejected('애플 전용(image/heic) — 안드로이드 미지원이라 거부(검증 가능성과 무관)', 'image/heic');
  await expectMimeRejected('애플 전용(image/heif) — 안드로이드 미지원이라 거부(검증 가능성과 무관)', 'image/heif');

  // ============ 대소문자 무관하게 대조한다 ============
  await expectMimeRejected('애플 전용(IMAGE/HEIC, 대문자) — 대소문자 상관없이 거부', 'IMAGE/HEIC');
  await expectMimeAllowed('안드로이드 네이티브(IMAGE/WEBP, 대문자) — 대소문자 상관없이 통과', 'IMAGE/WEBP');

  // ============ RLY-20260806-084 — 엔티티 이미지 3종은 image/ 접두사 여부와 무관하게 항상
  // 허용 목록과 대조한다("image/ 로 시작할 때만 대조"하면 우회된다는 것이 media.md §4-1
  // 서버 Step3의 명시 경고 — 2026-08-06 실제로 GIF를 application/octet-stream으로 선언해
  // 아바타 무검사 통과가 확인된 경로다). 구 코드는 이 두 케이스를 "게이트 밖"으로 취급해
  // 통과시켰다 — 그 결함을 여기서 회귀로 고정한다.
  await expectMimeRejected(
    'USER_AVATAR — application/octet-stream(2026-08-06 실제 우회 경로) — image/ 접두사가 아니어도 415로 거부',
    'application/octet-stream'
  );
  await expectMimeRejected('USER_AVATAR — video/mp4은 이미지 전용 컨텍스트라 415로 거부', 'video/mp4');
  await expectMimeRejected('USER_AVATAR — application/pdf은 이미지 전용 컨텍스트라 415로 거부', 'application/pdf');

  // 세 컨텍스트 타입 모두 같은 게이트를 공유하는지 — BINDER_AVATAR·CAST_COVER는 이 뒤에 DB
  // 인가 조회가 있어 여기까지 오면 mockQuery가 "예상치 못한 DB 호출"로 실패시킨다. 즉 이
  // 케이스들이 통과한다는 것 자체가 "MIME 게이트가 인가보다 먼저 실행된다"는 증거다.
  await expectMimeRejected('BINDER_AVATAR — application/octet-stream도 인가 전에 415로 거부(DB 호출 없이)', 'application/octet-stream', 'BINDER_AVATAR');
  await expectMimeRejected('CAST_COVER — application/octet-stream도 인가 전에 415로 거부(DB 호출 없이)', 'application/octet-stream', 'CAST_COVER');

  // ============ 이미지가 아닌 content_type은 첨부 6종(엔티티 이미지가 아닌 컨텍스트)에는
  // 영향을 주지 않는다(범위 밖) — SECTION_MESSAGE는 DB 인가 조회가 있어 여기서 직접 확인할
  // 수는 없지만(모든 DB 호출이 거부되는 mock), 최소한 "이미지 게이트가 던지지는 않는다"는
  // 것은 이 mock이 SECTION_MESSAGE 인가의 DB 호출로 대신 실패하는 것으로 간접 확인된다
  // (415가 아니라 DB mock 에러가 나야 정상 — MIME 게이트를 통과했다는 뜻).
  await (async () => {
    try {
      await MediaService.presign(
        { context_type: 'SECTION_MESSAGE', context_id: 'msg-1', binder_id: 'b1', filename: 'a.pdf', content_type: 'application/pdf' },
        ctx('self1')
      );
      fail++;
      failures.push('SECTION_MESSAGE + application/pdf: DB 인가 조회까지 도달해야 하는데 통과해버림(mock이 모든 DB 호출을 막아야 정상)');
    } catch (err) {
      if (err.statusCode === 415) {
        fail++;
        failures.push('SECTION_MESSAGE + application/pdf: 이미지 게이트가 비이미지 컨텍스트에 새어 415로 거부됨(회귀) — msg=' + err.message);
      } else {
        pass++; // MIME 게이트는 통과했고 그 다음 DB 인가 조회에서 mock이 막은 것 — 기대한 동작.
      }
    }
  })();

  console.log(`\n[mediaAllowedMimeRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[mediaAllowedMimeRegression] 실행 실패:', error);
  process.exitCode = 1;
});
