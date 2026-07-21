const eventBus = require('./eventBus');
const { ActivityFeedDAO } = require('../daos/activityFeedDAO');
const pool = require('../../config/db');
const logger = require('../utils/logger');
const { TargetType, ActionType } = require('../utils/typeDefinitions');

eventBus.on('sync', (data) => {
  if (!data.binder_id || !data.action || !data.target_type || !data.target_id) return;

  ActivityFeedDAO.insert(pool, {
    binder_id: data.binder_id,
    actor_id: data.sender_id,
    action_type: data.action,
    target_type: data.target_type,
    target_id: data.target_id,
    metadata: data.metadata || null,
  }).catch((err) => logger.error('feed insert failed', { error: err.message }));
});

eventBus.on('member:joined', ({ user_id, binder_id, action }) => {
  ActivityFeedDAO.insert(pool, {
    binder_id,
    actor_id: user_id,
    action_type: action || ActionType.JOIN,
    target_type: TargetType.BINDER_MEMBER,
    target_id: user_id,
  }).catch((err) => logger.error('feed insert failed', { error: err.message }));
});

eventBus.on('member:left', ({ user_id, binder_id, actor_id, action }) => {
  ActivityFeedDAO.insert(pool, {
    binder_id,
    actor_id: actor_id || user_id,
    action_type: action || ActionType.LEAVE,
    target_type: TargetType.BINDER_MEMBER,
    target_id: user_id,
  }).catch((err) => logger.error('feed insert failed', { error: err.message }));
});
