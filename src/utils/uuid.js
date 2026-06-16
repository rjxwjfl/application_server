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

const { v7: uuidv7 } = require('uuid');

/**
 * UUID v7 생성
 * @returns {string} UUID 문자열
 */
function generateUUID() {
  return uuidv7();
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
