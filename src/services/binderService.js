const { BinderDAO, SectionDAO, CalendarDAO } = require('../daos');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const crypto = require('crypto');
const pool = require('../../config/db');
const withTransaction = require('../core/withTransaction');
const { BadRequestError, NotFoundError, ForbiddenError, ConflictError } = require('../core/errors');
const { TargetType, ActionType } = require('../utils/typeDefinitions');

class BinderService {

  async searchBinders(keyword, limit = 20, offset = 0) {
    if (!keyword || keyword.trim().length < 2) {
      throw new BadRequestError('검색 키워드는 최소 2자 이상이어야 합니다');
    }
    return await BinderDAO.searchByName(pool, keyword, limit, offset);
  }

  async createBinder(data, device_uuid) {
    const { user_id, name } = data;
    if (!name || name.trim().length === 0) {
      throw new BadRequestError('Binder 이름이 필요합니다');
    }

    const result = await withTransaction(async (client) => {
      const binder = await BinderDAO.create(client, data);
      const settings = await BinderDAO.createSettings(client, binder.id);
      const member = await BinderDAO.addMember(client, binder.id, user_id, 0);

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

    eventBus.emit('member:joined', { user_id, binder_id: result.binder.id, device_uuid });

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

  async requestBinderJoin(binderId, userId, device_uuid) {
    await withTransaction(async (client) => {
      const settings = await BinderDAO.getSettings(client, binderId);
      if (!settings) throw new NotFoundError('바인더를 찾을 수 없습니다');
      if (!settings.is_public && !settings.require_approval) throw new ForbiddenError('비공개 바인더입니다');

      const existingMember = await BinderDAO.getMember(client, binderId, userId);
      if (existingMember && !existingMember.deleted_at) {
        throw new ConflictError('이미 이 바인더의 멤버입니다');
      }

      await BinderDAO.addMember(client, binderId, userId, 3);
      await BinderDAO.incrementMemberCount(client, binderId);
    });

    eventBus.emit('member:joined', { user_id: userId, binder_id: binderId, device_uuid });
  }

  async getBinderMembers(binderId) {
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
      const currentMaster = await BinderDAO.getMember(client, binderId, userId);
      if (!currentMaster || currentMaster.role !== 0) throw new ForbiddenError('권한이 없습니다');

      const newMasterMember = await BinderDAO.getMember(client, binderId, newMasterId);
      if (!newMasterMember || newMasterMember.deleted_at) throw new NotFoundError('새 마스터는 멤버여야 합니다');

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

      await BinderDAO.softDelete(client, binderId);
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
      const rows = await pool.query(
        `SELECT ei.id, ei.event_id, ei.title, ei.start_time, ei.end_time, ei.is_all_day
         FROM event_instances ei
         JOIN events e ON e.id = ei.event_id
         WHERE e.binder_id = $1 AND ei.deleted_at IS NULL AND ei.title ILIKE $2
         ORDER BY ei.start_time ASC LIMIT $3`,
        [binderId, pattern, lim]
      );
      result.events = rows.rows;
    }

    if (types.includes('tasks')) {
      const rows = await pool.query(
        `SELECT ti.id, ti.task_id, ti.title, ti.due_date, ti.priority
         FROM task_instances ti
         JOIN tasks t ON t.id = ti.task_id
         WHERE t.binder_id = $1 AND ti.deleted_at IS NULL AND ti.title ILIKE $2
         ORDER BY ti.due_date ASC NULLS LAST LIMIT $3`,
        [binderId, pattern, lim]
      );
      result.tasks = rows.rows;
    }

    if (types.includes('posts')) {
      const rows = await pool.query(
        `SELECT p.id, p.content, p.created_at, ui.display_name AS author_name
         FROM posts p
         LEFT JOIN user_infos ui ON p.author_id = ui.user_id
         WHERE p.binder_id = $1 AND p.deleted_at IS NULL AND p.content ILIKE $2
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
           AND (s.access_scope = 0 OR (s.access_scope = 1 AND s.group_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM group_members gm WHERE gm.group_id = s.group_id
               AND gm.user_id = $3 AND gm.deleted_at IS NULL)))
         ORDER BY m.created_at DESC LIMIT $4`,
        [binderId, pattern, userId, lim]
      );
      result.messages = rows.rows;
    }

    return result;
  }

  async getBinder(binderId) {
    const binder = await BinderDAO.findById(pool, binderId);
    if (!binder) throw new NotFoundError('바인더를 찾을 수 없습니다');
    return binder;
  }

  async getJoinRequests(binderId, userId) {
    const member = await BinderDAO.getMember(pool, binderId, userId);
    if (!member || member.deleted_at || member.role > 1) throw new ForbiddenError('권한이 없습니다');
    return await BinderDAO.getPendingMembers(pool, binderId);
  }

  async approveJoinRequest(binderId, targetUserId, requesterId) {
    await withTransaction(async (client) => {
      const requester = await BinderDAO.getMember(client, binderId, requesterId);
      if (!requester || requester.deleted_at || requester.role > 1) throw new ForbiddenError('권한이 없습니다');
      await BinderDAO.addMember(client, binderId, targetUserId, 3);
      await BinderDAO.incrementMemberCount(client, binderId);
    });
    eventBus.emit('member:joined', { user_id: targetUserId, binder_id: binderId });
  }

  async rejectJoinRequest(binderId, targetUserId, requesterId) {
    const requester = await BinderDAO.getMember(pool, binderId, requesterId);
    if (!requester || requester.deleted_at || requester.role > 1) throw new ForbiddenError('권한이 없습니다');
    await BinderDAO.removePendingRequest(pool, binderId, targetUserId);
  }

  async updateNickname(binderId, userId, nickname) {
    await BinderDAO.updateNickname(pool, binderId, userId, nickname ?? null);
  }

  async updatePreferences(binderId, userId, data) {
    const member = await BinderDAO.getMember(pool, binderId, userId);
    if (!member || member.deleted_at) throw new ForbiddenError('바인더 멤버가 아닙니다');
    await BinderDAO.updateMemberPreferences(pool, binderId, userId, data);
  }

  async getBoost(binderId) {
    const { BillingDAO } = require('../daos/billingDAO');
    return await BillingDAO.getBinderBoost(pool, binderId);
  }

  async checkBoost(binderId) {
    const { BillingDAO } = require('../daos/billingDAO');
    return await BillingDAO.getBinderBoost(pool, binderId);
  }

  async verifyBoost(binderId, userId, data) {
    const { BillingDAO } = require('../daos/billingDAO');
    const { BillingService } = require('./billingService');
    return await BillingService.verifyBinderBoost(binderId, userId, data);
  }

  async transferBoost(binderId, userId, data) {
    const { BillingDAO } = require('../daos/billingDAO');
    await withTransaction(async (client) => {
      const member = await BinderDAO.getMember(client, binderId, userId);
      if (!member || member.deleted_at || member.role > 1) throw new ForbiddenError('권한이 없습니다');
      await BillingDAO.transferBinderBoost(client, binderId, data.new_payer_id);
    });
    return await this.getBoost(binderId);
  }

  async cancelBoost(binderId, userId) {
    const { BillingDAO } = require('../daos/billingDAO');
    await withTransaction(async (client) => {
      const member = await BinderDAO.getMember(client, binderId, userId);
      if (!member || member.deleted_at || member.role > 1) throw new ForbiddenError('권한이 없습니다');
      await BillingDAO.cancelBinderBoost(client, binderId);
    });
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
    await AttachmentDAO.softDelete(pool, attachmentId, userId);
  }

  async listFiles(binderId, query, userId) {
    return this.listAttachments(binderId, query, userId);
  }
}

module.exports = {
  BinderService: new BinderService(),
};
