/**
 * src/services/drawerService.js
 * =========================================
 * 서랍(Drawer) 비즈니스 로직 서비스
 *
 * [변경 사항]
 * - DB Connection Pool Import (config/db 에서 가져온다고 가정)
 * - 트랜잭션이 필요한 메서드에서 pool.connect() -> BEGIN -> [DAO 호출] -> COMMIT/ROLLBACK 구현
 * - 단순 조회는 pool을 직접 DAO에 전달
 * =========================================
 */

const { DrawerDAO } = require('../daos/drawerDAO');
const { UserDAO } = require('../daos/userDAO'); // 기존 코드에 있다고 가정
const { generateUUID } = require('../utils/uuid'); // 기존 유틸
const crypto = require('crypto');

// DB 설정 파일에서 pool을 가져옵니다. 경로를 환경에 맞게 수정하세요.
const pool = require('../../config/db');

class DrawerService {

  // 단순 조회: 트랜잭션 불필요 -> pool을 바로 사용
  async searchDrawers(keyword, limit = 20, offset = 0) {
    if (!keyword || keyword.trim().length < 2) {
      throw new Error('검색 키워드는 최소 2자 이상이어야 합니다');
    }
    // pool은 query 메서드를 가지고 있으므로 client처럼 사용 가능 (Duck Typing)
    return await DrawerDAO.searchByName(pool, keyword, limit, offset);
  }

  // 생성: 트랜잭션 필요 (Drawer -> Settings -> Member)
  async createDrawer(uid, drawerData) {
    const { name } = drawerData;
    if (!name || name.trim().length === 0) {
      const error = new Error('Drawer 이름이 필요합니다');
      error.status = 400;
      throw error;
    }

    // User 조회는 트랜잭션 밖에서 해도 무방 (단순 조회)
    // 주의: UserDAO가 리팩토링 되지 않았다면 pool을 내부적으로 쓸 것이고,
    // 리팩토링 되었다면 첫 인자로 pool을 넘겨야 함. 여기선 리팩토링 되었다고 가정하고 pool 전달.
    // 만약 UserDAO가 구형이라면 UserDAO.findByUid(uid)로 호출하세요.
    const user = await UserDAO.findByUid(pool, uid);
    if (!user) {
      const error = new Error('사용자를 찾을 수 없습니다');
      error.status = 401;
      throw error;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const drawerId = generateUUID();
      // 1. Drawer 생성
      const drawer = await DrawerDAO.create(client, drawerId, drawerData, user.id);
      // 2. Settings 생성
      await DrawerDAO.createSettings(client, drawerId);
      // 3. Owner 등록
      await DrawerDAO.addMember(client, drawerId, user.id, 0);

      await client.query('COMMIT');

      return {
        id: drawer.id,
        name: drawer.name,
        description: drawer.description,
        imageUrl: drawer.image_url,
        thumbnailUrl: drawer.thumbnail_url,
        memberCount: drawer.member_count,
        createdAt: drawer.created_at,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ 서랍 생성 실패:', error.message);
      throw error;
    } finally {
      client.release();
    }
  }

  async getMyDrawers(uid) {
    const user = await UserDAO.findByUid(pool, uid);
    if (!user) {
      const error = new Error('사용자를 찾을 수 없습니다');
      error.status = 401;
      throw error;
    }

    const drawers = await DrawerDAO.getMyDrawers(pool, user.id);
    return drawers.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      imageUrl: d.image_url,
      thumbnailUrl: d.thumbnail_url,
      memberCount: d.member_count,
      role: d.role,
      notificationLevel: d.notification_level,
      joinedAt: d.joined_at,
      lastActivityAt: d.last_activity_at,
    }));
  }

  async issueDrawerInvitation(drawerId, uid) {
    const user = await UserDAO.findByUid(pool, uid);
    if (!user) {
      const error = new Error('사용자를 찾을 수 없습니다');
      error.status = 401;
      throw error;
    }

    // 조회는 pool 사용
    const member = await DrawerDAO.getMember(pool, drawerId, user.id);
    if (!member || member.role !== 0) {
      const error = new Error('초대 권한이 없습니다');
      error.status = 403;
      throw error;
    }

    const invitationId = generateUUID();
    const token = this.generateInvitationToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    // 단일 INSERT이므로 트랜잭션 없이 pool 사용 가능 (혹은 안전하게 client 써도 됨)
    const invitation = await DrawerDAO.createInvitation(
      pool,
      invitationId,
      drawerId,
      user.id,
      token,
      expiresAt
    );

    return {
      id: invitation.id,
      invitationCode: invitation.token,
      expiresAt: invitation.expires_at,
    };
  }

  async getInvitationPreview(invitationCode) {
    const invitation = await DrawerDAO.findInvitationByToken(pool, invitationCode);
    if (!invitation) {
      const error = new Error('유효하지 않거나 만료된 초대입니다');
      error.status = 404;
      throw error;
    }

    return {
      drawerId: invitation.drawer_id,
      drawerName: invitation.drawer_name,
      description: invitation.description,
      imageUrl: invitation.image_url,
      thumbnailUrl: invitation.thumbnail_url,
      inviterName: invitation.inviter_name,
    };
  }

  // 초대 수락: 트랜잭션 필요 (멤버 추가 + 멤버 수 증가 + 초대장 사용 횟수 증가)
  async joinDrawerByInvitation(invitationCode, uid) {
    const user = await UserDAO.findByUid(pool, uid);
    if (!user) {
      const error = new Error('사용자를 찾을 수 없습니다');
      error.status = 401;
      throw error;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // SELECT for UPDATE를 쓰면 더 좋지만 여기선 로직 단순화
      const invitation = await DrawerDAO.findInvitationByToken(client, invitationCode);
      if (!invitation) {
        const error = new Error('유효하지 않거나 만료된 초대입니다');
        error.status = 404;
        throw error;
      }

      const existingMember = await DrawerDAO.getMember(client, invitation.drawer_id, user.id);
      if (existingMember && !existingMember.deleted_at) {
        const error = new Error('이미 이 서랍의 멤버입니다');
        error.status = 409;
        throw error;
      }

      // 1. 멤버 추가
      await DrawerDAO.addMember(client, invitation.drawer_id, user.id, 3);
      // 2. 카운트 증가
      await DrawerDAO.incrementMemberCount(client, invitation.drawer_id);
      // 3. 초대장 사용 처리
      await DrawerDAO.incrementInvitationUsage(client, invitationCode);

      await client.query('COMMIT');
      return { success: true };

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ 초대로 가입 실패:', error.message);
      throw error;
    } finally {
      client.release();
    }
  }

  // 가입 신청: 트랜잭션 필요 (설정 확인 -> (신청 생성 OR 멤버 추가 + 카운트 증가))
  async requestDrawerJoin(drawerId, uid) {
    const user = await UserDAO.findByUid(pool, uid);
    if (!user) {
      const error = new Error('사용자를 찾을 수 없습니다');
      error.status = 401;
      throw error;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const settings = await DrawerDAO.getSettings(client, drawerId);
      if (!settings) {
        const error = new Error('서랍을 찾을 수 없습니다');
        error.status = 404;
        throw error;
      }

      if (!settings.is_public && !settings.require_approval) {
        const error = new Error('비공개 서랍입니다');
        error.status = 403;
        throw error;
      }

      const existingMember = await DrawerDAO.getMember(client, drawerId, user.id);
      if (existingMember && !existingMember.deleted_at) {
        const error = new Error('이미 이 서랍의 멤버입니다');
        error.status = 409;
        throw error;
      }

      if (settings.require_approval) {
        const requestId = generateUUID();
        await DrawerDAO.createJoinRequest(client, requestId, drawerId, user.id);
      } else {
        await DrawerDAO.addMember(client, drawerId, user.id, 3);
        await DrawerDAO.incrementMemberCount(client, drawerId);
      }

      await client.query('COMMIT');
      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ 가입 신청 실패:', error.message);
      throw error;
    } finally {
      client.release();
    }
  }

  async getDrawerMembers(drawerId) {
    const members = await DrawerDAO.getMembers(pool, drawerId);
    return members.map((m) => ({
      userId: m.user_id,
      displayName: m.display_name,
      userCode: m.user_code,
      email: m.email,
      imageUrl: m.image_url,
      role: m.role,
      notificationLevel: m.notification_level,
      nicknameInDrawer: m.nickname_in_drawer,
      joinedAt: m.joined_at,
    }));
  }

  async updateDrawerMemberRole(drawerId, userId, role, uid) {
    const user = await UserDAO.findByUid(pool, uid);
    if (!user) {
      const error = new Error('사용자를 찾을 수 없습니다');
      error.status = 401;
      throw error;
    }

    // Role Check: 읽기이므로 pool 사용 가능
    const requester = await DrawerDAO.getMember(pool, drawerId, user.id);
    if (!requester || requester.role !== 0) {
      const error = new Error('권한이 없습니다');
      error.status = 403;
      throw error;
    }

    const validRoles = [0, 1, 2, 3];
    if (!validRoles.includes(role)) {
      const error = new Error('유효하지 않은 역할입니다');
      error.status = 400;
      throw error;
    }

    // 단일 업데이트: pool 사용
    await DrawerDAO.updateMemberRole(pool, drawerId, userId, role);
    return { success: true };
  }

  // 추방: 트랜잭션 필요 (멤버 제거 + 카운트 감소)
  async kickDrawerMember(drawerId, targetUserId, uid) {
    const user = await UserDAO.findByUid(pool, uid);
    if (!user) {
      const error = new Error('사용자를 찾을 수 없습니다');
      error.status = 401;
      throw error;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const requester = await DrawerDAO.getMember(client, drawerId, user.id);
      if (!requester || requester.role !== 0) {
        const error = new Error('권한이 없습니다');
        error.status = 403;
        throw error;
      }

      await DrawerDAO.removeMember(client, drawerId, targetUserId);
      await DrawerDAO.decrementMemberCount(client, drawerId);

      await client.query('COMMIT');
      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ 멤버 제거 실패:', error.message);
      throw error;
    } finally {
      client.release();
    }
  }

  // 탈퇴: 트랜잭션 필요 (멤버 제거 + 카운트 감소)
  async leaveDrawer(drawerId, uid) {
    const user = await UserDAO.findByUid(pool, uid);
    if (!user) {
      const error = new Error('사용자를 찾을 수 없습니다');
      error.status = 401;
      throw error;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const member = await DrawerDAO.getMember(client, drawerId, user.id);
      if (!member || member.deleted_at) {
        const error = new Error('멤버가 아닙니다');
        error.status = 404;
        throw error;
      }

      if (member.role === 0) {
        const error = new Error('서랍의 마스터는 탈퇴할 수 없습니다. 먼저 마스터 권한을 이전해주세요');
        error.status = 403;
        throw error;
      }

      await DrawerDAO.removeMember(client, drawerId, user.id);
      await DrawerDAO.decrementMemberCount(client, drawerId);

      await client.query('COMMIT');
      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ 서랍 탈퇴 실패:', error.message);
      throw error;
    } finally {
      client.release();
    }
  }

  async updateDrawerInfo(drawerId, updateData, uid) {
    const user = await UserDAO.findByUid(pool, uid);
    if (!user) {
      const error = new Error('사용자를 찾을 수 없습니다');
      error.status = 401;
      throw error;
    }

    const member = await DrawerDAO.getMember(pool, drawerId, user.id);
    if (!member || member.role > 1) {
      const error = new Error('권한이 없습니다');
      error.status = 403;
      throw error;
    }

    const updatedDrawer = await DrawerDAO.updateInfo(pool, drawerId, updateData);
    return {
      id: updatedDrawer.id,
      name: updatedDrawer.name,
      description: updatedDrawer.description,
      imageUrl: updatedDrawer.image_url,
      thumbnailUrl: updatedDrawer.thumbnail_url,
    };
  }

  async updateDrawerSettings(drawerId, updateData, uid) {
    const user = await UserDAO.findByUid(pool, uid);
    if (!user) {
      const error = new Error('사용자를 찾을 수 없습니다');
      error.status = 401;
      throw error;
    }

    const member = await DrawerDAO.getMember(pool, drawerId, user.id);
    if (!member || member.role !== 0) {
      const error = new Error('권한이 없습니다');
      error.status = 403;
      throw error;
    }

    const updatedSettings = await DrawerDAO.updateSettings(pool, drawerId, updateData);
    return {
      isPublic: updatedSettings.is_public,
      isSearchable: updatedSettings.is_searchable,
      requireApproval: updatedSettings.require_approval,
    };
  }

  async getJoinRequests(drawerId, uid) {
    const user = await UserDAO.findByUid(pool, uid);
    if (!user) {
      const error = new Error('사용자를 찾을 수 없습니다');
      error.status = 401;
      throw error;
    }

    const member = await DrawerDAO.getMember(pool, drawerId, user.id);
    if (!member || member.role !== 0) {
      const error = new Error('권한이 없습니다');
      error.status = 403;
      throw error;
    }

    const requests = await DrawerDAO.getJoinRequests(pool, drawerId, 0);
    return requests.map((r) => ({
      requestId: r.id,
      userId: r.user_id,
      displayName: r.display_name,
      userCode: r.user_code,
      email: r.email,
      imageUrl: r.image_url,
      createdAt: r.created_at,
    }));
  }

  // 승인: 트랜잭션 필요 (상태 변경 + 멤버 추가 + 카운트 증가)
  async approveJoinRequest(drawerId, requestId, uid) {
    const user = await UserDAO.findByUid(pool, uid);
    if (!user) {
      const error = new Error('사용자를 찾을 수 없습니다');
      error.status = 401;
      throw error;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const member = await DrawerDAO.getMember(client, drawerId, user.id);
      if (!member || member.role !== 0) {
        throw new Error('권한이 없습니다');
      }

      // 요청 정보 가져오기
      const request = await DrawerDAO.getJoinRequestById(client, requestId);
      if (!request) throw new Error('요청을 찾을 수 없습니다');

      // 1. 상태 업데이트 (승인: 1)
      await DrawerDAO.updateJoinRequestStatus(client, requestId, 1);
      // 2. 멤버 추가
      await DrawerDAO.addMember(client, drawerId, request.user_id, 3);
      // 3. 카운트 증가
      await DrawerDAO.incrementMemberCount(client, drawerId);

      await client.query('COMMIT');
      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ 가입 요청 승인 실패:', error.message);
      if (error.message === '권한이 없습니다') {
          const e = new Error(error.message);
          e.status = 403;
          throw e;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async rejectJoinRequest(drawerId, requestId, uid) {
    const user = await UserDAO.findByUid(pool, uid);
    if (!user) {
      const error = new Error('사용자를 찾을 수 없습니다');
      error.status = 401;
      throw error;
    }

    // 거절은 상태 업데이트 하나뿐이지만, 일관성을 위해 client 써도 됨.
    // 여기선 단순 업데이트라 pool 사용
    const member = await DrawerDAO.getMember(pool, drawerId, user.id);
    if (!member || member.role !== 0) {
      const error = new Error('권한이 없습니다');
      error.status = 403;
      throw error;
    }

    await DrawerDAO.updateJoinRequestStatus(pool, requestId, 2); // 거절: 2
    return { success: true };
  }

  // 마스터 위임: 트랜잭션 필요 (새 마스터 role=0, 구 마스터 role=1)
  async transferDrawerMaster(drawerId, newMasterId, uid) {
    const user = await UserDAO.findByUid(pool, uid);
    if (!user) {
      const error = new Error('사용자를 찾을 수 없습니다');
      error.status = 401;
      throw error;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const currentMaster = await DrawerDAO.getMember(client, drawerId, user.id);
      if (!currentMaster || currentMaster.role !== 0) {
         throw new Error('권한이 없습니다');
      }

      const newMasterMember = await DrawerDAO.getMember(client, drawerId, newMasterId);
      if (!newMasterMember || newMasterMember.deleted_at) {
        const error = new Error('새 마스터는 멤버여야 합니다');
        error.status = 404;
        throw error;
      }

      await DrawerDAO.updateMemberRole(client, drawerId, newMasterId, 0);
      await DrawerDAO.updateMemberRole(client, drawerId, user.id, 1);

      await client.query('COMMIT');
      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ 마스터 권한 이전 실패:', error.message);
      if (error.message === '권한이 없습니다') {
          const e = new Error(error.message);
          e.status = 403;
          throw e;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteDrawer(drawerId, uid) {
    const user = await UserDAO.findByUid(pool, uid);
    if (!user) {
      const error = new Error('사용자를 찾을 수 없습니다');
      error.status = 401;
      throw error;
    }

    const member = await DrawerDAO.getMember(pool, drawerId, user.id);
    if (!member || member.role !== 0) {
      const error = new Error('권한이 없습니다');
      error.status = 403;
      throw error;
    }

    await DrawerDAO.softDelete(pool, drawerId);
    return { success: true };
  }

  generateInvitationToken() {
    return crypto.randomBytes(32).toString('hex');
  }
}

module.exports = {
  DrawerService: new DrawerService(),
};