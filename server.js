
const http = require('http');
const express = require('express');
const config = require('./src/configs');
const loaders = require('./src/loaders');

async function startServer() {
  try {
    const app = express();

    // 로더 초기화: DB 연결 및 Express 설정
    await loaders({
      expressApp: app,
      server: null,
      config,
    });

    const server = http.createServer(app);

    // 서버 시작
    server.listen(config.PORT, () => {
      // 서버가 성공적으로 시작됨
      // 개발 환경일 때만 편의를 위해 포트 정보 출력 (선택사항)
      if (config.NODE_ENV !== 'production') {
        console.log(`Server running on port ${config.PORT}`);
      }
    });

    server.on('error', (error) => {
      console.error('Server Error:', error);
      process.exit(1);
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();