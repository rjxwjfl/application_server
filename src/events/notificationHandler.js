const eventBus = require('./eventBus');
const notificationService = require('../services/notificationService');
const { ActionType } = require('../utils/typeDefinitions');

eventBus.on('sync', (data) => {
  notificationService.sendSync(data);
});

eventBus.on('alert', (data) => {
  notificationService.sendAlert(data);
});

eventBus.on('member:joined', ({ user_id, binder_id }) => {
  notificationService.subscribeUserToBinder(user_id, binder_id);

  notificationService.sendAlert({
    binder_id,
    sender_id: user_id,
    type: 'member_joined',
    title: '새 멤버',
    body: '새로운 멤버가 서랍에 참여했습니다.',
    routeData: { route_type: 1, route_id: binder_id },
  });
});

eventBus.on('member:left', ({ user_id, binder_id, actor_id, action }) => {
  notificationService.unsubscribeUserFromBinder(user_id, binder_id);

  if (action === ActionType.KICK) {
    notificationService.sendAlert({
      binder_id,
      sender_id: actor_id,
      type: 'member_kicked',
      title: '서랍 강퇴',
      body: '서랍에서 강퇴되었습니다.',
      target_user_ids: [user_id],
      routeData: { route_type: 1, route_id: binder_id },
    });
  }
});

eventBus.on('device:registered', ({ user_id }) => {
  notificationService.subscribeUserToAllBinders(user_id);
});
