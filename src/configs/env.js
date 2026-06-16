const dotenv = require('dotenv');

// .env 파일에서 환경 변수 로드 (최초 1회)
dotenv.config();

/**
 * 필수 환경 변수 확인
 * @param {string} key - 환경 변수 키
 * @returns {string} 환경 변수 값
 */
function requireEnv(key) {
  if (!process.env[key]) {
    throw new Error(`필수 환경 변수가 없습니다: ${key}`);
  }
  return process.env[key];
}

module.exports = { requireEnv };
