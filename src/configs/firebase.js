const { requireEnv } = require('./env');

module.exports = {
  PROJECT_ID: requireEnv('FIREBASE_PROJECT_ID'),
  CREDENTIALS_PATH: process.env.GOOGLE_APPLICATION_CREDENTIALS || null,
};
