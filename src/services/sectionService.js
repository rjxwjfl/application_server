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
  async getSectionByBinderId(binderId) {
    return await SectionDAO.findByBinderId(pool, binderId);
  }

  async createSection(data, context) {
    const section = await withTransaction((client) =>
      SectionDAO.create(client, {
        id: data.id || generateUUID(),
        binder_id: data.binder_id,
        title: data.title,
        access_scope: data.access_scope,
        required_grade: data.required_grade,
      })
    );

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
      const section = await SectionDAO.findById(client, sectionId);
      if (!section) throw new NotFoundError('섹션을 찾을 수 없습니다');

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

    const member = await BinderDAO.getMember(pool, section.binder_id, userId);
    if (!member || member.deleted_at) throw new ForbiddenError('바인더 멤버만 파일을 조회할 수 있습니다');

    return await AttachmentDAO.findBySection(pool, sectionId, query);
  }

}

module.exports = { SectionService: new SectionService() };
