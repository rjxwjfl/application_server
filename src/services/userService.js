const { UserDAO } = require('../daos/userDAO');
const { UserSettingsDAO } = require('../daos/userSettingsDAO');
const { MediaService } = require('./mediaService');

const { generateUUID, generateUserCode } = require('../utils/uuid');
const pool = require('../../config/db');
const withTransaction = require('../core/withTransaction');
const { BadRequestError, NotFoundError, ConflictError, ForbiddenError } = require('../core/errors');

// RLY-20260806-066 — 타인 조회 응답에 남겨도 되는 필드. 본인이 프로필로 공개한 정보 +
// 조회에 필요한 식별자·시간정보. email·firebase_uid·provider·status·latest_activity_at은
// 계정 식별·인증·활동 기록이라 여기서 제외한다(본인 조회는 이 필터를 타지 않는다).
const PUBLIC_USER_FIELDS = ['id', 'user_code', 'display_name', 'bio', 'image_url', 'thumbnail_url', 'created_at', 'updated_at'];

function toPublicProfile(user) {
  const result = {};
  for (const field of PUBLIC_USER_FIELDS) {
    if (field in user) result[field] = user[field];
  }
  return result;
}

class UserService {
  async createUser(userData, client) {
    const {
      uid,
      email,
      display_name,
      provider,
      image_url = null,
      thumbnail_url = null,
      bio = null,
      status = 0,
    } = userData;

    if (email) {
      const existingUser = await UserDAO.findByEmail(client, email);
      if (existingUser) throw new ConflictError('이미 가입된 이메일입니다');
    }

    const userId = generateUUID();
    const userCode = generateUserCode();

    const user = await UserDAO.create(client, {
      id: userId,
      uid,
      email,
      provider,
      display_name,
      user_code: userCode,
      image_url,
      thumbnail_url,
      bio,
      status,
    });

    const userSettings = await UserSettingsDAO.createDefault(client, userId);

    return { user, userSettings };
  }

  async getUserByUid(uid) {
    return await UserDAO.findByUid(pool, uid);
  }

  // RLY-20260806-066 — GET /users/:id 가 findById 결과(email·firebase_uid·provider·status·
  // latest_activity_at 포함)를 그대로 반환해, 인증된 아무나 유저 id만 알면 타인의 계정
  // 식별·인증·활동 기록을 얻던 과다노출의 수리. 기준: 본인이 프로필로 공개한 정보(user_code·
  // display_name·bio·image_url·thumbnail_url)와 조회에 필요한 식별자(id)·시간정보(created_at·
  // updated_at)는 누구에게나, 계정 식별·인증·활동 기록(email·firebase_uid·provider·status·
  // latest_activity_at)은 본인에게만 — requesterId는 인증된 신원(req.user_id)만 받는다.
  // 054(updateUserById)가 세운 본인 판정 선례를 조회 경로에 재사용한다.
  async getUserById(userId, requesterId) {
    const user = await UserDAO.findById(pool, userId);
    if (!user) return null;
    return userId === requesterId ? user : toPublicProfile(user);
  }

  // RLY-20260806-066 — GET /users/code/:code 도 findByUserCode를 그대로 반환해 동일하게
  // 과다노출되고 있었다. 유저 코드로 접근해도 대상은 여전히 "타인"이므로 같은 필터를 적용한다.
  async getUserByUserCode(userCode, requesterId) {
    const user = await UserDAO.findByUserCode(pool, userCode);
    if (!user) return null;
    return user.id === requesterId ? user : toPublicProfile(user);
  }

  async updateUser(uid, updateData) {
    const { display_name, bio, image_url, thumbnail_url } = updateData;

    const updatedUser = await withTransaction(async (client) => {
      // RLY-20260806-052 — image_url·thumbnail_url을 실제로 바꾸려는 요청일 때만 소유권을
      // 검증한다(register/OAuth가 심는 provider photoURL은 UserDAO.create 경로라 여기 안 걸린다).
      if (image_url !== undefined || thumbnail_url !== undefined) {
        const existing = await UserDAO.findByUid(client, uid);
        if (!existing) throw new NotFoundError('사용자를 찾을 수 없습니다');
        await MediaService.assertOwnedMediaReference(image_url, { prefix: 'avatars', entityId: existing.id });
        await MediaService.assertOwnedMediaReference(thumbnail_url, { prefix: 'avatars', entityId: existing.id });
      }

      const result = await UserDAO.update(client, uid, {
        display_name,
        bio,
        image_url,
        thumbnail_url,
      });
      if (!result) throw new NotFoundError('사용자를 찾을 수 없습니다');
      return result;
    });

    return updatedUser;
  }

  async deleteUser(uid) {
    return await withTransaction(async (client) => {
      return await UserDAO.softDelete(client, uid);
    });
  }

  // RLY-20260806-054 — req.params.id를 요청자 신원과 대조하지 않아 로그인한 아무나 타인의
  // display_name·bio를 바꿀 수 있던 IDOR의 수리. requesterId는 인증된 신원(req.user_id)만
  // 받는다 — 관리자 우회는 이 저장소에 그런 개념이 없어 만들지 않는다.
  async updateUserById(userId, updateData, requesterId) {
    if (userId !== requesterId) {
      throw new ForbiddenError('본인 프로필만 수정할 수 있습니다', 'USER_UPDATE_FORBIDDEN');
    }
    return await withTransaction(async (client) => {
      // RLY-20260806-052 — 위 updateUser와 동일한 소유권 검증.
      if (updateData.image_url !== undefined) {
        await MediaService.assertOwnedMediaReference(updateData.image_url, { prefix: 'avatars', entityId: userId });
      }
      if (updateData.thumbnail_url !== undefined) {
        await MediaService.assertOwnedMediaReference(updateData.thumbnail_url, { prefix: 'avatars', entityId: userId });
      }

      const result = await UserDAO.updateById(client, userId, updateData);
      if (!result) throw new NotFoundError('사용자를 찾을 수 없습니다');
      return result;
    });
  }

  async updateSettings(userId, settings) {
    return await UserSettingsDAO.updatePartial(pool, userId, settings);
  }

  async registerDevice(userId, deviceData, conn = pool) {
    const {
      device_uuid,
      device_type,
      fcm_token,
      device_name,
      app_version,
      os_version,
    } = deviceData;

    if (!device_type) {
      throw new BadRequestError('device_type이 필요합니다');
    }

    const device = await UserDAO.createDevice(conn, {
      id: generateUUID(),
      user_id: userId,
      device_uuid,
      device_token: fcm_token,
      platform: device_type,
      device_name,
      app_version,
      os_version,
    });

    return device;
  }
}

module.exports = new UserService();
