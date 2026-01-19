const express = require('express');
const config = require('./src/configs');
const loaders = require('./src/loaders');

/**
 * Express 앱 생성 및 초기화
 * @returns {Promise<express.Express>} 초기화된 Express 앱
 */
async function createApp() {
  const app = express();

  try {
    await loaders({
      expressApp: app,
      server: null,
      config,
    });

    return app;
  } catch (error) {
    console.error('❌ 앱 초기화 실패:', error);
    throw error;
  }
}

module.exports = createApp;