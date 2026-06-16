const { CastDAO } = require('../daos/castDAO');
const { CalendarDAO } = require('../daos/calendarDAO');
const { DrawerDAO } = require('../daos/drawerDAO');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const withTransaction = require('../core/withTransaction');
const pool = require('../../config/db');
const { NotFoundError, ForbiddenError } = require('../core/errors');
const { TargetType, ActionType } = require('../utils/typeDefinitions');

class CastService {
  async getCasts(calId, query) {
    const cal = await CalendarDAO.findById(pool, calId);
    if (!cal) throw new NotFoundError('캘린더를 찾을 수 없습니다');
    return await CastDAO.findByCalId(pool, calId, query);
  }

  async getCast(castId) {
    const cast = await CastDAO.findById(pool, castId);
    if (!cast) throw new NotFoundError('캐스트를 찾을 수 없습니다');
    return cast;
  }

  async create(data, context) {
    const castsData = data.casts;
    if (!castsData || !castsData.length) throw new ForbiddenError('casts 배열이 필요합니다');

    const cal = await CalendarDAO.findById(pool, castsData[0].cal_id);
    if (!cal) throw new NotFoundError('캘린더를 찾을 수 없습니다');

    const member = await DrawerDAO.getMember(pool, cal.host_id, context.sender_id);
    if (!member || member.deleted_at) throw new ForbiddenError('권한이 없습니다');

    const created = await withTransaction(async (client) => {
      const results = [];
      for (const castData of castsData) {
        const cast = await CastDAO.create(client, {
          ...castData,
          id: castData.id || generateUUID(),
          author_id: context.sender_id,
        });
        results.push(cast);
      }
      return results;
    });

    for (const cast of created) {
      eventBus.emit('sync', {
        drawer_id: cal.host_id,
        sender_id: context.sender_id,
        device_uuid: context.device_uuid,
        action: ActionType.CREATE,
        target_type: TargetType.CAST,
        target_id: cast.id,
      });
    }

    return created;
  }

  async update(castId, data, context) {
    const cast = await CastDAO.findById(pool, castId);
    if (!cast) throw new NotFoundError('캐스트를 찾을 수 없습니다');

    const cal = await CalendarDAO.findById(pool, cast.cal_id);
    const member = await DrawerDAO.getMember(pool, cal.host_id, context.sender_id);
    if (!member || member.deleted_at || (member.role > 1 && cast.author_id !== context.sender_id))
      throw new ForbiddenError('권한이 없습니다');

    const updated = await CastDAO.update(pool, castId, data);

    eventBus.emit('sync', {
      drawer_id: cal.host_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.UPDATE,
      target_type: TargetType.CAST,
      target_id: castId,
    });

    return updated;
  }

  async delete(castId, context) {
    const cast = await CastDAO.findById(pool, castId);
    if (!cast) throw new NotFoundError('캐스트를 찾을 수 없습니다');

    const cal = await CalendarDAO.findById(pool, cast.cal_id);
    const member = await DrawerDAO.getMember(pool, cal.host_id, context.sender_id);
    if (!member || member.deleted_at || (member.role > 1 && cast.author_id !== context.sender_id))
      throw new ForbiddenError('권한이 없습니다');

    await CastDAO.softDelete(pool, castId);

    eventBus.emit('sync', {
      drawer_id: cal.host_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE,
      target_type: TargetType.CAST,
      target_id: castId,
    });
  }

  // Comments

  async getComments(castId, query) {
    const cast = await CastDAO.findById(pool, castId);
    if (!cast) throw new NotFoundError('캐스트를 찾을 수 없습니다');
    return await CastDAO.findCommentsByCastId(pool, castId, query);
  }

  async addComment(castId, data, context) {
    const cast = await CastDAO.findById(pool, castId);
    if (!cast) throw new NotFoundError('캐스트를 찾을 수 없습니다');

    const cal = await CalendarDAO.findById(pool, cast.cal_id);
    const member = await DrawerDAO.getMember(pool, cal.host_id, context.sender_id);
    if (!member || member.deleted_at) throw new ForbiddenError('드로어 멤버만 댓글을 달 수 있습니다');

    const comment = await CastDAO.createComment(pool, {
      ...data,
      id: data.id || generateUUID(),
      cast_id: castId,
      user_id: context.sender_id,
    });

    eventBus.emit('sync', {
      drawer_id: cal.host_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.CREATE,
      target_type: TargetType.CAST_COMMENT,
      target_id: comment.id,
    });

    return comment;
  }

  async updateComment(commentId, data, context) {
    const comment = await CastDAO.findCommentById(pool, commentId);
    if (!comment) throw new NotFoundError('댓글을 찾을 수 없습니다');
    if (comment.user_id !== context.sender_id) throw new ForbiddenError('본인의 댓글만 수정할 수 있습니다');

    return await CastDAO.updateComment(pool, commentId, data.content);
  }

  async deleteComment(commentId, context) {
    const comment = await CastDAO.findCommentById(pool, commentId);
    if (!comment) throw new NotFoundError('댓글을 찾을 수 없습니다');

    if (comment.user_id !== context.sender_id) {
      const cast = await CastDAO.findById(pool, comment.cast_id);
      const cal = cast ? await CalendarDAO.findById(pool, cast.cal_id) : null;
      const member = cal ? await DrawerDAO.getMember(pool, cal.host_id, context.sender_id) : null;
      if (!member || member.deleted_at || member.role > 1)
        throw new ForbiddenError('권한이 없습니다');
    }

    await CastDAO.deleteComment(pool, commentId);

    eventBus.emit('sync', {
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE,
      target_type: TargetType.CAST_COMMENT,
      target_id: commentId,
    });
  }
}

module.exports = { CastService: new CastService() };
