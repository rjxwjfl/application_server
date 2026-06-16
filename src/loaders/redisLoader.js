const logger = require('../utils/logger');

let redisClient = null;

async function redisLoader() {
  logger.info('Redis has been removed.');
  return null;
}

function getRedis() {
  return null;
}

module.exports = redisLoader;
module.exports.getRedis = getRedis;
