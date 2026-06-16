/**
 * config/db.js
 * =========================================
 * PostgreSQL 연결 풀 싱글톤 모듈
 *
 * postgresLoader에서 초기화된 pool을 재사용합니다.
 * Services에서 require('../../config/db')로 접근합니다.
 * =========================================
 */

const postgresLoader = require('../src/loaders/postgresLoader');

module.exports = {
  query: (...args) => postgresLoader.getPool().query(...args),
  connect: (...args) => postgresLoader.getPool().connect(...args),
};
