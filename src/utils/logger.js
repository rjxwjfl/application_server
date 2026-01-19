/**
 * src/utils/logger.js
 * =========================================
 * 애플리케이션 로깅 유틸리티
 * 
 * 역할:
 * - 구조화된 로그 출력
 * - 로그 레벨별 처리 (info, warn, error)
 * - 타임스탬프 추가
 * =========================================
 */

const config = require('../configs');

/**
 * 로그 레벨
 */
const LOG_LEVELS = {
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
  DEBUG: 'DEBUG',
};

/**
 * 로그 출력
 * @param {string} level - 로그 레벨\n * @param {string} message - 로그 메시지\n * @param {Object} metadata - 추가 정보 (선택사항)\n */\nfunction log(level, message, metadata = {}) {\n  const timestamp = new Date().toISOString();\n  const logObject = {\n    timestamp,\n    level,\n    message,\n    env: config.NODE_ENV,\n    ...metadata,\n  };\n\n  // 개발 환경에서는 console로 출력, 프로덕션은 파일로\n  if (config.NODE_ENV === 'production') {\n    // TODO: winston 라이브러리 통합\n    console.log(JSON.stringify(logObject));\n  } else {\n    const emoji = {\n      INFO: 'ℹ️',\n      WARN: '⚠️',\n      ERROR: '❌',\n      DEBUG: '🐛',\n    }[level] || '📝';\n    console.log(`${emoji} [${level}] ${message}`, metadata);\n  }\n}\n\n/**\n * INFO 레벨 로그\n */\nfunction info(message, metadata) {\n  log(LOG_LEVELS.INFO, message, metadata);\n}\n\n/**\n * WARN 레벨 로그\n */\nfunction warn(message, metadata) {\n  log(LOG_LEVELS.WARN, message, metadata);\n}\n\n/**\n * ERROR 레벨 로그\n */\nfunction error(message, metadata) {\n  log(LOG_LEVELS.ERROR, message, metadata);\n}\n\n/**\n * DEBUG 레벨 로그\n */\nfunction debug(message, metadata) {\n  if (config.NODE_ENV !== 'production') {\n    log(LOG_LEVELS.DEBUG, message, metadata);\n  }\n}\n\nmodule.exports = {\n  info,\n  warn,\n  error,\n  debug,\n  log,\n};\n