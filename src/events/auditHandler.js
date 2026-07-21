const eventBus = require('./eventBus');
const { AuditDAO } = require('../daos/auditDAO');
const pool = require('../../config/db');
const logger = require('../utils/logger');
const { TargetType, ActionType } = require('../utils/typeDefinitions');

eventBus.on('sync', (data) => {
  if (!data.action || !data.target_type || !data.target_id) return;

  AuditDAO.insert(pool, {
    binder_id: data.binder_id,
    actor_id: data.sender_id,
    device_uuid: data.device_uuid,
    action_type: data.action,
    target_type: data.target_type,
    target_id: data.target_id,
    metadata: data.metadata || null,
  }).catch((err) => logger.error('audit insert failed', { error: err.message }));
});

eventBus.on('user:registered', ({ user_id, provider }) => {
  AuditDAO.insert(pool, {
    binder_id: null,
    actor_id: user_id,
    action_type: ActionType.CREATE,
    target_type: TargetType.USER,
    target_id: user_id,
    metadata: { provider },
  }).catch((err) => logger.error('audit insert failed', { error: err.message }));
});

eventBus.on('member:joined', ({ user_id, binder_id, action, device_uuid }) => {
  AuditDAO.insert(pool, {
    binder_id,
    actor_id: user_id,
    device_uuid,
    action_type: action || ActionType.JOIN,
    target_type: TargetType.BINDER_MEMBER,
    target_id: user_id,
  }).catch((err) => logger.error('audit insert failed', { error: err.message }));
});

eventBus.on('member:left', ({ user_id, binder_id, actor_id, action, device_uuid }) => {
  AuditDAO.insert(pool, {
    binder_id,
    actor_id: actor_id || user_id,
    device_uuid,
    action_type: action || ActionType.LEAVE,
    target_type: TargetType.BINDER_MEMBER,
    target_id: user_id,
  }).catch((err) => logger.error('audit insert failed', { error: err.message }));
});
