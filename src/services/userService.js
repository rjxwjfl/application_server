const { UserDAO } = require('../daos/userDAO');
const { UserSettingsDAO } = require('../daos/userSettingsDAO');
const { MediaService } = require('./mediaService');

const { generateUUID, generateUserCode } = require('../utils/uuid');
const pool = require('../../config/db');
const withTransaction = require('../core/withTransaction');
const { BadRequestError, NotFoundError, ConflictError, ForbiddenError } = require('../core/errors');

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

  async getUserById(userId) {
    return await UserDAO.findById(pool, userId);
  }

  async getUserByUserCode(userCode) {
    return await UserDAO.findByUserCode(pool, userCode);
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
