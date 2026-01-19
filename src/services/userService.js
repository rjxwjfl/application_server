const { UserDAO } = require('../daos/userDAO');
const firebase = require('../utils/firebase');
const { generateUUID, generateUserCode } = require('../utils/uuid');

class UserService {
  async signUpOrLogin(idToken) {
    try {
      const decodedToken = await firebase.verifyIdToken(idToken);
      const { uid, email, name, picture } = decodedToken;

      let user = await UserDAO.findByUid(uid);

      if (user) {
        await UserDAO.updateLastActivity(uid);
        return user;
      }

      const newUser = await this.createUser({
        uid,
        email,
        displayName: name || email.split('@')[0],
        provider: decodedToken.firebase?.sign_in_provider || 'custom',
        imageUrl: picture || null,
      });

      return newUser;
    } catch (error) {
      console.error('❌ 가입/로그인 실패:', error.message);
      throw error;
    }
  }

  async createUser(userData) {
    try {
      const {
        uid,
        email,
        displayName,
        provider = 'google',
        imageUrl = null,
        thumbnailUrl = null,
        bio = null,
        status = 0,
      } = userData;

      if (email) {
        const existingUser = await UserDAO.findByEmail(email);
        if (existingUser) {
          throw new Error('이미 가입된 이메일입니다');
        }
      }

      const userId = generateUUID();
      const userCode = generateUserCode();

      const newUser = await UserDAO.create({
        id: userId,
        uid,
        email,
        provider,
        displayName,
        userCode,
        imageUrl,
        thumbnailUrl,
        bio,
        status,
      });

      return {
        id: newUser.id,
        uid: newUser.uid,
        email: newUser.email,
        displayName: newUser.display_name,
        userCode: newUser.user_code,
        imageUrl: newUser.image_url,
        thumbnailUrl: newUser.thumbnail_url,
        bio: newUser.bio,
        status: newUser.status,
        createdAt: newUser.created_at,
      };
    } catch (error) {
      console.error('❌ 사용자 생성 실패:', error.message);
      throw error;
    }
  }

  async getUserByUid(uid) {
    try {
      const user = await UserDAO.findByUid(uid);
      if (!user) {
        throw new Error('사용자를 찾을 수 없습니다');
      }
      return this._formatUser(user);
    } catch (error) {
      console.error('❌ 사용자 조회 실패:', error.message);
      throw error;
    }
  }

  async getUserById(userId) {
    try {
      const user = await UserDAO.findById(userId);
      if (!user) {
        throw new Error('사용자를 찾을 수 없습니다');
      }
      return this._formatUser(user);
    } catch (error) {
      console.error('❌ 사용자 조회 실패:', error.message);
      throw error;
    }
  }

  async getUserByUserCode(userCode) {
    try {
      const user = await UserDAO.findByUserCode(userCode);
      if (!user) {
        throw new Error('사용자를 찾을 수 없습니다');
      }
      return this._formatUser(user, true);
    } catch (error) {
      console.error('❌ 사용자 조회 실패:', error.message);
      throw error;
    }
  }

  async updateUser(uid, updateData) {
    try {
      const { displayName, bio, imageUrl, thumbnailUrl } = updateData;

      const updatedUser = await UserDAO.update(uid, {
        displayName,
        bio,
        imageUrl,
        thumbnailUrl,
      });

      if (!updatedUser) {
        throw new Error('사용자를 찾을 수 없습니다');
      }

      return this._formatUser(updatedUser);
    } catch (error) {
      console.error('❌ 사용자 수정 실패:', error.message);
      throw error;
    }
  }

  async deleteUser(uid) {
    try {
      const result = await UserDAO.softDelete(uid);
      return result;
    } catch (error) {
      console.error('❌ 사용자 삭제 실패:', error.message);
      throw error;
    }
  }

  async registerDevice(userId, deviceData) {
    try {
      const { deviceUuid, deviceToken, platform, name, appVersion, osVersion } = deviceData;

      const device = await UserDAO.createDevice({
        id: generateUUID(),
        userId,
        deviceUuid,
        deviceToken,
        platform,
        name,
        appVersion,
        osVersion,
      });

      return device;
    } catch (error) {
      console.error('❌ 기기 등록 실패:', error.message);
      throw error;
    }
  }

  _formatUser(user, isPublic = false) {
    const formatted = {
      id: user.id,
      displayName: user.display_name,
      userCode: user.user_code,
      imageUrl: user.image_url,
      thumbnailUrl: user.thumbnail_url,
      bio: user.bio,
      status: user.status,
      latestActivityAt: user.latest_activity_at,
    };

    if (!isPublic) {
      formatted.uid = user.uid;
      formatted.email = user.email;
      formatted.createdAt = user.created_at;
      formatted.updatedAt = user.updated_at;
    }

    return formatted;
  }
}

module.exports = new UserService();

