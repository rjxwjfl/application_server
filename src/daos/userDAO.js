/**
 * src/daos/userDAO.js
 * =========================================
 * 사용자 데이터 접근 객체 (DAO)
 * 
 * Firebase Auth + PostgreSQL 사용자 관리
 * - Firebase UID를 기본 식별자로 사용
 * - 서버에서 생성한 UUID를 사용자 ID로 저장
 * - Soft delete 지원
 * =========================================
 */

const { Pool } = require('pg');

// 연결 풀 (loaders에서 초기화됨)
let pool;

/**
 * 연결 풀 설정
 * @param {Pool} dbPool - PostgreSQL 연결 풀
 */
function setPool(dbPool) {
  pool = dbPool;
}

class UserDAO {
  /**
   * Firebase UID로 사용자 조회
   * @param {string} uid - Firebase UID
   * @returns {Promise<Object>} 사용자 정보
   */
  async findByUid(uid) {
    try {
      const query = `
        SELECT id, uid, email, display_name, user_code, bio, image_url, 
               thumbnail_url, status, created_at, updated_at, latest_activity_at
        FROM users 
        WHERE uid = $1 AND deleted_at IS NULL
      `;
      const result = await pool.query(query, [uid]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('❌ 사용자 조회 실패 (UID):', error);
      throw error;
    }
  }

  /**
   * 사용자 ID로 사용자 조회
   * @param {string} id - 사용자 UUID
   * @returns {Promise<Object>} 사용자 정보
   */
  async findById(id) {
    try {
      const query = `
        SELECT id, uid, display_name, user_code, bio, image_url, 
               thumbnail_url, status, created_at, updated_at, latest_activity_at
        FROM users 
        WHERE id = $1 AND deleted_at IS NULL
      `;
      const result = await pool.query(query, [id]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('❌ 사용자 조회 실패 (ID):', error);
      throw error;
    }
  }

  /**
   * 이메일로 사용자 조회
   * @param {string} email - 이메일
   * @returns {Promise<Object>} 사용자 정보
   */
  async findByEmail(email) {
    try {
      const query = `
        SELECT id, uid, email, display_name, user_code, bio, image_url, 
               thumbnail_url, status, created_at, updated_at, latest_activity_at
        FROM users 
        WHERE email = $1 AND deleted_at IS NULL
      `;
      const result = await pool.query(query, [email]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('❌ 사용자 조회 실패 (이메일):', error);
      throw error;
    }
  }

  /**
   * 사용자 생성
   * @param {Object} userData - 사용자 정보
   * @returns {Promise<Object>} 생성된 사용자
   */
  async create(userData) {
    try {
      const { 
        id, uid, email, provider, displayName, userCode, 
        imageUrl, thumbnailUrl, bio, status 
      } = userData;

      const query = `
        INSERT INTO users (
          id, uid, email, provider, display_name, user_code, 
          image_url, thumbnail_url, bio, status, created_at, updated_at, latest_activity_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW(), NOW())
        RETURNING id, uid, email, display_name, user_code, image_url, 
                  thumbnail_url, bio, status, created_at, updated_at
      `;

      const result = await pool.query(query, [
        id, uid, email, provider, displayName, userCode, 
        imageUrl, thumbnailUrl, bio, status || 0
      ]);

      return result.rows[0];
    } catch (error) {
      console.error('❌ 사용자 생성 실패:', error);
      throw error;
    }
  }

  /**
   * 사용자 정보 수정
   * @param {string} uid - Firebase UID
   * @param {Object} updateData - 수정할 정보
   * @returns {Promise<Object>} 수정된 사용자
   */
  async update(uid, updateData) {
    try {
      const { displayName, bio, imageUrl, thumbnailUrl, status } = updateData;

      const query = `
        UPDATE users
        SET 
          display_name = COALESCE($1, display_name),
          bio = COALESCE($2, bio),
          image_url = COALESCE($3, image_url),
          thumbnail_url = COALESCE($4, thumbnail_url),
          status = COALESCE($5, status),
          updated_at = NOW(),
          latest_activity_at = NOW()
        WHERE uid = $6 AND deleted_at IS NULL
        RETURNING id, uid, email, display_name, user_code, image_url, 
                  thumbnail_url, bio, status, created_at, updated_at
      `;

      const result = await pool.query(query, [
        displayName, bio, imageUrl, thumbnailUrl, status, uid
      ]);

      return result.rows[0] || null;
    } catch (error) {
      console.error('❌ 사용자 수정 실패:', error);
      throw error;
    }
  }

  /**
   * 사용자 소프트 삭제 (soft delete)
   * @param {string} uid - Firebase UID
   * @returns {Promise<boolean>} 삭제 성공 여부
   */
  async softDelete(uid) {
    try {
      const query = `
        UPDATE users
        SET deleted_at = NOW(), updated_at = NOW()
        WHERE uid = $1 AND deleted_at IS NULL
        RETURNING id
      `;

      const result = await pool.query(query, [uid]);
      return result.rowCount > 0;
    } catch (error) {
      console.error('❌ 사용자 삭제 실패:', error);
      throw error;
    }
  }

  /**
   * 사용자 코드로 사용자 조회
   * @param {string} userCode - 사용자 코드
   * @returns {Promise<Object>} 사용자 정보
   */
  async findByUserCode(userCode) {
    try {
      const query = `
        SELECT id, uid, display_name, user_code, bio, image_url, 
               thumbnail_url, status, created_at, latest_activity_at
        FROM users 
        WHERE user_code = $1 AND deleted_at IS NULL
      `;

      const result = await pool.query(query, [userCode]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('❌ 사용자 조회 실패 (코드):', error);
      throw error;
    }
  }

  /**
   * 기기 생성
   * @param {Object} deviceData - 기기 정보
   * @returns {Promise<Object>} 생성된 기기
   */
  async createDevice(deviceData) {
    try {
      const { id, userId, deviceUuid, deviceToken, platform, name, appVersion, osVersion } = deviceData;

      const query = `
        INSERT INTO user_devices (
          id, user_id, device_uuid, device_token, platform, name, app_version, os_version,
          is_active, created_at, updated_at, last_used_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, NOW(), NOW(), NOW())
        ON CONFLICT (user_id, device_uuid) DO UPDATE SET
          device_token = EXCLUDED.device_token,
          is_active = TRUE,
          updated_at = NOW(),
          last_used_at = NOW()
        RETURNING id, user_id, device_uuid, platform, name
      `;

      const result = await pool.query(query, [
        id, userId, deviceUuid, deviceToken, platform, name, appVersion, osVersion
      ]);

      return result.rows[0];
    } catch (error) {
      console.error('❌ 기기 생성 실패:', error);
      throw error;
    }
  }

  /**
   * 마지막 활동 시간 업데이트
   * @param {string} uid - Firebase UID
   * @returns {Promise<boolean>} 성공 여부
   */
  async updateLastActivity(uid) {
    try {
      const query = `
        UPDATE users
        SET latest_activity_at = NOW()
        WHERE uid = $1 AND deleted_at IS NULL
      `;

      await pool.query(query, [uid]);
      return true;
    } catch (error) {
      console.error('❌ 마지막 활동 시간 업데이트 실패:', error);
      throw error;
    }
  }
}

module.exports = { UserDAO: new UserDAO(), setPool };

