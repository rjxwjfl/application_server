/**
 * src/daos/index.js
 * =========================================
 * 데이터 접근 객체 (DAO) 진입점
 * 
 * 역할:
 * - 데이터베이스 접근 추상화
 * - SQL 쿼리 실행
 * - 데이터 CRUD 작업
 * =========================================
 */

// DAO 클래스 import
const { DrawerDAO } = require('./drawerDAO');
const { UserDAO } = require('./userDAO');

// 모든 DAO를 export
module.exports = {
  DrawerDAO,
  UserDAO,
};
