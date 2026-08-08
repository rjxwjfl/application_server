const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { NotFoundError } = require('../core/errors');
const errorHandler = require('../core/errorHandler');

function buildCorsOptions(config) {
  const originsEnv = config.CORS_ORIGINS;
  if (!originsEnv) {
    if (config.NODE_ENV === 'production') {
      throw new Error('CORS_ORIGINS 환경 변수가 production에서 필수입니다');
    }
    return { origin: true, credentials: true };
  }
  const allowed = originsEnv.split(',').map((o) => o.trim()).filter(Boolean);
  return {
    origin(origin, cb) {
      if (!origin || allowed.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials: true,
  };
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
});

const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
});

async function expressLoader({ app, config }) {
  app.get('/status', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });
  app.head('/status', (req, res) => res.sendStatus(200));

  // 배포 환경의 실제 프록시 홉 수만큼 신뢰 (0이면 설정 안 함)
  if (config.TRUST_PROXY_HOPS > 0) {
    app.set('trust proxy', config.TRUST_PROXY_HOPS);
  }

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", 'https://fcm.googleapis.com', 'https://firebaseapp.com'],
        imgSrc: ["'self'", 'data:', 'https://storage.googleapis.com'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  app.use(morgan(config.NODE_ENV === 'production' ? 'combined' : 'dev'));

  app.use(cors(buildCorsOptions(config)));

  // Universal Link / App Links 지원 — 모바일 딥링크용
  app.use('/.well-known', express.static(path.join(__dirname, '../../public/.well-known'), {
    setHeaders(res) {
      res.setHeader('Content-Type', 'application/json');
    },
  }));

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // 버전 엔드포인트 — 인증 불필요
  app.get('/api/version', (req, res) => {
    res.json({
      success: true,
      data: {
        minimum_version: process.env.APP_MINIMUM_VERSION || '1.0.0',
        latest_version: process.env.APP_LATEST_VERSION || '1.0.0',
        force_update: process.env.APP_FORCE_UPDATE === 'true',
        update_url_ios: process.env.APP_UPDATE_URL_IOS || null,
        update_url_android: process.env.APP_UPDATE_URL_ANDROID || null,
      },
    });
  });

  app.use('/api/auth', authLimiter);
  app.use('/api', generalLimiter);
  app.use('/api', require('../routes'));

  app.use((req, res, next) => next(new NotFoundError(`Not Found: ${req.path}`)));
  app.use(errorHandler);

  return app;
}

module.exports = expressLoader;
