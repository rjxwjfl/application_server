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
      // 0은 어느 해석으로도 설명되지 않는다 — notification_level을 낮춰 둔 사람은 강퇴돼도
      // 조용히 바인더가 사라졌다. 190에서 3(none, 필터 사실상 무효화)으로 잡았으나 그건
      // Writer(나) 판단이었다.
      //
      // RLY-20260806-194 — 이후 User 판정으로 정정: **"나에게 직접 일어난 일"은 "나와
      // 관련된 것만"까지** — allActivity(0)·relatedOnly(1)는 기기 푸시를 받고,
      // mentionOnly(2)·none(3)은 안 받는다. filterUserIdsByNotificationLevel의 조건은
      // `notification_level <= requiredLevel`(값이 작을수록 "더 받고 싶어함" — 0=모두,
      // 1=관련만, 2=멘션만, 3=수신거부, notificationDAO.js 주석 참조)이므로 0·1만 통과하고
      // 2·3은 걸러지게 하려면 requiredLevel은 정확히 **1**이어야 한다(0이면 relatedOnly까지
      // 막히고, 2 이상이면 mentionOnly까지 새서 반대로 열린다 — 방향을 실제 SQL로 재확인한
      // 뒤 정했다). E9(SC-notifications.md)가 이미 "본인 작성 메시지의 반응·답글"을
      // relatedOnly 등급으로 명시한 것과 같은 등급이다 — "나에게 직접 일어난 일"류가
      // relatedOnly로 수렴한다는 방증이기도 하다. 알림함(인앱) 기록은 190이 이미
      // notification_level과 무관하게 항상 남긴다 — 이 값은 오직 "기기가 울리는가"만
      // 정한다.
      requiredLevel: 1,
      routeData: { route_type: 1, route_id: binder_id },
    });
  }
});

eventBus.on('device:registered', ({ user_id }) => {
  notificationService.subscribeUserToAllBinders(user_id);
});
