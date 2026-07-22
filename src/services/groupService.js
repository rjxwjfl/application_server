const { GroupDAO } = require('../daos/groupDAO');
const { BinderDAO } = require('../daos');
const { SectionDAO } = require('../daos/sectionDAO');
const { generateUUID } = require('../utils/uuid');
const pool = require('../../config/db');
const withTransaction = require('../core/withTransaction');
const { AppError, BadRequestError, ForbiddenError, NotFoundError } = require('../core/errors');

class GroupService {
  async requireManager(conn, binderId, actorId) {
    const actor = await BinderDAO.getMember(conn, binderId, actorId);
    if (!actor || actor.deleted_at || actor.role > 1) throw new ForbiddenError('manager 이상 권한이 필요합니다');
    return actor;
  }

  async getGroups(binderId, actorId) {
    const member = await BinderDAO.getMember(pool, binderId, actorId);
    if (!member || member.deleted_at) throw new ForbiddenError('바인더 멤버만 그룹을 조회할 수 있습니다');
    return GroupDAO.getGroups(pool, binderId);
  }

  async createGroup(binderId, data, actorId) {
    if (!data.name || !data.name.trim()) throw new BadRequestError('그룹 이름이 필요합니다');
    return withTransaction(async (client) => {
      await this.requireManager(client, binderId, actorId);
      return GroupDAO.createGroup(client, { id: data.id || generateUUID(), binderId, name: data.name.trim(), color: data.color, createdBy: actorId });
    });
  }

  async updateGroup(groupId, data, actorId) {
    return withTransaction(async (client) => {
      const group = await GroupDAO.findById(client, groupId, true);
      if (!group) throw new NotFoundError('그룹을 찾을 수 없습니다');
      await this.requireManager(client, group.binder_id, actorId);
      return GroupDAO.updateGroup(client, groupId, data);
    });
  }

  async deleteGroup(groupId, actorId) {
    return withTransaction(async (client) => {
      const group = await GroupDAO.findById(client, groupId, true);
      if (!group) throw new NotFoundError('그룹을 찾을 수 없습니다');
      await this.requireManager(client, group.binder_id, actorId);
      if (await SectionDAO.isLastGrantGroup(client, groupId)) throw new AppError('private 섹션의 마지막 그룹은 삭제할 수 없습니다', 422, 'SECTION_GRANT_REQUIRED');
      return GroupDAO.deleteGroup(client, groupId);
    });
  }

  async addMember(groupId, data, actorId) {
    return withTransaction(async (client) => {
      const group = await GroupDAO.findById(client, groupId, true);
      if (!group) throw new NotFoundError('그룹을 찾을 수 없습니다');
      await this.requireManager(client, group.binder_id, actorId);
      const target = await BinderDAO.getMember(client, group.binder_id, data.user_id);
      if (!target || target.deleted_at) throw new BadRequestError('활성 바인더 멤버만 그룹에 추가할 수 있습니다');
      return GroupDAO.addMember(client, { id: data.id || generateUUID(), groupId, userId: data.user_id });
    });
  }

  async removeMember(groupId, userId, actorId) {
    return withTransaction(async (client) => {
      const group = await GroupDAO.findById(client, groupId, true);
      if (!group) throw new NotFoundError('그룹을 찾을 수 없습니다');
      const actor = await this.requireManager(client, group.binder_id, actorId);
      const target = await BinderDAO.getMember(client, group.binder_id, userId);
      if (!target || actor.role >= target.role) throw new ForbiddenError('동급 또는 상위 역할의 멤버를 변경할 수 없습니다');
      return GroupDAO.removeMember(client, groupId, userId);
    });
  }
}

module.exports = { GroupService: new GroupService() };
