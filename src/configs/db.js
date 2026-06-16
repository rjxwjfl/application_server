const { requireEnv } = require('./env');

module.exports = {
  host: requireEnv('DB_HOST'),
  port: process.env.DB_PORT || 5432,
  user: requireEnv('DB_USER'),
  password: requireEnv('DB_PASSWORD'),
  name: requireEnv('DB_NAME'),
};
