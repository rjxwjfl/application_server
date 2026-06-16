/**
 * src/utils/logger.js
 * =========================================
 * Winston 기반 애플리케이션 로깅 유틸리티
 *
 * 역할:
 * - 구조화된 로그 출력
 * - 로그 레벨별 처리 (info, warn, error, debug)
 * - 개발: 컬러 콘솔 출력
 * - 프로덕션: JSON 파일 + 일별 로테이션
 * =========================================
 */

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const config = require('../configs');

const { combine, timestamp, printf, colorize, errors } = winston.format;

/**
 * 스택 트레이스에서 호출자 정보 추출
 * logger.error / logger.warn 호출 시 자동으로 메서드명·파일 위치 캡처
 */
function getCallerInfo() {
  const orig = Error.prepareStackTrace;
  Error.prepareStackTrace = (_, stack) => stack;
  const err = new Error();
  const stack = err.stack;
  Error.prepareStackTrace = orig;

  // 0: getCallerInfo → 1: logger wrapper → 2: 실제 호출자
  const caller = stack[2];
  if (!caller) return null;

  const file = caller.getFileName();
  const line = caller.getLineNumber();
  const fn = caller.getFunctionName() || '<anonymous>';
  const short = file ? file.replace(/.*[/\\]src[/\\]/, 'src/').replace(/\\/g, '/') : 'unknown';
  return `${short}:${line} → ${fn}`;
}

// 개발용 포맷
const devFormat = combine(
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ timestamp, level, message, caller, endpoint, stack, ...meta }) => {
    const parts = [endpoint, caller].filter(Boolean);
    const location = parts.length ? ` [${parts.join(' | ')}]` : '';
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level}:${location} ${stack || message}${metaStr}`;
  })
);

// 프로덕션용 포맷 (caller, endpoint 필드가 JSON에 자동 포함됨)
const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  winston.format.json()
);

// 트랜스포트 설정
const transports = [new winston.transports.Console()];

if (config.NODE_ENV === 'production') {
  transports.push(
    new DailyRotateFile({
      filename: 'logs/app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
    }),
    new DailyRotateFile({
      filename: 'logs/error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '30d',
      level: 'error',
    })
  );
}

const logger = winston.createLogger({
  level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  format: config.NODE_ENV === 'production' ? prodFormat : devFormat,
  transports,
});

module.exports = {
  info: (message, meta) => logger.info(message, meta),
  warn: (message, meta) => logger.warn(message, { caller: getCallerInfo(), ...meta }),
  error: (message, meta) => logger.error(message, { caller: getCallerInfo(), ...meta }),
  debug: (message, meta) => logger.debug(message, meta),
  log: (level, message, meta) => logger.log(level, message, meta),
  stream: { write: (message) => logger.info(message.trim()) },
};
