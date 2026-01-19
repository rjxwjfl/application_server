const express = require('express');
const cors = require('cors');

async function expressLoader({ app, config }) {
  // 1. 헬스체크 라우트
  app.get('/status', (req, res) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      env: config.NODE_ENV,
    });
  });
  app.head('/status', (req, res) => res.sendStatus(200));

  // 2. 기본 보안 및 파싱 설정
  app.enable('trust proxy');
  
  // CORS 설정
  if (config.NODE_ENV !== 'production') {
    app.use(cors());
  } else {
    app.use(cors({
      origin: config.CORS_ORIGINS || '*',
      credentials: true,
    }));
  }

  // Body 파서
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // 3. API 라우트 마운트
  app.use('/api', require('../routes'));

  // 4. 에러 핸들링
  // 404 Not Found
  app.use((req, res, next) => {
    const err = new Error(`Not Found: ${req.path}`);
    err.status = 404;
    next(err);
  });

  // Global Error Handler
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    const message = err.message || 'Internal Server Error';

    // 개발 환경에서만 서버 콘솔에 상세 에러 출력
    if (config.NODE_ENV !== 'production') {
      console.error('🔴 Server Error:', err);
    }

    res.status(status).json({
      success: false,
      status,
      message,
      ...(config.NODE_ENV !== 'production' && { stack: err.stack }),
    });
  });

  return app;
}

module.exports = expressLoader;