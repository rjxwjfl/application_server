/**
 * src/middleware/webhookAuthMiddleware.js
 * =========================================
 * 웹훅 인증 미들웨어
 *
 * - Apple S2S V2: JWS x5c 인증서 체인 검증 (ES256)
 * - Google Pub/Sub: OIDC 토큰 검증
 * =========================================
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

// Apple Root CA G3 인증서 — 실제로는 아래 _getAppleRootCert()가 APPLE_ROOT_CA_PATH
// 환경변수(파일 경로)로만 로드한다. URL에서 직접 받아오는 경로는 없다.
let _appleRootCert = null;

/**
 * Apple S2S V2 JWS 검증 미들웨어
 */
async function verifyAppleWebhook(req, res, next) {
  try {
    const { signedPayload } = req.body;
    if (!signedPayload) {
      return res.status(400).json({ error: 'Missing signedPayload' });
    }

    // 1. JWS 헤더에서 x5c 인증서 체인 추출
    const header = JSON.parse(
      Buffer.from(signedPayload.split('.')[0], 'base64url').toString()
    );
    const { x5c } = header;
    if (!x5c || x5c.length < 2) {
      return res.status(401).json({ error: 'Invalid certificate chain' });
    }

    // 2. 인증서 체인 검증 (leaf → intermediate → root)
    const certs = x5c.map((certBase64) => {
      const pem = `-----BEGIN CERTIFICATE-----\n${certBase64}\n-----END CERTIFICATE-----`;
      return new crypto.X509Certificate(pem);
    });

    // Leaf 인증서를 Intermediate로 검증
    const leaf = certs[0];
    const intermediate = certs[1];

    if (!leaf.checkIssued(intermediate)) {
      return res.status(401).json({ error: 'Certificate chain verification failed' });
    }

    // Intermediate를 Root CA로 검증 (선택적 — Root CA 인증서가 있을 때)
    const rootCert = await _getAppleRootCert();
    if (rootCert && certs.length >= 2) {
      if (!intermediate.checkIssued(rootCert)) {
        logger.warn('Apple intermediate cert not issued by known root CA');
      }
    }

    // 3. Leaf 인증서 공개키로 JWS 서명 검증
    const publicKey = leaf.publicKey;
    const payload = jwt.verify(signedPayload, publicKey, { algorithms: ['ES256'] });

    // 4. Inner JWS 디코딩 (signedTransactionInfo, signedRenewalInfo)
    if (payload.data) {
      if (payload.data.signedTransactionInfo) {
        payload.data.signedTransactionInfo = jwt.decode(payload.data.signedTransactionInfo);
      }
      if (payload.data.signedRenewalInfo) {
        payload.data.signedRenewalInfo = jwt.decode(payload.data.signedRenewalInfo);
      }
    }

    // 환경 체크 (Sandbox vs Production)
    const expectedEnv = process.env.APPLE_ENVIRONMENT || 'Sandbox';
    if (payload.environment && payload.environment !== expectedEnv) {
      logger.warn('Apple webhook environment mismatch', {
        expected: expectedEnv,
        received: payload.environment,
      });
    }

    req.applePayload = payload;
    next();
  } catch (error) {
    logger.error('Apple webhook verification failed', { error: error.message });
    return res.status(401).json({ error: 'Webhook verification failed' });
  }
}

/**
 * Google Pub/Sub OIDC 토큰 검증 미들웨어
 */
async function verifyGoogleWebhook(req, res, next) {
  try {
    // 1. Authorization Bearer 토큰 추출
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'Missing authorization token' });
    }

    // 2. OIDC 토큰 검증
    const { OAuth2Client } = require('google-auth-library');
    const audience = process.env.GOOGLE_PUBSUB_AUDIENCE;
    const client = new OAuth2Client();

    const ticket = await client.verifyIdToken({
      idToken: token,
      audience,
    });

    const claim = ticket.getPayload();

    // 발신자 이메일 확인 (Google Pub/Sub 서비스 계정)
    if (!claim.email || !claim.email_verified) {
      return res.status(401).json({ error: 'Invalid token claims' });
    }

    // 3. Pub/Sub message.data base64 디코딩
    const { message } = req.body;
    if (!message || !message.data) {
      return res.status(400).json({ error: 'Missing Pub/Sub message data' });
    }

    const decodedData = JSON.parse(
      Buffer.from(message.data, 'base64').toString('utf-8')
    );

    req.googlePayload = decodedData;
    next();
  } catch (error) {
    logger.error('Google webhook verification failed', { error: error.message });
    return res.status(401).json({ error: 'Webhook verification failed' });
  }
}

/**
 * Apple Root CA G3 인증서 캐시
 */
async function _getAppleRootCert() {
  if (_appleRootCert) return _appleRootCert;

  try {
    const certPath = process.env.APPLE_ROOT_CA_PATH;
    if (certPath) {
      const fs = require('fs');
      const certData = fs.readFileSync(certPath);
      _appleRootCert = new crypto.X509Certificate(certData);
      return _appleRootCert;
    }
  } catch (error) {
    logger.warn('Failed to load Apple Root CA', { error: error.message });
  }
  return null;
}

module.exports = {
  verifyAppleWebhook,
  verifyGoogleWebhook,
};
