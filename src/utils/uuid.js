/**
 * src/utils/uuid.js
 * =========================================
 * UUID v7 생성 유틸리티
 * 
 * 역할:
 * - 사용자 ID 생성 (UUID v7)
 * - 기기 ID 생성
 * =========================================
 */

const { v4: uuidv4 } = require('uuid');
// UUID v7은 node-uuid 또는 uuid@8.2.0 이상에서 지원
// 현재는 v4를 사용하고, 나중에 v7로 업그레이드 가능

/**
 * UUID v7 생성 (또는 v4 as fallback)
 * @returns {string} UUID 문자열
 */
function generateUUID() {
  // TODO: uuid v7 설치 후 아래로 변경
  // return uuidv7();
  
  // 임시: uuid v4 사용
  return uuidv4();
}

/**
 * 사용자 코드 생성 (8자리 고유 코드)
 * @returns {string} 사용자 코드
 */
function generateUserCode() {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return code;
}

module.exports = {
  generateUUID,
  generateUserCode,
};
