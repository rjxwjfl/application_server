const expressLoader = require('./expressLoader');
const postgresLoader = require('./postgresLoader');

async function loaders({ expressApp, config }) {
  // 1. DB 연결 초기화
  await postgresLoader({ dbConfig: config.DB });
  
  // 2. Express 설정 적용
  await expressLoader({ app: expressApp, config });
}

module.exports = loaders;