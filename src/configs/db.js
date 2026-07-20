const { requireEnv } = require('./env');

const isProd = process.env.NODE_ENV === 'production';

/**
 * dev  → Neon Serverless PostgreSQL (PGHOST / PGUSER / PGPASSWORD / PGDATABASE)
 * prod → GCP Cloud SQL              (DB_HOST / DB_USER / DB_PASSWORD / DB_NAME)
 */
module.exports = isProd
  ? {
      host:     requireEnv('DB_HOST'),
      port:     parseInt(process.env.DB_PORT || '5432', 10),
      user:     requireEnv('DB_USER'),
      password: requireEnv('DB_PASSWORD'),
      database: requireEnv('DB_NAME'),
      ssl: { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    }
  : {
      host:     requireEnv('PGHOST'),
      user:     requireEnv('PGUSER'),
      password: requireEnv('PGPASSWORD'),
      database: requireEnv('PGDATABASE'),
      ssl: { rejectUnauthorized: false },
      max: 10,                   // Neon pooler 연결 한도 고려
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000, // Neon cold start/TLS 연결 지연 허용
      keepAlive: true,
    };
