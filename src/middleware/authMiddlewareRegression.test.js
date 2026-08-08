/**
 * src/middleware/authMiddlewareRegression.test.js
 * =========================================
 * RLY-20260806-214 — authMiddleware.js는 실제 인증 관문(토큰 검증·세션)인데 이 저장소
 * 어떤 회귀 테스트에도 걸리지 않던 파일이었다(RLY-20260806-208이 "못 덮은 영역"으로 등재).
 *
 * 핵심 관심사: `firebaseAuth`(등록된 사용자 전용 — db_user_id claim 필수)와
 * `firebaseAuthLight`(신규 가입 흐름 전용 — Firebase 토큰 검증만) 사이의 **차이**를
 * 직접 단언한다 — RLY-20260806-212가 고친 보안 구멍(`/api/auth/reactivate`가
 * firebaseAuthLight로만 보호돼 db_user_id 없이도 유효 토큰만 있으면 통과했다)의
 * 정확한 조건이 이 차이였다. 이 차이가 배선 자체에서 실제로 유지되는지 여기서
 * 못박는다.
 *
 * mock이 실제로 무엇을 검증하는지 확인(RLY-20260806-135 교훈) — ③(db_user_id 가드)은
 * 프로덕션 코드를 임시로 되돌려(cp 백업 + 복원) 이 테스트가 실제로 실패하는지
 * 확인했다(구현 보고서 참조).
 *
 * 관행: 테스트 프레임워크 없음. plain assert 없이 check() 헬퍼 + `node <file>.js`.
 * utils/firebase의 admin.auth().verifyIdToken을 가짜로 교체(require.cache 주입 —
 * authServiceRegression.test.js와 동일 패턴). Express req/res/next는 최소 stub으로 흉내낸다.
 *
 * 실행: node src/middleware/authMiddlewareRegression.test.js
 */

process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test';
process.env.PGDATABASE = process.env.PGDATABASE || 'test';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test';

const firebasePath = require.resolve('../utils/firebase');

let verifyIdTokenBehavior = null; // 시나리오마다 재설정
const fakeAdmin = {
  auth: () => ({
    verifyIdToken: async (idToken) => verifyIdTokenBehavior(idToken),
  }),
};
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: { admin: fakeAdmin, verifyIdToken: async () => { throw new Error('unused'); } },
};

const { firebaseAuth, firebaseAuthLight } = require('./authMiddleware');

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond, detail) { if (cond) pass++; else { fail++; failures.push(detail ? `${desc}: ${detail}` : desc); } }

function makeReq({ authorization, deviceId } = {}) {
  return { headers: { ...(authorization !== undefined ? { authorization } : {}), ...(deviceId !== undefined ? { 'x-device-id': deviceId } : {}) } };
}

/** middleware(req, res, next)를 호출하고 next가 무엇으로 불렸는지 캡처한다. */
async function runMiddleware(middleware, req) {
  let nextArg = 'NOT_CALLED';
  const res = {};
  await middleware(req, res, (err) => { nextArg = err; });
  return nextArg;
}

async function run() {
  // ============ ① Authorization 헤더 없음 — 두 미들웨어 다 401 UnauthorizedError ============
  {
    const req = makeReq({});
    const err = await runMiddleware(firebaseAuth, req);
    check('① firebaseAuth: 헤더 없음 → UnauthorizedError(401)', err && err.statusCode === 401, `실제=${err}`);
  }
  {
    const req = makeReq({});
    const err = await runMiddleware(firebaseAuthLight, req);
    check('① firebaseAuthLight: 헤더 없음도 거부된다(신규 가입자도 최소 유효 토큰은 있어야 한다)', err && err.statusCode === 401, `실제=${err}`);
  }

  // ============ ② "Bearer " 접두어 없음 — 401 ============
  {
    const req = makeReq({ authorization: 'Basic abcdef' });
    const err = await runMiddleware(firebaseAuth, req);
    check('② Bearer 접두어 없으면 401', err && err.statusCode === 401);
  }

  // ============ ③(핵심) db_user_id claim 없음 — firebaseAuth는 거부, firebaseAuthLight는 통과 ============
  // 이게 RLY-20260806-212가 고친 보안 구멍의 정확한 전제조건이었다 — reactivate가
  // firebaseAuthLight로만 보호돼 "가입은 안 됐지만 유효한 Firebase 토큰"만으로 통과했다.
  {
    verifyIdTokenBehavior = async () => ({ uid: 'fb-uid-1' }); // db_user_id 없음
    const req = makeReq({ authorization: 'Bearer valid-token-no-claim' });
    const err = await runMiddleware(firebaseAuth, req);
    check('③ firebaseAuth: db_user_id 없으면 401(사용자 등록 미완료)', err && err.statusCode === 401, `실제=${err}`);
    check('③ firebaseAuth: req.user_id를 설정하지 않는다(거부됐으므로)', req.user_id === undefined);
  }
  {
    verifyIdTokenBehavior = async () => ({ uid: 'fb-uid-1' }); // db_user_id 없음
    const req = makeReq({ authorization: 'Bearer valid-token-no-claim' });
    const err = await runMiddleware(firebaseAuthLight, req);
    check('③ firebaseAuthLight: db_user_id 없어도 통과한다(신규 가입 흐름 — 차이의 핵심)', err === undefined, `실제=${err}`);
    check('③ firebaseAuthLight: req.user_id는 null로 채워진다(claim이 없으므로)', req.user_id === null, `실제=${req.user_id}`);
  }

  // ============ ④ db_user_id claim 있음 — 둘 다 통과, req.user_id·req.device_uuid 채워진다 ============
  {
    verifyIdTokenBehavior = async () => ({ uid: 'fb-uid-2', db_user_id: 'db-user-2' });
    const req = makeReq({ authorization: 'Bearer valid-token-with-claim', deviceId: 'dev-123' });
    const err = await runMiddleware(firebaseAuth, req);
    check('④ firebaseAuth: claim 있으면 통과(next() 인자 없음)', err === undefined, `실제=${err}`);
    check('④ req.user_id가 claim의 db_user_id로 채워진다', req.user_id === 'db-user-2');
    check('④ req.device_uuid가 x-device-id 헤더로 채워진다', req.device_uuid === 'dev-123');
    check('④ req.user에 decoded 토큰 전체가 실린다', req.user && req.user.uid === 'fb-uid-2');
  }
  {
    verifyIdTokenBehavior = async () => ({ uid: 'fb-uid-3', db_user_id: 'db-user-3' });
    const req = makeReq({ authorization: 'Bearer valid-token-with-claim' }); // x-device-id 없음
    const err = await runMiddleware(firebaseAuthLight, req);
    check('④ firebaseAuthLight: claim 있어도 통과', err === undefined);
    check('④ x-device-id 없으면 req.device_uuid는 null', req.device_uuid === null);
  }

  // ============ ⑤ 토큰 만료 — 명시적 "토큰이 만료되었습니다"(재로그인 유도 메시지 구분) ============
  {
    verifyIdTokenBehavior = async () => { const e = new Error('expired'); e.code = 'auth/id-token-expired'; throw e; };
    const req = makeReq({ authorization: 'Bearer expired-token' });
    const err = await runMiddleware(firebaseAuth, req);
    check('⑤ 만료 토큰은 401 + "토큰이 만료되었습니다"', err && err.statusCode === 401 && err.message === '토큰이 만료되었습니다', `실제=${err && err.message}`);
  }

  // ============ ⑥ 그 외 검증 실패 — 내부 Firebase 오류를 그대로 노출하지 않는다(방어) ============
  {
    verifyIdTokenBehavior = async () => { const e = new Error('internal firebase detail: project mismatch xyz123'); e.code = 'auth/argument-error'; throw e; };
    const req = makeReq({ authorization: 'Bearer garbage-token' });
    const err = await runMiddleware(firebaseAuth, req);
    check('⑥ 알 수 없는 검증 실패는 401 + 일반화된 메시지', err && err.statusCode === 401 && err.message === '유효하지 않은 토큰입니다');
    check('⑥ Firebase 내부 오류 메시지가 그대로 새지 않는다', err && !err.message.includes('project mismatch'), `실제=${err && err.message}`);
  }

  console.log(`\n[authMiddlewareRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[authMiddlewareRegression] 실행 실패:', error);
  process.exitCode = 1;
});
