/**
 * src/daos/userDAO.js
 * =========================================
 * 사용자 데이터 접근 객체 (DAO)
 *
 * Firebase Auth + PostgreSQL 사용자 관리
 * - users + user_infos 테이블 JOIN 사용
 * - Firebase UID를 기본 식별자로 사용
 * - 서버에서 생성한 UUID를 사용자 ID로 저장
 * - Soft delete 지원
 * =========================================
 */

class UserDAO {
  /**
   * Firebase UID로 사용자 조회
   * @param {object} conn - DB Connection (Pool or Client)
   * @param {string} uid - Firebase UID
   * @returns {Promise<Object>} 사용자 정보
   */
  async findByUid(conn, uid) {
    const query = `
      SELECT
        u.id,
        u.status,
        ui.user_code,
        ui.display_name,
        ui.bio,
        ui.image_url,
        ui.thumbnail_url,
        u.created_at,
        u.updated_at,
        u.deleted_at
      FROM users u
      LEFT JOIN user_infos ui ON u.id = ui.user_id
      WHERE u.firebase_uid = $1 AND u.deleted_at IS NULL
    `;
    const result = await conn.query(query, [uid]);
    return result.rows[0] || null;
  }

  /**
   * 사용자 ID로 사용자 조회
   * @param {object} conn - DB Connection
   * @param {string} id - 사용자 UUID
   * @returns {Promise<Object>} 사용자 정보
   */
  async findById(conn, id) {
    const query = `
      SELECT u.id, u.firebase_uid, u.email, u.provider, u.status,
             u.created_at, u.updated_at, u.latest_activity_at,
             ui.user_code, ui.display_name, ui.bio, ui.image_url, ui.thumbnail_url
      FROM users u
      LEFT JOIN user_infos ui ON u.id = ui.user_id
      WHERE u.id = $1 AND u.deleted_at IS NULL
    `;
    const result = await conn.query(query, [id]);
    return result.rows[0] || null;
  }

  /**
   * 이메일로 사용자 조회
   * @param {object} conn - DB Connection
   * @param {string} email - 이메일
   * @returns {Promise<Object>} 사용자 정보
   */
  async findByEmail(conn, email) {
    const query = `
      SELECT u.id, u.firebase_uid, u.email, u.provider, u.status,
             u.created_at, u.updated_at, u.latest_activity_at,
             ui.user_code, ui.display_name, ui.bio, ui.image_url, ui.thumbnail_url
      FROM users u
      LEFT JOIN user_infos ui ON u.id = ui.user_id
      WHERE u.email = $1 AND u.deleted_at IS NULL
    `;
    const result = await conn.query(query, [email]);
    return result.rows[0] || null;
  }

  /**
   * 사용자 생성 (users + user_infos 동시 INSERT)
   * @param {object} conn - DB Connection (트랜잭션 Client 권장)
   * @param {Object} userData - 사용자 정보
   * @returns {Promise<Object>} 생성된 사용자
   */
  async create(conn, userData) {
    const {
      id, uid, email, provider, display_name, user_code,
      image_url, thumbnail_url, bio, status
    } = userData;

    const userQuery = `
      INSERT INTO users (id, firebase_uid, email, provider, status, created_at, updated_at, latest_activity_at)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), NOW())
      RETURNING id, firebase_uid, email, provider, status, created_at, updated_at, latest_activity_at
    `;
    const userResult = await conn.query(userQuery, [
      id, uid, email, provider, status || 0
    ]);

    const infoQuery = `
      INSERT INTO user_infos (user_id, user_code, display_name, bio, image_url, thumbnail_url, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING user_code, display_name, bio, image_url, thumbnail_url
    `;
    const infoResult = await conn.query(infoQuery, [
      id, user_code, display_name, bio || null, image_url || null, thumbnail_url || null
    ]);

    return { ...userResult.rows[0], ...infoResult.rows[0] };
  }

  /**
   * 사용자 정보 수정
   * @param {object} conn - DB Connection (트랜잭션 Client 권장)
   * @param {string} uid - Firebase UID
   * @param {Object} updateData - 수정할 정보
   * @returns {Promise<Object>} 수정된 사용자
   */
  async update(conn, uid, updateData) {
    const { display_name, bio, image_url, thumbnail_url, status } = updateData;

    // users 테이블 업데이트 (status, latest_activity_at)
    const userQuery = `
      UPDATE users
      SET status = COALESCE($1, status),
          updated_at = NOW(),
          latest_activity_at = NOW()
      WHERE firebase_uid = $2 AND deleted_at IS NULL
      RETURNING id, firebase_uid, email, provider, status, created_at, updated_at, latest_activity_at
    `;
    const userResult = await conn.query(userQuery, [status, uid]);
    if (!userResult.rows[0]) return null;

    const userId = userResult.rows[0].id;

    // user_infos 테이블 업데이트 (프로필 정보)
    const infoQuery = `
      UPDATE user_infos
      SET display_name = COALESCE($1, display_name),
          bio = COALESCE($2, bio),
          image_url = COALESCE($3, image_url),
          thumbnail_url = COALESCE($4, thumbnail_url),
          updated_at = NOW()
      WHERE user_id = $5
      RETURNING user_code, display_name, bio, image_url, thumbnail_url
    `;
    const infoResult = await conn.query(infoQuery, [
      display_name, bio, image_url, thumbnail_url, userId
    ]);

    return { ...userResult.rows[0], ...infoResult.rows[0] };
  }

  /**
   * 사용자 소프트 삭제 (soft delete)
   * @param {object} conn - DB Connection
   * @param {string} uid - Firebase UID
   * @returns {Promise<boolean>} 삭제 성공 여부
   */
  async softDelete(conn, uid) {
    const query = `
      UPDATE users
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE firebase_uid = $1 AND deleted_at IS NULL
      RETURNING id
    `;

    const result = await conn.query(query, [uid]);
    return result.rowCount > 0;
  }

  /**
   * 사용자 코드로 사용자 조회
   * @param {object} conn - DB Connection
   * @param {string} userCode - 사용자 코드
   * @returns {Promise<Object>} 사용자 정보
   */
  async findByUserCode(conn, userCode) {
    const query = `
      SELECT u.id, u.firebase_uid, u.email, u.status,
             u.created_at, u.latest_activity_at,
             ui.user_code, ui.display_name, ui.bio, ui.image_url, ui.thumbnail_url
      FROM user_infos ui
      JOIN users u ON ui.user_id = u.id
      WHERE ui.user_code = $1 AND u.deleted_at IS NULL
    `;

    const result = await conn.query(query, [userCode]);
    return result.rows[0] || null;
  }

  /**
   * 기기 생성
   * @param {object} conn - DB Connection
   * @param {Object} deviceData - 기기 정보
   * @returns {Promise<Object>} 생성된 기기
   */
  async createDevice(conn, deviceData) {
    const { id, user_id, device_uuid, device_token, platform, device_name, app_version, os_version } = deviceData;

    const query = `
      INSERT INTO user_devices (
        id, user_id, device_uuid, device_token, platform, device_name, app_version, os_version,
        is_active, created_at, updated_at, last_used_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, NOW(), NOW(), NOW())
      ON CONFLICT (user_id, device_uuid) DO UPDATE SET
        device_token = EXCLUDED.device_token,
        is_active = TRUE,
        updated_at = NOW(),
        last_used_at = NOW()
      RETURNING id, user_id, device_uuid, platform, device_name
    `;

    const result = await conn.query(query, [
      id, user_id, device_uuid, device_token, platform, device_name, app_version, os_version
    ]);

    return result.rows[0];
  }

  /**
   * 마지막 활동 시간 업데이트
   * @param {object} conn - DB Connection
   * @param {string} uid - Firebase UID
   * @returns {Promise<boolean>} 성공 여부
   */
  async updateLastActivity(conn, uid) {
    const query = `
      UPDATE users
      SET latest_activity_at = NOW()
      WHERE firebase_uid = $1 AND deleted_at IS NULL
    `;

    await conn.query(query, [uid]);
    return true;
  }

  async listDevices(conn, userId) {
    const { rows } = await conn.query(
      `SELECT id, device_uuid, platform, device_name, app_version, os_version,
              is_active, created_at, last_used_at
       FROM user_devices
       WHERE user_id = $1 AND is_active = TRUE
       ORDER BY last_used_at DESC`,
      [userId]
    );
    return rows;
  }

  async deactivateDevice(conn, userId, deviceUuid) {
    const { rowCount } = await conn.query(
      `UPDATE user_devices
       SET is_active = FALSE, updated_at = NOW()
       WHERE user_id = $1 AND device_uuid = $2`,
      [userId, deviceUuid]
    );
    return rowCount > 0;
  }

  async reactivate(conn, uid) {
    const { rows } = await conn.query(
      `UPDATE users
       SET deleted_at = NULL, status = 0, updated_at = NOW()
       WHERE firebase_uid = $1
       RETURNING id, firebase_uid, email, provider, status, created_at, updated_at`,
      [uid]
    );
    return rows[0] || null;
  }

  /**
   * 가입 실패 롤백 — Custom Claim 발급 실패 등으로 인한 트랜잭션 외부 실패 시 호출.
   * users + user_infos + user_settings + user_devices 모두 hard delete.
   * @param {object} conn - DB Connection (트랜잭션 Client 권장)
   * @param {string} userId - 사용자 UUID
   * @returns {Promise<boolean>} 삭제 성공 여부
   */
  async cleanupFailedRegistration(conn, userId) {
    // FK ON DELETE CASCADE 미지정이므로 의존 테이블부터 순차 삭제
    await conn.query('DELETE FROM user_devices  WHERE user_id = $1', [userId]);
    await conn.query('DELETE FROM user_settings WHERE user_id = $1', [userId]);
    await conn.query('DELETE FROM user_infos    WHERE user_id = $1', [userId]);
    const { rowCount } = await conn.query('DELETE FROM users WHERE id = $1', [userId]);
    return rowCount > 0;
  }

  async updateById(conn, userId, updateData) {
    const { display_name, bio, image_url, thumbnail_url } = updateData;

    const infoQuery = `
      UPDATE user_infos
      SET display_name = COALESCE($1, display_name),
          bio = COALESCE($2, bio),
          image_url = COALESCE($3, image_url),
          thumbnail_url = COALESCE($4, thumbnail_url),
          updated_at = NOW()
      WHERE user_id = $5
      RETURNING user_code, display_name, bio, image_url, thumbnail_url
    `;
    const { rows } = await conn.query(infoQuery, [
      display_name, bio, image_url, thumbnail_url, userId
    ]);
    return rows[0] || null;
  }
}

module.exports = { UserDAO: new UserDAO() };
