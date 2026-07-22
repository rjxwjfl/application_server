const { SectionDAO } = require('../daos/sectionDAO');
const { AttachmentDAO } = require('../daos/attachmentDAO');
const { BinderDAO } = require('../daos');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const pool = require('../../config/db');
const withTransaction = require('../core/withTransaction');
const { AppError, NotFoundError, BadRequestError, ForbiddenError } = require('../core/errors');
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
      const scope = data.access_scope ?? 0;
      if (![0, 1].includes(scope)) throw new BadRequestError('access_scope는 0 또는 1이어야 합니다');
      if (scope === 1 && !data.group_id) throw new AppError('private 섹션에는 그룹이 필요합니다', 422, 'SECTION_GRANT_REQUIRED');
      const created = await SectionDAO.create(client, {
        id: data.id || generateUUID(),
        binder_id: data.binder_id,
        title: data.title,
        access_scope: scope,
        group_id: scope === 1 ? data.group_id : null,
      });
      if (!created) throw new BadRequestError('그룹이 바인더에 속하지 않습니다');
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
      const scope = updateData.access_scope ?? section.access_scope;
      const hasGroupId = Object.prototype.hasOwnProperty.call(updateData, 'group_id');
      const groupId = hasGroupId ? updateData.group_id : section.group_id;
      if (section.is_default && (scope === 1 || groupId !== null)) throw new BadRequestError('기본 섹션에는 그룹을 설정할 수 없습니다');
      if (scope === 1 && groupId === null) throw new AppError('private 섹션의 group_id는 비울 수 없습니다', 422, 'SECTION_GRANT_REQUIRED');

      const result = await SectionDAO.update(client, sectionId, updateData, hasGroupId);
      if (!result) throw new BadRequestError('그룹이 바인더에 속하지 않습니다');
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
