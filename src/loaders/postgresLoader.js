
const { Pool } = require('pg');

let pool;

async function postgresLoader({ dbConfig }) {
  if (pool) {
    return pool;
  }

  const { host, port, user, password, name } = dbConfig;

  // DB 풀 생성
  pool = new Pool({
    host,
    port: port || 5432,
    user,
    password,
    database: name,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

  try {
    // 연결 테스트
    const client = await pool.connect();
    client.release();
    return pool;
  } catch (error) {
    console.error('PostgreSQL Connection Failed:', error.message);
    process.exit(1);
  }
}

function getPool() {
  if (!pool) {
    throw new Error('DB Pool not initialized');
  }
  return pool;
}

postgresLoader.getPool = getPool;

module.exports = postgresLoader;