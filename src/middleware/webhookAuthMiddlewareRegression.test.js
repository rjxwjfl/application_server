/**
 * src/middleware/webhookAuthMiddlewareRegression.test.js
 * =========================================
 * RLY-20260806-214 — webhookAuthMiddleware.js는 실제 웹훅 서명 검증 관문(Apple JWS
 * x5c 인증서 체인·Google Pub/Sub OIDC)인데 이 저장소 어떤 회귀 테스트에도 걸리지
 * 않던 파일이었다(RLY-20260806-208이 "못 덮은 영역"으로 등재).
 *
 * ⚠️ Apple 경로는 "서명이 있으면 통과시켜 준다"는 걸 흉내내는 mock이 아니라 **진짜
 * ES256 JWS + 진짜 X.509 인증서 체인**으로 검증한다(openssl CLI로 EC 키·인증서를
 * 실제로 생성 — 이 환경에 이미 설치돼 있음을 확인했다). "서명 검증이 실제로
 * 거부하는지"를 확인하려면 가짜 서명이 아니라 실제로 검증 가능한 서명과 검증
 * 불가능한 서명을 둘 다 만들어 대조해야 한다 — 그래야 mock이 SQL 텍스트와 무관하게
 * 항상 통과하던 RLY-20260806-135류 함정을 피한다.
 *
 * 검증 대상(Apple):
 *   - signedPayload 없음 → 400
 *   - x5c 인증서가 1개뿐(체인 아님) → 401
 *   - leaf가 intermediate가 아닌 무관한 인증서에 의해 발급됐다고 주장 → 401
 *     (인증서 체인이 실제로 안 맞으면 거부되는지 — 진짜 서로 다른 두 CA로 실측)
 *   - 서명 후 payload를 한 바이트 변조(재서명 없이) → 서명 검증 실패 → 401
 *   - 유효한 체인 + 유효한 서명 → 통과, req.applePayload에 디코딩된 내용이 실린다
 *
 * 검증 대상(Google):
 *   - Authorization 헤더 없음 → 401
 *   - OIDC 토큰 검증 실패 → 401
 *   - email_verified가 아닌 발신자 → 401(Pub/Sub 서비스 계정이 아닌 임의 발신자 차단)
 *   - message.data 없음 → 400
 *   - 정상 → req.googlePayload에 base64 디코딩된 JSON이 실린다
 *
 * revert-verify(RLY-20260806-135 교훈) — leaf/intermediate 체인 검사(Apple)와
 * email_verified 검사(Google)는 프로덕션 코드를 임시로 되돌려(cp 백업 + 복원) 이
 * 테스트가 실제로 실패하는지 확인했다(구현 보고서 참조).
 *
 * 관행: 테스트 프레임워크 없음. plain assert 없이 check() 헬퍼 + `node <file>.js`.
 * google-auth-library의 OAuth2Client를 가짜로 교체(require.cache 주입).
 *
 * 실행: node src/middleware/webhookAuthMiddlewareRegression.test.js
 */

process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test';
process.env.PGDATABASE = process.env.PGDATABASE || 'test';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test';
delete process.env.APPLE_ROOT_CA_PATH; // 이 회귀의 관심사가 아니다 — 미설정 시 middleware가 root cert 대조를 건너뛴다(코드 확인됨)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const jwt = require('jsonwebtoken');

// ── 진짜 EC(ES256) 키·인증서를 openssl CLI로 생성한다 ──────────────────────────
// intermediate 1개 + 그 intermediate가 실제로 발급한 leaf 1개(정상 체인) +
// intermediate와 무관한 leaf(체인 불일치 검증용).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhookAuthTest-'));
function sh(...args) { execFileSync('openssl', args, { cwd: tmpDir, stdio: 'pipe' }); }
function p(name) { return path.join(tmpDir, name); }
function pemToX5cEntry(pemPath) {
  const pem = fs.readFileSync(pemPath, 'utf8');
  return pem.split('\n').filter((line) => line && !line.startsWith('-----')).join('');
}

sh('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', p('inter_key.pem'));
sh('req', '-x509', '-new', '-key', p('inter_key.pem'), '-out', p('inter_cert.pem'), '-days', '1', '-subj', '/CN=TestIntermediate', '-sha256');
sh('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', p('leaf_key.pem'));
sh('req', '-new', '-key', p('leaf_key.pem'), '-out', p('leaf.csr'), '-subj', '/CN=TestLeaf', '-sha256');
sh('x509', '-req', '-in', p('leaf.csr'), '-CA', p('inter_cert.pem'), '-CAkey', p('inter_key.pem'), '-CAcreateserial', '-out', p('leaf_cert.pem'), '-days', '1', '-sha256');
// intermediate와 아무 관계 없는 별도의 자체서명 인증서(leaf가 이걸 발급자로 주장하면 거부돼야 한다)
sh('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', p('other_key.pem'));
sh('req', '-x509', '-new', '-key', p('other_key.pem'), '-out', p('other_cert.pem'), '-days', '1', '-subj', '/CN=Unrelated', '-sha256');

const leafKeyPem = fs.readFileSync(p('leaf_key.pem'), 'utf8');
const leafCertB64 = pemToX5cEntry(p('leaf_cert.pem'));
const interCertB64 = pemToX5cEntry(p('inter_cert.pem'));
const otherCertB64 = pemToX5cEntry(p('other_cert.pem'));

function signApplePayload(payload, x5c) {
  return jwt.sign(payload, leafKeyPem, { algorithm: 'ES256', header: { x5c } });
}

// ── google-auth-library를 가짜로 교체 ──────────────────────────────────────
const googleAuthPath = require.resolve('google-auth-library');
let verifyIdTokenBehavior = null;
class FakeOAuth2Client {
  async verifyIdToken(opts) { return verifyIdTokenBehavior(opts); }
}
require.cache[googleAuthPath] = {
  id: googleAuthPath, filename: googleAuthPath, loaded: true,
  exports: { OAuth2Client: FakeOAuth2Client },
};

const { verifyAppleWebhook, verifyGoogleWebhook } = require('./webhookAuthMiddleware');

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond, detail) { if (cond) pass++; else { fail++; failures.push(detail ? `${desc}: ${detail}` : desc); } }

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

async function runMiddleware(middleware, req) {
  const res = makeRes();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

async function run() {
  // ============ Apple ① signedPayload 없음 — 400 ============
  {
    const { res, nextCalled } = await runMiddleware(verifyAppleWebhook, { body: {} });
    check('Apple① signedPayload 없으면 400', res.statusCode === 400, `실제=${res.statusCode}`);
    check('Apple① next()가 호출되지 않는다', !nextCalled);
  }

  // ============ Apple ② x5c가 1개뿐(체인 아님) — 401 ============
  {
    const signedPayload = signApplePayload({ notificationType: 'TEST' }, [leafCertB64]); // 1개만
    const { res, nextCalled } = await runMiddleware(verifyAppleWebhook, { body: { signedPayload } });
    check('Apple② x5c 1개뿐이면 401', res.statusCode === 401, `실제=${res.statusCode}`);
    check('Apple② next()가 호출되지 않는다', !nextCalled);
  }

  // ============ Apple ③(핵심) leaf가 무관한 인증서를 발급자로 주장 — 체인 불일치 → 401 ============
  {
    const signedPayload = signApplePayload({ notificationType: 'TEST' }, [leafCertB64, otherCertB64]); // leaf는 실제로 inter가 발급했지만, x5c에 상관없는 other를 끼워 넣음
    const { res, nextCalled } = await runMiddleware(verifyAppleWebhook, { body: { signedPayload } });
    check('Apple③ 체인이 실제로 안 맞으면 401(진짜 서로 다른 CA로 실측)', res.statusCode === 401, `실제=${res.statusCode}`);
    check('Apple③ next()가 호출되지 않는다', !nextCalled);
  }

  // ============ Apple ④ 서명 후 payload 변조(재서명 없이) — 서명 검증 실패 → 401 ============
  {
    const signedPayload = signApplePayload({ notificationType: 'TEST', data: {} }, [leafCertB64, interCertB64]);
    const parts = signedPayload.split('.');
    // payload 세그먼트의 마지막 문자 하나를 다른 base64url 문자로 바꿔치기(서명은 그대로) — 변조 시뮬레이션.
    const tamperedChar = parts[1].slice(-1) === 'A' ? 'B' : 'A';
    parts[1] = parts[1].slice(0, -1) + tamperedChar;
    const tampered = parts.join('.');
    const { res, nextCalled } = await runMiddleware(verifyAppleWebhook, { body: { signedPayload: tampered } });
    check('Apple④ 변조된 payload는 서명 검증에서 걸린다(401)', res.statusCode === 401, `실제=${res.statusCode}`);
    check('Apple④ next()가 호출되지 않는다', !nextCalled);
  }

  // ============ Apple ⑤ 유효한 체인 + 유효한 서명 — 통과 ============
  {
    const signedPayload = signApplePayload({ notificationType: 'SUBSCRIBED', subtype: 'INITIAL_BUY', data: { foo: 'bar' } }, [leafCertB64, interCertB64]);
    const req = { body: { signedPayload } };
    const { res, nextCalled } = await runMiddleware(verifyAppleWebhook, req);
    check('Apple⑤ 유효한 서명·체인은 통과한다(res 응답 없이 next 호출)', nextCalled && res.statusCode === null, `res.statusCode=${res.statusCode} next=${nextCalled}`);
    check('Apple⑤ req.applePayload에 디코딩된 내용이 실린다', req.applePayload && req.applePayload.notificationType === 'SUBSCRIBED' && req.applePayload.data.foo === 'bar',
      `실제=${JSON.stringify(req.applePayload)}`);
  }

  // ============ Google ① Authorization 헤더 없음 — 401 ============
  {
    const { res, nextCalled } = await runMiddleware(verifyGoogleWebhook, { headers: {}, body: {} });
    check('Google① Authorization 헤더 없으면 401', res.statusCode === 401);
    check('Google① next()가 호출되지 않는다', !nextCalled);
  }

  // ============ Google ② OIDC 토큰 검증 자체가 실패 — 401 ============
  {
    verifyIdTokenBehavior = async () => { throw new Error('invalid signature'); };
    const { res, nextCalled } = await runMiddleware(verifyGoogleWebhook, { headers: { authorization: 'Bearer bad-oidc-token' }, body: {} });
    check('Google② OIDC 검증 실패 시 401', res.statusCode === 401);
    check('Google② next()가 호출되지 않는다', !nextCalled);
  }

  // ============ Google ③(핵심) 발신자가 email_verified가 아님 — 401(임의 발신자 차단) ============
  {
    verifyIdTokenBehavior = async () => ({ getPayload: () => ({ email: 'attacker@evil.example.com', email_verified: false }) });
    const { res, nextCalled } = await runMiddleware(verifyGoogleWebhook, { headers: { authorization: 'Bearer some-token' }, body: {} });
    check('Google③ email_verified가 아니면 401', res.statusCode === 401, `실제=${res.statusCode}`);
    check('Google③ next()가 호출되지 않는다', !nextCalled);
  }

  // ============ Google ④ 유효한 발신자인데 message.data가 없음 — 400 ============
  {
    verifyIdTokenBehavior = async () => ({ getPayload: () => ({ email: 'pubsub@system.gserviceaccount.com', email_verified: true }) });
    const { res, nextCalled } = await runMiddleware(verifyGoogleWebhook, { headers: { authorization: 'Bearer valid-oidc-token' }, body: {} });
    check('Google④ message.data 없으면 400', res.statusCode === 400, `실제=${res.statusCode}`);
    check('Google④ next()가 호출되지 않는다', !nextCalled);
  }

  // ============ Google ⑤ 정상 — req.googlePayload에 base64 디코딩된 JSON이 실린다 ============
  {
    verifyIdTokenBehavior = async () => ({ getPayload: () => ({ email: 'pubsub@system.gserviceaccount.com', email_verified: true }) });
    const inner = { subscriptionNotification: { purchaseToken: 'ptok-1', subscriptionId: 'sub-1', notificationType: 4 } };
    const req = { headers: { authorization: 'Bearer valid-oidc-token' }, body: { message: { data: Buffer.from(JSON.stringify(inner)).toString('base64'), messageId: 'msg-1' } } };
    const { res, nextCalled } = await runMiddleware(verifyGoogleWebhook, req);
    check('Google⑤ 정상 페이로드는 통과한다', nextCalled && res.statusCode === null, `res.statusCode=${res.statusCode} next=${nextCalled}`);
    check('Google⑤ req.googlePayload가 정확히 디코딩된다', req.googlePayload && req.googlePayload.subscriptionNotification.purchaseToken === 'ptok-1',
      `실제=${JSON.stringify(req.googlePayload)}`);
  }

  console.log(`\n[webhookAuthMiddlewareRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

run().catch((error) => {
  console.error('[webhookAuthMiddlewareRegression] 실행 실패:', error);
  process.exitCode = 1;
});
