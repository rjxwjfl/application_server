const userService = require('./userService');
const { BinderService } = require('./binderService');
const { generateUUID } = require('../utils/uuid');
const { UserDAO } = require('../daos/userDAO');
const { UserSettingsDAO } = require('../daos/userSettingsDAO');
const eventBus = require('../events/eventBus');
const { admin } = require('../utils/firebase');
const pool = require('../../config/db');
const withTransaction = require('../core/withTransaction');
const logger = require('../utils/logger');
const { NotFoundError } = require('../core/errors');

class AuthService {
  async getMe(uid) {
    const user = await UserDAO.findByUid(pool, uid);
    if (!user) return null;

    const { status, ...userData } = user;
    const settings = await UserSettingsDAO.get(pool, user.id);

    await UserDAO.updateLastActivity(pool, uid);
    return { user: userData, settings, status };
  }

  async register(userData, data) {
    const { device_info } = data;

    const { user, userSettings, binder } = await withTransaction(async (client) => {
      const { user, userSettings } = await userService.createUser(
        {
          uid: userData.uid,
          email: userData.email,
          display_name: userData.name || userData.email?.split('@')[0],
          provider: userData.firebase?.sign_in_provider || 'custom',
          image_url: userData.picture || null,
        },
        client
      );

      if (device_info && device_info.device_uuid) {
        await userService.registerDevice(user.id, device_info, client);
      }

      // RLY-20260806-229 — 가입 시 본인 바인더 자동 생성(user_workflows.md §5-9 확정).
      //
      // ⚠️ 이 블록이 없어서 가입 직후 첫 실행이 반드시 에러로 끝났다. 클라
      // `auth_repository.userInitialize`는 응답에 `binder`가 없으면 예외를 던지는데
      // (auth_repository.dart:330 — 주석이 "register 트랜잭션에서 서버가 기본 binder까지
      // 원자적으로 생성"이라고 계약을 그대로 적어 두고 있다) 서버는 `{user, settings}`만
      // 돌려주고 있었다. 문서·클라·서버 셋이 서로 다른 것을 전제하고 있었다.
      //
      // ⚠️ 같은 트랜잭션(client)에서 만든다 — 유저만 생기고 바인더가 없는 계정이 남으면
      // 클라는 매 실행마다 같은 지점에서 예외를 맞는다. 원자성이 이 결함의 핵심이다.
      //
      // 바인더 id는 서버가 정한다. 클라 발급 규약(system.md §10-2)은 "로컬에 먼저 만들어
      // 화면에 보여주는 항목"이 조건인데, 가입 바인더는 응답을 받은 뒤에야 로컬에 쓰이므로
      // 해당하지 않는다. 클라는 받은 id를 pending으로 고정해 두었다가 이후 단계가 실패하면
      // 그 id로 멱등 재시도한다(auth_repository.dart:303-306).
      const binder = await BinderService.createBinderTx(
        client,
        { id: generateUUID(), name: user.display_name ? `${user.display_name}의 바인더` : '내 바인더' },
        user.id
      );

      return { user, userSettings, binder };
    });

    // 트랜잭션 외부에서 Firebase Custom Claim 발급
    // 실패 시 가입 롤백 — 클라가 클레임 폴링 실패 후 재시도하면 ConflictError 로
    // 영구 진입 불가 상태가 되는 것을 방지한다 (silent failure 차단).
    try {
      await admin.auth().setCustomUserClaims(userData.uid, { db_user_id: user.id });
    } catch (claimError) {
      logger.error('Firebase Custom Claims 설정 실패 — 가입 롤백 시도', {
        error: claimError.message,
        uid: userData.uid,
        userId: user.id,
      });
      try {
        await withTransaction(async (client) => {
          await UserDAO.cleanupFailedRegistration(client, user.id, binder.binder.id);
        });
        logger.info('가입 롤백 완료', { userId: user.id });
      } catch (rollbackError) {
        logger.error('CRITICAL: 클레임 실패 후 가입 롤백도 실패 — 수동 정리 필요', {
          userId: user.id,
          uid: userData.uid,
          rollbackError: rollbackError.message,
        });
      }
      const err = new Error('가입 처리 중 인증 정보 설정에 실패했습니다. 잠시 후 다시 시도해주세요.');
      err.statusCode = 503;
      err.errorCode = 'CLAIM_ISSUANCE_FAILED';
      throw err;
    }

    eventBus.emit('user:registered', {
      user_id: user.id,
      provider: userData.firebase?.sign_in_provider || 'custom',
    });

    // RLY-20260806-229 — createBinder 경로가 트랜잭션 후에 emit하는 것과 같은 이벤트다.
    // 여기서 빠뜨리면 가입으로 만들어진 바인더만 sync·활동 기록의 출발점이 없어진다.
    eventBus.emit('member:joined', {
      user_id: user.id,
      binder_id: binder.binder.id,
      device_uuid: device_info?.device_uuid,
    });

    return { user, settings: userSettings, binder };
  }

  async updateMe(uid, updateData) {
    return await userService.updateUser(uid, updateData);
  }

  async deleteMe(uid) {
    return await userService.deleteUser(uid);
  }

  async registerDevice(uid, deviceData) {
    const user = await userService.getUserByUid(uid);
    const device = await userService.registerDevice(user.id, deviceData);

    eventBus.emit('device:registered', { user_id: user.id });

    return device;
  }

  async updateProfileImage(uid, data) {
    return await userService.updateUser(uid, data);
  }

  async logout(uid, deviceUuid) {
    const user = await userService.getUserByUid(uid);
    if (!user) return;
    if (deviceUuid) {
      await UserDAO.deactivateDevice(pool, user.id, deviceUuid);
    }
  }

  async reactivate(uid, data) {
    const user = await withTransaction(async (client) => {
      const reactivated = await UserDAO.reactivate(client, uid);
      if (!reactivated) return null;

      if (data?.device_info?.device_uuid) {
        await userService.registerDevice(reactivated.id, data.device_info, client);
      }

      return reactivated;
    });

    // RLY-20260806-212 — 이전엔 여기서 null을 반환했고 controller가 결과를 검사하지 않아
    // 항상 200 + "계정이 복구되었습니다"를 돌려줬다(아무 것도 안 바뀌었어도). UserDAO.reactivate
    // 가드(status=1·deleted_at IS NULL 요구)를 넣은 지금은 "휴면이 아님"·"active"·"소프트
    // 삭제(자진 탈퇴 또는 영구 차단)" 세 경우 모두 여기로 떨어진다 — 이 셋을 구분해서
    // 응답하면(예: 차단은 403, 없음은 404) 공격자가 응답 차이로 "이 계정이 차단됐는가"를
    // 추론하는 존재 오라클이 생긴다. specialDayService.getById의 F-S8a와 같은 위장 —
    // 이유를 가리지 않고 전부 같은 404로 접는다.
    if (!user) throw new NotFoundError('복구할 계정을 찾을 수 없습니다');

    const settings = await UserSettingsDAO.get(pool, user.id);
    const { status, ...userData } = await UserDAO.findByUid(pool, uid);
    return { user: userData, settings, status };
  }

  async getDevices(uid) {
    const user = await userService.getUserByUid(uid);
    if (!user) return [];
    return await UserDAO.listDevices(pool, user.id);
  }

  async removeDevice(uid, deviceUuid) {
    const user = await userService.getUserByUid(uid);
    if (!user) return false;
    return await UserDAO.deactivateDevice(pool, user.id, deviceUuid);
  }

  async updateSettings(userId, settings) {
    return await userService.updateSettings(userId, settings);
  }
}

module.exports = new AuthService();
