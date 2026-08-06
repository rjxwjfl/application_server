const { BinderDAO, SectionDAO, CalendarDAO } = require('../daos');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const crypto = require('crypto');
const pool = require('../../config/db');
const withTransaction = require('../core/withTransaction');
const { BadRequestError, NotFoundError, ForbiddenError, ConflictError, NotImplementedError } = require('../core/errors');
const { requireBinderMember } = require('../core/authz');
const { TargetType, ActionType } = require('../utils/typeDefinitions');

// PATCH /binders/:binderId/join-requests/:requestId 의 action → binder_join_requests.status 매핑
// (api.md:500-521)
const ACTION_TO_STATUS = { approve: 'APPROVED', reject: 'REJECTED', block: 'BLOCKED' };

class BinderService {

  async searchBinders(keyword, limit = 20, offset = 0) {
    if (!keyword || keyword.trim().length < 2) {
      throw new BadRequestError('검색 키워드는 최소 2자 이상이어야 합니다');
    }
    return await BinderDAO.searchByName(pool, keyword, limit, offset);
  }

  async createBinder(data, userId, device_uuid) {
    const { name } = data;
    if (!name || name.trim().length === 0) {
      throw new BadRequestError('Binder 이름이 필요합니다');
    }

    const result = await withTransaction(async (client) => {
      const binder = await BinderDAO.create(client, data);
      const settings = await BinderDAO.createSettings(client, binder.id);
      // 소유자(master)는 항상 인증된 요청자다 — 요청 본문의 user_id는 신원으로 신뢰하지 않는다.
      const member = await BinderDAO.addMember(client, binder.id, userId, 0);

      const calendar = await CalendarDAO.create(client, {
        id: generateUUID(),
        binder_id: binder.id,
        title: '기본 달력',
        color: Math.floor(Math.random() * 15),
      });

      const section = await SectionDAO.create(client, {
        id: generateUUID(),
        binder_id: binder.id,
        title: '기본',
      });

      return {
        binder,
        settings,
        calendar,
        section,
        members: [member],
        preferences: member,
      };
    });

    eventBus.emit('member:joined', { user_id: userId, binder_id: result.binder.id, device_uuid });

    return result;
  }

  async getMyBinders(userId) {
    return await BinderDAO.getMyBinders(pool, userId);
  }

  async issueBinderInvitation(binderId, userId) {
    const invitation = await withTransaction(async (client) => {
      const member = await BinderDAO.getMember(client, binderId, userId);
      if (!member || member.role !== 0) throw new ForbiddenError('초대 권한이 없습니다');

      const invitationId = generateUUID();
      const token = this.generateInvitationToken();
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      return await BinderDAO.createInvitation(client, invitationId, binderId, userId, token, expiresAt);
    });

    eventBus.emit('sync', {
      binder_id: binderId,
      sender_id: userId,
      action: ActionType.CREATE, target_type: TargetType.BINDER_INVITATION, target_id: invitation.id,
    });

    return invitation;
  }

  async getInvitationPreview(invitationCode) {
    const invitation = await BinderDAO.findInvitationByCode(pool, invitationCode);
    if (!invitation) return null;
    if (invitation.expires_at && new Date() > new Date(invitation.expires_at)) return null;
    return invitation;
  }

  async joinBinderByInvitation(invitationCode, userId, device_uuid) {
    const { binder_id } = await withTransaction(async (client) => {
      const invitation = await BinderDAO.findInvitationByCode(client, invitationCode);
      if (!invitation) throw new NotFoundError('유효하지 않거나 만료된 초대입니다');
      if (invitation.expires_at && new Date() > new Date(invitation.expires_at)) {
        throw new NotFoundError('유효하지 않거나 만료된 초대입니다');
      }

      const existingMember = await BinderDAO.getMember(client, invitation.binder_id, userId);
      if (existingMember && !existingMember.deleted_at) {
        throw new ConflictError('이미 이 바인더의 멤버입니다');
      }

      await BinderDAO.addMember(client, invitation.binder_id, userId, 3);
      await BinderDAO.incrementMemberCount(client, invitation.binder_id);
      await BinderDAO.incrementInvitationUsage(client, invitationCode);

      return { binder_id: invitation.binder_id };
    });

    eventBus.emit('member:joined', { user_id: userId, binder_id, device_uuid });
  }

  // require_approval=true 인 바인더는 즉시 정식 멤버(role=3)를 주지 않는다 — binder_join_requests
  // 에 PENDING 행만 만들고, 관리자의 decideJoinRequest(approve)가 승격시킬 때까지 binder_members
  // 에는 아무것도 넣지 않는다(RLY-20260806-024 — schema.md:234-256, api.md:446-461).
  //
  // (RLY-20260806-018 당시엔 role=-1 sentinel을 binder_members에 심어 대기를 표시했으나,
  // 스펙은 별도 테이블을 요구해 이 sentinel을 완전히 제거했다 — 대기자는 이제 binder_members에
  // 전혀 나타나지 않으므로 getBinderMembers·search·getBinder 등 기존 멤버십 게이트를 고칠 필요가
  // 없다. role >= 0 필터는 남겨두되(CHECK 제약 이전 시절의 방어선, 회귀 커버리지 대상) 여기서는
  // 더 이상 그 필터에 의존하지 않는다.)
  async requestBinderJoin(binderId, userId, device_uuid) {
    let joinedImmediately = false;
    let joinRequest = null;

    await withTransaction(async (client) => {
      const settings = await BinderDAO.getSettings(client, binderId);
      if (!settings) throw new NotFoundError('바인더를 찾을 수 없습니다');
      if (!settings.is_public && !settings.require_approval) throw new ForbiddenError('비공개 바인더입니다');

      if (settings.require_approval) {
        // idx_bjr_blocked — 차단 이력이 있으면 영구 재신청 불가(api.md:466).
        const blocked = await BinderDAO.hasActiveBlock(client, binderId, userId);
        if (blocked) throw new ForbiddenError('차단된 사용자는 재신청할 수 없습니다', 'BLOCKED');
      }

      const existingMember = await BinderDAO.getMember(client, binderId, userId);
      if (existingMember && !existingMember.deleted_at) {
        throw new BadRequestError('이미 이 바인더의 멤버입니다', 'ALREADY_MEMBER');
      }

      if (settings.require_approval) {
        // uq_bjr_pending 위반 시 createJoinRequest가 ConflictError('ALREADY_REQUESTED')로 번역한다.
        joinRequest = await BinderDAO.createJoinRequest(client, generateUUID(), binderId, userId);
      } else {
        await BinderDAO.addMember(client, binderId, userId, 3);
        await BinderDAO.incrementMemberCount(client, binderId);
        joinedImmediately = true;
      }
    });

    // pending 행은 아직 멤버가 아니므로 member:joined를 emit하지 않는다 — FCM 바인더 토픽 구독
    // (subscribeUserToAllBinders)·활동 피드 등 "정식 멤버"를 전제로 하는 부수효과를 막기 위함이다.
    if (joinedImmediately) {
      eventBus.emit('member:joined', { user_id: userId, binder_id: binderId, device_uuid });
    }

    return joinRequest;
  }

  async getBinderMembers(binderId, userId) {
    await requireBinderMember(pool, binderId, userId);
    return await BinderDAO.getMembers(pool, binderId);
  }

  async updateBinderMemberRole(binderId, targetUserId, role, requesterId) {
    await withTransaction(async (client) => {
      const validRoles = [0, 1, 2, 3];
      if (!validRoles.includes(role)) throw new BadRequestError('유효하지 않은 역할입니다');

      const members = await BinderDAO.getMembersForUpdate(client, binderId, [requesterId, targetUserId]);
      const requester = members.find((member) => member.user_id === requesterId);
      const target = members.find((member) => member.user_id === targetUserId);
      if (!requester || requester.deleted_at || !target || target.deleted_at
        || requester.role >= target.role || requester.role >= role) {
        throw new ForbiddenError('동급 또는 상위 역할의 멤버를 변경할 수 없습니다');
      }

      await BinderDAO.updateMemberRole(client, binderId, targetUserId, role);
    });

    eventBus.emit('sync', {
      binder_id: binderId,
      sender_id: requesterId,
      action: ActionType.ROLE_CHANGE, target_type: TargetType.BINDER_MEMBER, target_id: targetUserId,
    });
  }

  async kickBinderMember(binderId, targetUserId, requesterId, device_uuid) {
    await withTransaction(async (client) => {
      const members = await BinderDAO.getMembersForUpdate(client, binderId, [requesterId, targetUserId]);
      const requester = members.find((member) => member.user_id === requesterId);
      const target = members.find((member) => member.user_id === targetUserId);
      if (!requester || requester.deleted_at || !target || target.deleted_at || requester.role >= target.role) {
        throw new ForbiddenError('동급 또는 상위 역할의 멤버를 강퇴할 수 없습니다');
      }

      await BinderDAO.removeMember(client, binderId, targetUserId);
      await BinderDAO.decrementMemberCount(client, binderId);
    });

    eventBus.emit('member:left', { user_id: targetUserId, binder_id: binderId, actor_id: requesterId, action: ActionType.KICK, device_uuid });
  }

  async leaveBinder(binderId, userId, device_uuid) {
    await withTransaction(async (client) => {
      const member = await BinderDAO.getMember(client, binderId, userId);
      if (!member || member.deleted_at) throw new NotFoundError('멤버가 아닙니다');
      if (member.role === 0) throw new ForbiddenError('바인더의 마스터는 탈퇴할 수 없습니다. 먼저 마스터 권한을 이전해주세요');

      await BinderDAO.removeMember(client, binderId, userId);
      await BinderDAO.decrementMemberCount(client, binderId);
    });

    eventBus.emit('member:left', { user_id: userId, binder_id: binderId, device_uuid });
  }

  async updateBinder(binderId, updateData, userId) {
    const result = await withTransaction(async (client) => {
      const member = await BinderDAO.getMember(client, binderId, userId);
      if (!member || member.role !== 0) throw new ForbiddenError('권한이 없습니다');

      const binder = await BinderDAO.update(client, binderId, updateData);
      const settings = await BinderDAO.updateSettings(client, binderId, updateData);
      return { ...binder, ...settings };
    });

    eventBus.emit('sync', {
      binder_id: binderId,
      sender_id: userId,
      action: ActionType.UPDATE, target_type: TargetType.BINDER, target_id: binderId,
    });

    return result;
  }

  async transferBinderMaster(binderId, newMasterId, userId) {
    await withTransaction(async (client) => {
      const members = await BinderDAO.getMembersForUpdate(client, binderId, [userId, newMasterId]);
      const currentMaster = members.find((member) => member.user_id === userId);
      if (!currentMaster || currentMaster.role !== 0) throw new ForbiddenError('권한이 없습니다');

      const newMasterMember = members.find((member) => member.user_id === newMasterId);
      if (!newMasterMember || newMasterMember.deleted_at) throw new NotFoundError('새 마스터는 멤버여야 합니다');
      if (newMasterId === userId || currentMaster.role >= newMasterMember.role) {
        throw new ForbiddenError('마스터 권한은 하위 역할의 다른 멤버에게만 이전할 수 있습니다');
      }

      await BinderDAO.updateMemberRole(client, binderId, newMasterId, 0);
      await BinderDAO.updateMemberRole(client, binderId, userId, 1);
    });

    eventBus.emit('sync', {
      binder_id: binderId,
      sender_id: userId,
      action: ActionType.ROLE_CHANGE, target_type: TargetType.BINDER_MEMBER, target_id: newMasterId,
    });
  }

  async deleteBinder(binderId, userId) {
    await withTransaction(async (client) => {
      const member = await BinderDAO.getMember(client, binderId, userId);
      if (!member || member.role !== 0) throw new ForbiddenError('권한이 없습니다');

      // H15(SC-binder-manage.md:181-194) — binder_members·하위 캘린더(CalendarDAO.cascadeSoftDelete
      // 재사용)·sections까지 전파. RLY-20260806-025 이전에는 binders 한 줄만 지웠다.
      await BinderDAO.cascadeSoftDelete(client, binderId);
    });

    eventBus.emit('sync', {
      binder_id: binderId,
      sender_id: userId,
      action: ActionType.DELETE, target_type: TargetType.BINDER, target_id: binderId,
    });
  }

  generateInvitationToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  async search(binderId, { q, type, limit = 20 }, userId) {
    const member = await BinderDAO.getMember(pool, binderId, userId);
    if (!member || member.deleted_at) throw new ForbiddenError('바인더 멤버만 검색할 수 있습니다');
    if (!q || q.length < 2) throw new BadRequestError('2자 이상 입력해주세요');

    const lim = Math.min(parseInt(limit, 10) || 20, 50);
    const types = type ? type.split(',').map((t) => t.trim()) : ['events', 'tasks', 'posts', 'messages'];
    const pattern = `%${q}%`;
    const result = {};

    if (types.includes('events')) {
      // events·event_instances에는 binder_id·title 컬럼이 없다(schema.sql) — events는
      // calendar_id로만 binder에 연결되고(calendars.binder_id를 거쳐야 함), 제목 컬럼명은
      // summary·시각 컬럼명은 start_date/end_date다.
      const rows = await pool.query(
        `SELECT ei.id, ei.event_id, ei.summary, ei.start_date, ei.end_date, ei.is_all_day
         FROM event_instances ei
         JOIN events e ON e.id = ei.event_id
         JOIN calendars c ON c.id = e.calendar_id
         WHERE c.binder_id = $1 AND ei.deleted_at IS NULL AND ei.summary ILIKE $2
         ORDER BY ei.start_date ASC LIMIT $3`,
        [binderId, pattern, lim]
      );
      result.events = rows.rows;
    }

    if (types.includes('tasks')) {
      // tasks·task_instances도 동일 사유(binder_id 없음·title이 아니라 summary) — calendars 경유.
      const rows = await pool.query(
        `SELECT ti.id, ti.task_id, ti.summary, ti.due_date, ti.priority
         FROM task_instances ti
         JOIN tasks t ON t.id = ti.task_id
         JOIN calendars c ON c.id = t.calendar_id
         WHERE c.binder_id = $1 AND ti.deleted_at IS NULL AND ti.summary ILIKE $2
         ORDER BY ti.due_date ASC NULLS LAST LIMIT $3`,
        [binderId, pattern, lim]
      );
      result.tasks = rows.rows;
    }

    if (types.includes('posts')) {
      // posts에는 content 컬럼이 없다 — 본문 컬럼명은 body_markdown(schema.sql).
      const rows = await pool.query(
        `SELECT p.id, p.body_markdown, p.created_at, ui.display_name AS author_name
         FROM posts p
         LEFT JOIN user_infos ui ON p.author_id = ui.user_id
         WHERE p.binder_id = $1 AND p.deleted_at IS NULL AND p.body_markdown ILIKE $2
         ORDER BY p.created_at DESC LIMIT $3`,
        [binderId, pattern, lim]
      );
      result.posts = rows.rows;
    }

    if (types.includes('messages')) {
      const rows = await pool.query(
        `SELECT m.id, m.section_id, m.content, m.created_at
         FROM section_messages m JOIN sections s ON s.id = m.section_id
         WHERE s.binder_id = $1 AND m.deleted_at IS NULL AND m.content ILIKE $2
           AND (s.access_scope = 0 OR EXISTS (
             SELECT 1 FROM section_members sm WHERE sm.section_id = s.id
               AND sm.user_id = $3 AND sm.deleted_at IS NULL))
         ORDER BY m.created_at DESC LIMIT $4`,
        [binderId, pattern, userId, lim]
      );
      result.messages = rows.rows;
    }

    return result;
  }

  async getBinder(binderId, userId) {
    const binder = await BinderDAO.findById(pool, binderId);
    if (!binder) throw new NotFoundError('바인더를 찾을 수 없습니다');

    const member = await BinderDAO.getMember(pool, binderId, userId);
    if (member && !member.deleted_at) return binder;

    // 비멤버는 공개 바인더에 한해 preview 필드만 받는다 — searchByName(searchBinders)과 동일 필드셋,
    // deleted_at 등 내부 필드는 제외한다.
    const settings = await BinderDAO.getSettings(pool, binderId);
    if (!settings || !settings.is_public) {
      throw new ForbiddenError('바인더 멤버만 조회할 수 있습니다');
    }
    const { id, name, description, image_url, thumbnail_url, member_count, last_activity_at, created_at, updated_at } = binder;
    return { id, name, description, image_url, thumbnail_url, member_count, last_activity_at, created_at, updated_at };
  }

  // 관리자(host/manager) 전용 목록 조회. api.md:474-496 — status/page/limit 필터, {requests, total, page}.
  async getJoinRequests(binderId, userId, { status, page = 1, limit = 20 } = {}) {
    const member = await BinderDAO.getMember(pool, binderId, userId);
    if (!member || member.deleted_at || member.role > 1) throw new ForbiddenError('권한이 없습니다');

    const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const pg = Math.max(parseInt(page, 10) || 1, 1);
    const { rows, total } = await BinderDAO.getJoinRequests(pool, binderId, status, lim, (pg - 1) * lim);

    return {
      requests: rows.map((r) => ({
        id: r.id,
        requester: { id: r.requester_id, display_name: r.display_name },
        status: r.status,
        created_at: r.created_at,
        expires_at: r.expires_at,
        decided_by: r.decided_by,
        decided_at: r.decided_at,
      })),
      total,
      page: pg,
    };
  }

  // 승인·거절·차단 공용. api.md:500-521 — action: approve|reject|block.
  // approve만 동일 트랜잭션에서 binder_members INSERT(role=3). block은 idx_bjr_blocked로
  // 영구 재신청 차단에 쓰인다(BinderDAO.hasActiveBlock).
  async decideJoinRequest(binderId, requestId, action, deciderId) {
    const newStatus = ACTION_TO_STATUS[action];
    if (!newStatus) throw new BadRequestError('유효하지 않은 action입니다');

    const decided = await withTransaction(async (client) => {
      const requester = await BinderDAO.getMember(client, binderId, deciderId);
      if (!requester || requester.deleted_at || requester.role > 1) throw new ForbiddenError('권한이 없습니다');

      const joinRequest = await BinderDAO.getJoinRequestForUpdate(client, binderId, requestId);
      if (!joinRequest) throw new NotFoundError('가입 신청을 찾을 수 없습니다');
      if (joinRequest.status !== 'PENDING') throw new ConflictError('이미 처리된 신청입니다', 'ALREADY_DECIDED');

      const result = await BinderDAO.decideJoinRequest(client, requestId, newStatus, deciderId);

      if (action === 'approve') {
        await BinderDAO.addMember(client, binderId, joinRequest.requester_id, 3);
        await BinderDAO.incrementMemberCount(client, binderId);
      }

      return result;
    });

    if (action === 'approve') {
      eventBus.emit('member:joined', { user_id: decided.requester_id, binder_id: binderId });
    }

    return decided;
  }

  async updateNickname(binderId, userId, nickname) {
    await BinderDAO.updateNickname(pool, binderId, userId, nickname ?? null);
  }

  async updatePreferences(binderId, userId, data) {
    const member = await BinderDAO.getMember(pool, binderId, userId);
    if (!member || member.deleted_at) throw new ForbiddenError('바인더 멤버가 아닙니다');
    await BinderDAO.updateMemberPreferences(pool, binderId, userId, data);
  }

  // Binder Boost는 출시 후 오픈으로 결정됐고, binder_boosts DAO 계층 자체가 없다
  // (getBinderBoost·transferBinderBoost·cancelBinderBoost 전부 billingDAO.js에 없는
  // 메서드 — grep 0건). 여기서 임의로 구현하지 않고 501로 명시 거부한다(verifyBoost 선례와
  // 동일 형태). 재구현은 별도 Task로 배정한다.
  //
  // ⚠️ 인가는 501 이전에 통과시킨다 — 비멤버가 호출 가능하면 진입점 존재 자체가 새어 나간다.

  async getBoost(binderId, userId) {
    await requireBinderMember(pool, binderId, userId);
    throw new NotImplementedError(
      'Binder Boost 조회 기능은 아직 구현되지 않았습니다',
      'BINDER_BOOST_GET_NOT_IMPLEMENTED'
    );
  }

  async checkBoost(binderId, userId) {
    await requireBinderMember(pool, binderId, userId);
    throw new NotImplementedError(
      'Binder Boost 조회 기능은 아직 구현되지 않았습니다',
      'BINDER_BOOST_CHECK_NOT_IMPLEMENTED'
    );
  }

  // verifyBoost는 RLY-20260806-010에서 죽은 호출(TypeError)은 이미 501로 막았으나 인가는
  // 그때도 붙지 않았다 — 형제 넷(getBoost 등)과 순서를 맞춘다(인가 → 501). 비멤버가 501
  // 자체는 받아도 진입점 존재를 확인할 수 없어야 한다.
  async verifyBoost(binderId, userId, data) {
    await requireBinderMember(pool, binderId, userId);
    throw new NotImplementedError(
      'Binder Boost 구매 검증 기능은 아직 구현되지 않았습니다',
      'BINDER_BOOST_VERIFY_NOT_IMPLEMENTED'
    );
  }

  async transferBoost(binderId, userId, data) {
    // 기존 role 게이트(manager 이상)는 유지 — 501로 응답을 바꾸는 것이지 인가 기준을 바꾸는 게 아니다.
    await requireBinderMember(pool, binderId, userId, { minRole: 1 });
    throw new NotImplementedError(
      'Binder Boost 이전 기능은 아직 구현되지 않았습니다',
      'BINDER_BOOST_TRANSFER_NOT_IMPLEMENTED'
    );
  }

  async cancelBoost(binderId, userId) {
    await requireBinderMember(pool, binderId, userId, { minRole: 1 });
    throw new NotImplementedError(
      'Binder Boost 취소 기능은 아직 구현되지 않았습니다',
      'BINDER_BOOST_CANCEL_NOT_IMPLEMENTED'
    );
  }

  async listAttachments(binderId, query, userId) {
    const { AttachmentDAO } = require('../daos/attachmentDAO');
    const member = await BinderDAO.getMember(pool, binderId, userId);
    if (!member || member.deleted_at) throw new ForbiddenError('바인더 멤버만 파일을 조회할 수 있습니다');
    return await AttachmentDAO.findByBinder(pool, binderId, userId, query);
  }

  async deleteAttachment(binderId, attachmentId, userId) {
    const { AttachmentDAO } = require('../daos/attachmentDAO');
    const member = await BinderDAO.getMember(pool, binderId, userId);
    if (!member || member.deleted_at) throw new ForbiddenError('바인더 멤버가 아닙니다');
    const attachment = await AttachmentDAO.findById(pool, attachmentId);
    if (!attachment || attachment.binder_id !== binderId) throw new NotFoundError('첨부 파일을 찾을 수 없습니다');
    if (attachment.context_type === 'SECTION_MESSAGE') {
      const sectionId = await SectionDAO.findSectionIdByMessage(pool, attachment.context_id);
      if (!sectionId || !(await SectionDAO.hasAccess(pool, sectionId, userId))) {
        throw new ForbiddenError('섹션 첨부 접근 권한이 없습니다', 'SECTION_ACCESS_DENIED');
      }
    }
    // F-S9 — soft delete와 binder_storage_usage 차감을 같은 트랜잭션에서 원자 갱신한다.
    // (mediaService.deleteAttachment와 별개 경로 — master·manager가 타인 업로드를 지우는 경로도
    // 같은 회계 규칙을 따라야 한다.)
    await withTransaction(async (client) => {
      const deleted = await AttachmentDAO.softDelete(client, attachmentId);
      if (!deleted) return;
      await AttachmentDAO.applyStorageDelta(client, {
        binderId: deleted.binder_id,
        storageKey: deleted.storage_key,
        fileSize: deleted.file_size,
        attachmentId: deleted.id,
        sign: -1,
      });
    });
  }

  async listFiles(binderId, query, userId) {
    return this.listAttachments(binderId, query, userId);
  }
}

module.exports = {
  BinderService: new BinderService(),
};
