const { SectionDAO } = require('../daos/sectionDAO');
const { AttachmentDAO } = require('../daos/attachmentDAO');
const { BinderDAO } = require('../daos');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const pool = require('../../config/db');
const withTransaction = require('../core/withTransaction');
const { NotFoundError, BadRequestError, ForbiddenError } = require('../core/errors');
const { TargetType, ActionType } = require('../utils/typeDefinitions');

class SectionService {
  async getSectionByBinderId(binderId, userId) {
    const member = await BinderDAO.getMember(pool, binderId, userId);
    if (!member || member.deleted_at) throw new ForbiddenError('바인더 멤버만 섹션을 조회할 수 있습니다');
    return await SectionDAO.findByBinderId(pool, binderId, userId);
  }

  async createSection(data, context) {
    const section = await withTransaction(async (client) => {
      const actor = await BinderDAO.getMember(client, data.binder_id, context.sender_id);
      if (!actor || actor.deleted_at || actor.role > 1) throw new ForbiddenError('manager 이상 권한이 필요합니다');
      if (Object.prototype.hasOwnProperty.call(data, 'group_id')) throw new BadRequestError('group_id는 지원하지 않습니다');
      const scope = data.access_scope ?? 0;
      if (![0, 1].includes(scope)) throw new BadRequestError('access_scope는 0 또는 1이어야 합니다');
      const created = await SectionDAO.create(client, {
        id: data.id || generateUUID(),
        binder_id: data.binder_id,
        title: data.title,
        access_scope: scope,
      });
      if (scope === 1) await SectionDAO.addMember(client, created.id, context.sender_id, generateUUID());
      return created;
    });

    eventBus.emit('sync', {
      binder_id: data.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.CREATE, target_type: TargetType.SECTION, target_id: section.id,
    });

    return section;
  }

  async updateSection(sectionId, updateData, context) {
    const { section, result } = await withTransaction(async (client) => {
      const section = await SectionDAO.findById(client, sectionId, true);
      if (!section) throw new NotFoundError('섹션을 찾을 수 없습니다');
      const actor = await BinderDAO.getMember(client, section.binder_id, context.sender_id);
      if (!actor || actor.deleted_at || actor.role > 1) throw new ForbiddenError('manager 이상 권한이 필요합니다');
      if (Object.keys(updateData).some((key) => key !== 'title')) {
        throw new BadRequestError('수정 가능한 필드는 title뿐입니다');
      }
      const result = await SectionDAO.update(client, sectionId, updateData);
      return { section, result };
    });

    eventBus.emit('sync', {
      binder_id: section.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.UPDATE, target_type: TargetType.SECTION, target_id: sectionId,
    });

    return result;
  }

  async deleteSection(sectionId, context) {
    const { binder_id } = await withTransaction(async (client) => {
      const section = await SectionDAO.findById(client, sectionId);
      if (!section) throw new NotFoundError('섹션을 찾을 수 없습니다');
      if (section.is_default) throw new BadRequestError('기본 섹션은 삭제할 수 없습니다');
      const actor = await BinderDAO.getMember(client, section.binder_id, context.sender_id);
      if (!actor || actor.deleted_at || actor.role > 1) throw new ForbiddenError('manager 이상 권한이 필요합니다');

      await SectionDAO.softDelete(client, sectionId);
      return { binder_id: section.binder_id };
    });

    eventBus.emit('sync', {
      binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE, target_type: TargetType.SECTION, target_id: sectionId,
    });
  }

  async addMembers(sectionId, userIds, context) {
    if (!Array.isArray(userIds) || userIds.length === 0) throw new BadRequestError('user_ids 배열이 필요합니다');
    const uniqueUserIds = [...new Set(userIds)];
    const result = await withTransaction(async (client) => {
      const section = await SectionDAO.findById(client, sectionId, true);
      if (!section) throw new NotFoundError('섹션을 찾을 수 없습니다');
      const actor = await BinderDAO.getMember(client, section.binder_id, context.sender_id);
      if (!actor || actor.deleted_at || actor.role > 1) throw new ForbiddenError('manager 이상 권한이 필요합니다');
      if (section.access_scope !== 1) throw new BadRequestError('public 섹션에는 멤버를 추가할 수 없습니다');
      const added = [];
      for (const userId of uniqueUserIds) {
        const target = await BinderDAO.getMember(client, section.binder_id, userId);
        if (!target || target.deleted_at) throw new BadRequestError('모든 user_id는 활성 바인더 멤버여야 합니다');
        if (await SectionDAO.addMember(client, sectionId, userId, generateUUID())) added.push(userId);
      }
      return { binderId: section.binder_id, added_user_ids: added, member_count: await SectionDAO.countMembers(client, sectionId) };
    });
    eventBus.emit('sync', { binder_id: result.binderId, sender_id: context.sender_id, device_uuid: context.device_uuid,
      action: ActionType.UPDATE, target_type: TargetType.SECTION, target_id: sectionId });
    return { added_user_ids: result.added_user_ids, member_count: result.member_count };
  }

  async removeMember(sectionId, userId, context) {
    const result = await withTransaction(async (client) => {
      const section = await SectionDAO.findById(client, sectionId, true);
      if (!section) throw new NotFoundError('섹션을 찾을 수 없습니다');
      const actor = await BinderDAO.getMember(client, section.binder_id, context.sender_id);
      if (!actor || actor.deleted_at || actor.role > 1) throw new ForbiddenError('manager 이상 권한이 필요합니다');
      if (section.access_scope !== 1) throw new BadRequestError('public 섹션에는 멤버가 없습니다');
      await SectionDAO.removeMember(client, sectionId, userId);
      const memberCount = await SectionDAO.countMembers(client, sectionId);
      const sectionDeleted = memberCount === 0 ? await SectionDAO.softDelete(client, sectionId) : false;
      return { binderId: section.binder_id, removed_user_id: userId, member_count: memberCount, section_deleted: sectionDeleted };
    });
    eventBus.emit('sync', { binder_id: result.binderId, sender_id: context.sender_id, device_uuid: context.device_uuid,
      action: ActionType.UPDATE, target_type: TargetType.SECTION, target_id: sectionId });
    return { removed_user_id: result.removed_user_id, member_count: result.member_count, section_deleted: result.section_deleted };
  }

  async listFiles(sectionId, query, userId) {
    const section = await SectionDAO.findById(pool, sectionId);
    if (!section) throw new NotFoundError('섹션을 찾을 수 없습니다');

    await this.assertContentAccess(sectionId, userId);

    return await AttachmentDAO.findBySection(pool, sectionId, query);
  }

  async assertContentAccess(sectionId, userId) {
    if (!(await SectionDAO.hasAccess(pool, sectionId, userId))) throw new ForbiddenError('섹션 콘텐츠 접근 권한이 없습니다', 'SECTION_ACCESS_DENIED');
  }

  async assertMessageAccess(messageId, userId) {
    const sectionId = await SectionDAO.findSectionIdByMessage(pool, messageId);
    if (!sectionId) throw new NotFoundError('메시지를 찾을 수 없습니다');
    return this.assertContentAccess(sectionId, userId);
  }

}

module.exports = { SectionService: new SectionService() };
