/**
 * src/configs/index.js
 * =========================================
 * 설정 진입점 - 도메인별 설정을 합쳐서 내보냄
 * =========================================
 */

require('./env'); // dotenv 로드 (side-effect)

const db = require('./db');
const firebase = require('./firebase');

const config = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: process.env.PORT || 3000,
  DB: db,
  FIREBASE: firebase,
  CORS_ORIGINS: process.env.CORS_ORIGINS || '',
  GCS_BUCKET_MEDIA: process.env.GCS_BUCKET_MEDIA || 'rally-media',
  GCS_BUCKET_CDN: process.env.GCS_BUCKET_CDN || 'rally-cdn',
  // 0 = 직접 연결(dev), 1 = nginx 단일 프록시, 2 = CDN+nginx 등
  TRUST_PROXY_HOPS: parseInt(process.env.TRUST_PROXY_HOPS ?? '0', 10),
};

module.exports = config;
