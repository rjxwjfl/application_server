const { Pool } = require('pg');
const logger = require('../utils/logger');

let pool;

async function postgresLoader({ dbConfig }) {
  if (pool) return pool;

  pool = new Pool(dbConfig);

  try {
    const client = await pool.connect();
    client.release();
    logger.info(`PostgreSQL connected: ${dbConfig.host}`);
    return pool;
  } catch (error) {
    logger.error('PostgreSQL connection failed', { error: error.message });
    process.exit(1);
  }
}

function getPool() {
  if (!pool) throw new Error('DB Pool not initialized');
  return pool;
}

postgresLoader.getPool = getPool;

module.exports = postgresLoader;
