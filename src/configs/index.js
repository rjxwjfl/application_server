const dotenv = require('dotenv');

// .env 파일에서 환경 변수 로드
dotenv.config();

/**
 * 필수 환경 변수 확인
 */
function requireEnv(key) {
  if (!process.env[key]) {
    throw new Error(`필수 환경 변수가 없습니다: ${key}`);
  }
  return process.env[key];
}

// 애플리케이션 설정 객체
const config = {
  // 실행 환경
  NODE_ENV: process.env.NODE_ENV || 'development',

  // 서버 포트
  PORT: process.env.PORT || 3000,

  // 데이터베이스 설정 (PostgreSQL)
  DB: {
    host: requireEnv('DB_HOST'),
    user: requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
    name: requireEnv('DB_NAME'),
    port: process.env.DB_PORT || 5432,
  },

  // Firebase 설정
  // 서버는 firebase-admin을 사용하며, 일반적으로 GOOGLE_APPLICATION_CREDENTIALS
  // 환경변수에 서비스 계정 키 파일 경로를 지정하여 인증합니다.
  // 명시적으로 프로젝트 ID가 필요한 경우를 위해 남겨둡니다.
  FIREBASE: {
    PROJECT_ID: process.env.FIREBASE_PROJECT_ID, // 선택 사항
  },

  // Redis 설정 (선택사항)
  // ID Token 방식에서도 캐싱(사용자 프로필 등)을 위해 유용하게 사용됨
  REDIS: {
    HOST: process.env.REDIS_HOST || 'localhost',
    PORT: process.env.REDIS_PORT || 6379,
    ENABLED: !!process.env.REDIS_HOST,
  },
};

module.exports = config;