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
    body: '새로운 멤버가 바인더에 참여했습니다.',
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
      title: '바인더 강퇴',
      body: '바인더에서 강퇴되었습니다.',
      target_user_ids: [user_id],
      // RLY-20260806-190 — requiredLevel 미지정(기본값 0=allActivity)이었다. Architect 판정:
      // 0은 어느 해석으로도 설명되지 않는다 — "일반 binder 활동 알림을 다 받고 싶어하는
      // 사람만 자기가 쫓겨난 것도 알려준다"는 결과가 되어, notification_level을 낮춰 둔
      // (relatedOnly·mentionOnly·none) 사람은 강퇴돼도 조용히 바인더가 사라졌다. 강퇴는
      // "binder 활동 노이즈"가 아니라 계정 상태(접근 권한 상실) 통보라 notification_level
      // 로 거를 성격의 알림이 아니라고 판단해 3(none)으로 잡았다 — notification_level<=3은
      // 모든 값을 통과시켜(필터 사실상 무효화) 강퇴 사실만큼은 그 설정과 무관하게 항상
      // 푸시 대상이 되게 한다. member_joined(활동 알림, requiredLevel 없음 그대로 유지 —
      // 이건 손대지 않았다)와 의도적으로 다르게 다룬다.
      requiredLevel: 3,
      routeData: { route_type: 1, route_id: binder_id },
    });
  }
});

eventBus.on('device:registered', ({ user_id }) => {
  notificationService.subscribeUserToAllBinders(user_id);
});
