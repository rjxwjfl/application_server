const { admin } = require('./firebase');
const logger = require('./logger');

const messaging = admin.messaging();

/**
 * Topic으로 data-only 메시지 발송 (SYNC용)
 */
async function sendToTopic(topic, data) {
  const message = {
    topic,
    data,
    android: { priority: 'high' },
    apns: { headers: { 'apns-priority': '10' } },
  };
  const response = await messaging.send(message);
  logger.debug('FCM topic send success', { topic, messageId: response });
  return response;
}

/**
 * 특정 토큰들에 notification+data 메시지 발송 (ALERT용)
 * @returns {{ successCount, failureCount, staleTokens }}
 */
async function sendMulticast(tokens, notification, data) {
  if (!tokens || tokens.length === 0) {
    return { successCount: 0, failureCount: 0, staleTokens: [] };
  }

  const message = {
    tokens,
    notification,
    data,
    android: { priority: 'high' },
    apns: {
      headers: { 'apns-priority': '10' },
      payload: { aps: { sound: 'default' } },
    },
  };

  const response = await messaging.sendEachForMulticast(message);

  const staleTokens = [];
  response.responses.forEach((resp, idx) => {
    if (resp.error) {
      const code = resp.error.code;
      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
      ) {
        staleTokens.push(tokens[idx]);
      }
    }
  });

  return {
    successCount: response.successCount,
    failureCount: response.failureCount,
    staleTokens,
  };
}

/**
 * 토큰들을 Topic에 구독
 */
async function subscribeToTopic(tokens, topic) {
  if (!tokens || tokens.length === 0) return;
  const response = await messaging.subscribeToTopic(tokens, topic);
  logger.debug('FCM subscribeToTopic', { topic, successCount: response.successCount });
  return response;
}

/**
 * 토큰들을 Topic에서 구독 해제
 */
async function unsubscribeFromTopic(tokens, topic) {
  if (!tokens || tokens.length === 0) return;
  const response = await messaging.unsubscribeFromTopic(tokens, topic);
  logger.debug('FCM unsubscribeFromTopic', { topic, successCount: response.successCount });
  return response;
}

module.exports = {
  sendToTopic,
  sendMulticast,
  subscribeToTopic,
  unsubscribeFromTopic,
};
