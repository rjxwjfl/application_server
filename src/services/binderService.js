const { DrawerDAO, SeriesDAO, CalendarDAO } = require('../daos');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const crypto = require('crypto');
const pool = require('../../config/db');
const withTransaction = require('../core/withTransaction');
const { BadRequestError, NotFoundError, ForbiddenError, ConflictError } = require('../core/errors');
const { TargetType, ActionType } = require('../utils/typeDefinitions');

class DrawerService {

  async searchDrawers(keyword, limit = 20, offset = 0) {
    if (!keyword || keyword.trim().length < 2) {
      throw new BadRequestError('검색 키워드는 최소 2자 이상이어야 합니다');
    }
    return await DrawerDAO.searchByName(pool, keyword, limit, offset);
  }

  async createDrawer(data, device_uuid) {
    const { user_id, name } = data;
    if (!name || name.trim().length === 0) {
      throw new BadRequestError('Drawer 이름이 필요합니다');
    }

    const result = await withTransaction(async (client) => {
      const drawer = await DrawerDAO.create(client, data);
      const settings = await DrawerDAO.createSettings(client, drawer.id);
      const member = await DrawerDAO.addMember(client, drawer.id, user_id, 0);

      const calendar = await CalendarDAO.create(client, {
        id: generateUUID(),
        drawer_id: drawer.id,
        title: '기본 달력',
        color: Math.floor(Math.random() * 15),
      });

      const series = await SeriesDAO.create(client, {
        id: generateUUID(),
        drawer_id: drawer.id,
        title: '기본',
      });

      return {
        drawer,
        settings,
        calendar,
        series,
        members: [member],
        preferences: member,
      };
    });

    eventBus.emit('member:joined', { user_id, drawer_id: result.drawer.id, device_uuid });

    return result;
  }

  async getMyDrawers(userId) {
    return await DrawerDAO.getMyDrawers(pool, userId);
  }

  async issueDrawerInvitation(drawerId, userId) {
    const invitation = await withTransaction(async (client) => {
      const member = await DrawerDAO.getMember(client, drawerId, userId);
      if (!member || member.role !== 0) throw new ForbiddenError('초대 권한이 없습니다');

      const invitationId = generateUUID();
      const token = this.generateInvitationToken();
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      return await DrawerDAO.createInvitation(client, invitationId, drawerId, userId, token, expiresAt);
    });

    eventBus.emit('sync', {
      drawer_id: drawerId,
      sender_id: userId,
      action: ActionType.CREATE, target_type: TargetType.DRAWER_INVITATION, target_id: invitation.id,
    });

    return invitation;
  }

  async getInvitationPreview(invitationCode) {
    const invitation = await DrawerDAO.findInvitationByCode(pool, invitationCode);
    if (!invitation) return null;
    if (invitation.expires_at && new Date() > new Date(invitation.expires_at)) return null;
    return invitation;
  }

  async joinDrawerByInvitation(invitationCode, userId, device_uuid) {
    const { drawer_id } = await withTransaction(async (client) => {
      const invitation = await DrawerDAO.findInvitationByCode(client, invitationCode);
      if (!invitation) throw new NotFoundError('유효하지 않거나 만료된 초대입니다');
      if (invitation.expires_at && new Date() > new Date(invitation.expires_at)) {
        throw new NotFoundError('유효하지 않거나 만료된 초대입니다');
      }

      const existingMember = await DrawerDAO.getMember(client, invitation.drawer_id, userId);
      if (existingMember && !existingMember.deleted_at) {
        throw new ConflictError('이미 이 서랍의 멤버입니다');
      }

      await DrawerDAO.addMember(client, invitation.drawer_id, userId, 3);
      await DrawerDAO.incrementMemberCount(client, invitation.drawer_id);
      await DrawerDAO.incrementInvitationUsage(client, invitationCode);

      return { drawer_id: invitation.drawer_id };
    });

    eventBus.emit('member:joined', { user_id: userId, drawer_id, device_uuid });
  }

  async requestDrawerJoin(drawerId, userId, device_uuid) {
    await withTransaction(async (client) => {
      const settings = await DrawerDAO.getSettings(client, drawerId);
      if (!settings) throw new NotFoundError('서랍을 찾을 수 없습니다');
      if (!settings.is_public && !settings.require_approval) throw new ForbiddenError('비공개 서랍입니다');

      const existingMember = await DrawerDAO.getMember(client, drawerId, userId);
      if (existingMember && !existingMember.deleted_at) {
        throw new ConflictError('이미 이 서랍의 멤버입니다');
      }

      await DrawerDAO.addMember(client, drawerId, userId, 3);
      await DrawerDAO.incrementMemberCount(client, drawerId);
    });

    eventBus.emit('member:joined', { user_id: userId, drawer_id: drawerId, device_uuid });
  }

  async getDrawerMembers(drawerId) {
    return await DrawerDAO.getMembers(pool, drawerId);
  }

  async updateDrawerMemberRole(drawerId, targetUserId, role, requesterId) {
    await withTransaction(async (client) => {
      const requester = await DrawerDAO.getMember(client, drawerId, requesterId);
      if (!requester || requester.role !== 0) throw new ForbiddenError('권한이 없습니다');

      const validRoles = [0, 1, 2, 3];
      if (!validRoles.includes(role)) throw new BadRequestError('유효하지 않은 역할입니다');

      await DrawerDAO.updateMemberRole(client, drawerId, targetUserId, role);
    });

    eventBus.emit('sync', {
      drawer_id: drawerId,
      sender_id: requesterId,
      action: ActionType.ROLE_CHANGE, target_type: TargetType.DRAWER_MEMBER, target_id: targetUserId,
    });
  }

  async kickDrawerMember(drawerId, targetUserId, requesterId, device_uuid) {
    await withTransaction(async (client) => {
      const requester = await DrawerDAO.getMember(client, drawerId, requesterId);
      if (!requester || requester.role !== 0) throw new ForbiddenError('권한이 없습니다');

      await DrawerDAO.removeMember(client, drawerId, targetUserId);
      await DrawerDAO.decrementMemberCount(client, drawerId);
    });

    eventBus.emit('member:left', { user_id: targetUserId, drawer_id: drawerId, actor_id: requesterId, action: ActionType.KICK, device_uuid });
  }

  async leaveDrawer(drawerId, userId, device_uuid) {
    await withTransaction(async (client) => {
      const member = await DrawerDAO.getMember(client, drawerId, userId);
      if (!member || member.deleted_at) throw new NotFoundError('멤버가 아닙니다');
      if (member.role === 0) throw new ForbiddenError('서랍의 마스터는 탈퇴할 수 없습니다. 먼저 마스터 권한을 이전해주세요');

      await DrawerDAO.removeMember(client, drawerId, userId);
      await DrawerDAO.decrementMemberCount(client, drawerId);
    });

    eventBus.emit('member:left', { user_id: userId, drawer_id: drawerId, device_uuid });
  }

  async updateDrawer(drawerId, updateData, userId) {
    const result = await withTransaction(async (client) => {
      const member = await DrawerDAO.getMember(client, drawerId, userId);
      if (!member || member.role !== 0) throw new ForbiddenError('권한이 없습니다');

      const drawer = await DrawerDAO.update(client, drawerId, updateData);
      const settings = await DrawerDAO.updateSettings(client, drawerId, updateData);
      return { ...drawer, ...settings };
    });

    eventBus.emit('sync', {
      drawer_id: drawerId,
      sender_id: userId,
      action: ActionType.UPDATE, target_type: TargetType.DRAWER, target_id: drawerId,
    });

    return result;
  }

  async transferDrawerMaster(drawerId, newMasterId, userId) {
    await withTransaction(async (client) => {
      const currentMaster = await DrawerDAO.getMember(client, drawerId, userId);
      if (!currentMaster || currentMaster.role !== 0) throw new ForbiddenError('권한이 없습니다');

      const newMasterMember = await DrawerDAO.getMember(client, drawerId, newMasterId);
      if (!newMasterMember || newMasterMember.deleted_at) throw new NotFoundError('새 마스터는 멤버여야 합니다');

      await DrawerDAO.updateMemberRole(client, drawerId, newMasterId, 0);
      await DrawerDAO.updateMemberRole(client, drawerId, userId, 1);
    });

    eventBus.emit('sync', {
      drawer_id: drawerId,
      sender_id: userId,
      action: ActionType.ROLE_CHANGE, target_type: TargetType.DRAWER_MEMBER, target_id: newMasterId,
    });
  }

  async deleteDrawer(drawerId, userId) {
    await withTransaction(async (client) => {
      const member = await DrawerDAO.getMember(client, drawerId, userId);
      if (!member || member.role !== 0) throw new ForbiddenError('권한이 없습니다');

      await DrawerDAO.softDelete(client, drawerId);
    });

    eventBus.emit('sync', {
      drawer_id: drawerId,
      sender_id: userId,
      action: ActionType.DELETE, target_type: TargetType.DRAWER, target_id: drawerId,
    });
  }

  generateInvitationToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  async search(drawerId, { q, type, limit = 20 }, userId) {
    const member = await DrawerDAO.getMember(pool, drawerId, userId);
    if (!member || member.deleted_at) throw new ForbiddenError('서랍 멤버만 검색할 수 있습니다');
    if (!q || q.length < 2) throw new BadRequestError('2자 이상 입력해주세요');

    const lim = Math.min(parseInt(limit, 10) || 20, 50);
    const types = type ? type.split(',').map((t) => t.trim()) : ['events', 'tasks', 'posts'];
    const pattern = `%${q}%`;
    const result = {};

    if (types.includes('events')) {
      const rows = await pool.query(
        `SELECT ei.id, ei.event_id, ei.title, ei.start_time, ei.end_time, ei.is_all_day
         FROM event_instances ei
         JOIN events e ON e.id = ei.event_id
         WHERE e.drawer_id = $1 AND ei.deleted_at IS NULL AND ei.title ILIKE $2
         ORDER BY ei.start_time ASC LIMIT $3`,
        [drawerId, pattern, lim]
      );
      result.events = rows.rows;
    }

    if (types.includes('tasks')) {
      const rows = await pool.query(
        `SELECT ti.id, ti.task_id, ti.title, ti.due_date, ti.priority
         FROM task_instances ti
         JOIN tasks t ON t.id = ti.task_id
         WHERE t.drawer_id = $1 AND ti.deleted_at IS NULL AND ti.title ILIKE $2
         ORDER BY ti.due_date ASC NULLS LAST LIMIT $3`,
        [drawerId, pattern, lim]
      );
      result.tasks = rows.rows;
    }

    if (types.includes('posts')) {
      const rows = await pool.query(
        `SELECT p.id, p.content, p.created_at, ui.display_name AS author_name
         FROM posts p
         LEFT JOIN user_infos ui ON p.author_id = ui.user_id
         WHERE p.drawer_id = $1 AND p.deleted_at IS NULL AND p.content ILIKE $2
         ORDER BY p.created_at DESC LIMIT $3`,
        [drawerId, pattern, lim]
      );
      result.posts = rows.rows;
    }

    return result;
  }

  async getDrawer(drawerId) {
    const drawer = await DrawerDAO.findById(pool, drawerId);
    if (!drawer) throw new NotFoundError('서랍을 찾을 수 없습니다');
    return drawer;
  }

  async getJoinRequests(drawerId, userId) {
    const member = await DrawerDAO.getMember(pool, drawerId, userId);
    if (!member || member.deleted_at || member.role > 1) throw new ForbiddenError('권한이 없습니다');
    return await DrawerDAO.getPendingMembers(pool, drawerId);
  }

  async approveJoinRequest(drawerId, targetUserId, requesterId) {
    await withTransaction(async (client) => {
      const requester = await DrawerDAO.getMember(client, drawerId, requesterId);
      if (!requester || requester.deleted_at || requester.role > 1) throw new ForbiddenError('권한이 없습니다');
      await DrawerDAO.addMember(client, drawerId, targetUserId, 3);
      await DrawerDAO.incrementMemberCount(client, drawerId);
    });
    eventBus.emit('member:joined', { user_id: targetUserId, drawer_id: drawerId });
  }

  async rejectJoinRequest(drawerId, targetUserId, requesterId) {
    const requester = await DrawerDAO.getMember(pool, drawerId, requesterId);
    if (!requester || requester.deleted_at || requester.role > 1) throw new ForbiddenError('권한이 없습니다');
    await DrawerDAO.removePendingRequest(pool, drawerId, targetUserId);
  }

  async updateNickname(drawerId, userId, nickname) {
    await DrawerDAO.updateNickname(pool, drawerId, userId, nickname ?? null);
  }

  async updatePreferences(drawerId, userId, data) {
    const member = await DrawerDAO.getMember(pool, drawerId, userId);
    if (!member || member.deleted_at) throw new ForbiddenError('서랍 멤버가 아닙니다');
    await DrawerDAO.updateMemberPreferences(pool, drawerId, userId, data);
  }

  async getBoost(drawerId) {
    const { BillingDAO } = require('../daos/billingDAO');
    return await BillingDAO.getDrawerBoost(pool, drawerId);
  }

  async checkBoost(drawerId) {
    const { BillingDAO } = require('../daos/billingDAO');
    return await BillingDAO.getDrawerBoost(pool, drawerId);
  }

  async verifyBoost(drawerId, userId, data) {
    const { BillingDAO } = require('../daos/billingDAO');
    const { BillingService } = require('./billingService');
    return await BillingService.verifyDrawerBoost(drawerId, userId, data);
  }

  async transferBoost(drawerId, userId, data) {
    const { BillingDAO } = require('../daos/billingDAO');
    await withTransaction(async (client) => {
      const member = await DrawerDAO.getMember(client, drawerId, userId);
      if (!member || member.deleted_at || member.role > 1) throw new ForbiddenError('권한이 없습니다');
      await BillingDAO.transferDrawerBoost(client, drawerId, data.new_payer_id);
    });
    return await this.getBoost(drawerId);
  }

  async cancelBoost(drawerId, userId) {
    const { BillingDAO } = require('../daos/billingDAO');
    await withTransaction(async (client) => {
      const member = await DrawerDAO.getMember(client, drawerId, userId);
      if (!member || member.deleted_at || member.role > 1) throw new ForbiddenError('권한이 없습니다');
      await BillingDAO.cancelDrawerBoost(client, drawerId);
    });
  }

  async listAttachments(drawerId, query, userId) {
    const { AttachmentDAO } = require('../daos/attachmentDAO');
    const member = await DrawerDAO.getMember(pool, drawerId, userId);
    if (!member || member.deleted_at) throw new ForbiddenError('서랍 멤버만 파일을 조회할 수 있습니다');
    return await AttachmentDAO.findByDrawer(pool, drawerId, query);
  }

  async deleteAttachment(drawerId, attachmentId, userId) {
    const { AttachmentDAO } = require('../daos/attachmentDAO');
    const member = await DrawerDAO.getMember(pool, drawerId, userId);
    if (!member || member.deleted_at) throw new ForbiddenError('서랍 멤버가 아닙니다');
    await AttachmentDAO.softDelete(pool, attachmentId, userId);
  }

  async listFiles(drawerId, query, userId) {
    return this.listAttachments(drawerId, query, userId);
  }
}

module.exports = {
  DrawerService: new DrawerService(),
};
