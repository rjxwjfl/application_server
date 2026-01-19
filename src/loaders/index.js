/**
 * src/loaders/index.js
 * =========================================
 * 로더들을 재수출하는 진입점
 * 
 * app.js에서 `require('./src/loaders')`로 import할 때
 * 이 파일을 통해 loaders 함수를 가져옵니다.
 * =========================================
 */

const loaders = require('./loaders');

module.exports = loaders;
