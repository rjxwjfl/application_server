const { admin } = require('../utils/firebase');
const { UnauthorizedError } = require('../core/errors');

async function _verify(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new UnauthorizedError('인증 토큰이 제공되지 않았습니다');
  }
  return await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
}

function _mapError(error) {
  if (error instanceof UnauthorizedError) return error;
  if (error.code === 'auth/id-token-expired') return new UnauthorizedError('토큰이 만료되었습니다');
  return new UnauthorizedError('유효하지 않은 토큰입니다');
}

// 등록된 사용자 전용 — db_user_id custom claim 필수
const firebaseAuth = async (req, res, next) => {
  try {
    const decoded = await _verify(req);
    if (!decoded.db_user_id) {
      return next(new UnauthorizedError('사용자 등록이 완료되지 않았습니다'));
    }
    req.user = decoded;
    req.user_id = decoded.db_user_id;
    req.device_uuid = req.headers['x-device-id'] || null;
    next();
  } catch (e) {
    next(_mapError(e));
  }
};

// 신규 가입 흐름 전용 — Firebase 토큰 검증만 수행 (db_user_id 불필요)
const firebaseAuthLight = async (req, res, next) => {
  try {
    const decoded = await _verify(req);
    req.user = decoded;
    req.user_id = decoded.db_user_id || null;
    req.device_uuid = req.headers['x-device-id'] || null;
    next();
  } catch (e) {
    next(_mapError(e));
  }
};

module.exports = { firebaseAuth, firebaseAuthLight };
