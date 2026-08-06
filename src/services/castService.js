const { CastDAO } = require('../daos/castDAO');
const { CalendarDAO } = require('../daos/calendarDAO');
const { BinderDAO } = require('../daos/binderDAO');
const { MediaService } = require('./mediaService');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const withTransaction = require('../core/withTransaction');
const pool = require('../../config/db');
const { NotFoundError, ForbiddenError } = require('../core/errors');
const { requireBinderMemberByCalendarId } = require('../core/authz');
const { TargetType, ActionType } = require('../utils/typeDefinitions');

class CastService {
  async getCasts(calId, query, userId) {
    // 결정 5: 바인더 멤버십 OR 캘린더 is_public — 비공개 캘린더의 비멤버는 접근 불가.
    await requireBinderMemberByCalendarId(pool, calId, userId, { allowPublicRead: true });
    return await CastDAO.findByCalId(pool, calId, query);
  }

  async getCast(castId, userId) {
    const cast = await CastDAO.findById(pool, castId);
    if (!cast) throw new NotFoundError('캐스트를 찾을 수 없습니다');
    await requireBinderMemberByCalendarId(pool, cast.calendar_id, userId, { allowPublicRead: true });
    return cast;
  }

  async create(data, context) {
    const castsData = data.casts;
    if (!castsData || !castsData.length) throw new ForbiddenError('casts 배열이 필요합니다');

    const binderIdByCalendarId = new Map();
    const calendarIds = [...new Set(castsData.map((castData) => castData.calendar_id))];

    for (const calendarId of calendarIds) {
      const cal = await CalendarDAO.findById(pool, calendarId);
      if (!cal || cal.deleted_at) throw new NotFoundError('캘린더를 찾을 수 없습니다');

      const binder = await BinderDAO.findById(pool, cal.binder_id);
      if (!binder || binder.deleted_at) throw new NotFoundError('바인더를 찾을 수 없습니다');

      const member = await BinderDAO.getMember(pool, cal.binder_id, context.sender_id);
      if (!member || member.deleted_at) throw new ForbiddenError('권한이 없습니다');

      binderIdByCalendarId.set(calendarId, cal.binder_id);
    }

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
        binder_id: binderIdByCalendarId.get(cast.calendar_id),
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

    const cal = await CalendarDAO.findById(pool, cast.calendar_id);
    const member = await BinderDAO.getMember(pool, cal.binder_id, context.sender_id);
    if (!member || member.deleted_at || (member.role > 1 && cast.author_id !== context.sender_id))
      throw new ForbiddenError('권한이 없습니다');

    // RLY-20260806-052 — cover_image_url·thumbnail_url 소유권 검증. 'covers' prefix로
    // mediaService._authorizeCoverPresign의 cast 분기가 생성한 storage_key와 짝을 맞춘다.
    if (data.cover_image_url !== undefined) {
      await MediaService.assertOwnedMediaReference(data.cover_image_url, { prefix: 'covers', entityId: castId });
    }
    if (data.thumbnail_url !== undefined) {
      await MediaService.assertOwnedMediaReference(data.thumbnail_url, { prefix: 'covers', entityId: castId });
    }

    const updated = await CastDAO.update(pool, castId, data);

    eventBus.emit('sync', {
      binder_id: cal.binder_id,
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

    const cal = await CalendarDAO.findById(pool, cast.calendar_id);
    const member = await BinderDAO.getMember(pool, cal.binder_id, context.sender_id);
    if (!member || member.deleted_at || (member.role > 1 && cast.author_id !== context.sender_id))
      throw new ForbiddenError('권한이 없습니다');

    await CastDAO.softDelete(pool, castId);

    eventBus.emit('sync', {
      binder_id: cal.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE,
      target_type: TargetType.CAST,
      target_id: castId,
    });
  }

  // Comments

  async getComments(castId, query, userId) {
    const cast = await CastDAO.findById(pool, castId);
    if (!cast) throw new NotFoundError('캐스트를 찾을 수 없습니다');
    await requireBinderMemberByCalendarId(pool, cast.calendar_id, userId, { allowPublicRead: true });
    return await CastDAO.findCommentsByCastId(pool, castId, query);
  }

  async addComment(castId, data, context) {
    const cast = await CastDAO.findById(pool, castId);
    if (!cast) throw new NotFoundError('캐스트를 찾을 수 없습니다');

    const cal = await CalendarDAO.findById(pool, cast.calendar_id);
    const member = await BinderDAO.getMember(pool, cal.binder_id, context.sender_id);
    if (!member || member.deleted_at) throw new ForbiddenError('바인더 멤버만 댓글을 달 수 있습니다');

    const comment = await CastDAO.createComment(pool, {
      ...data,
      id: data.id || generateUUID(),
      cast_id: castId,
      user_id: context.sender_id,
    });

    eventBus.emit('sync', {
      binder_id: cal.binder_id,
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
      const cal = cast ? await CalendarDAO.findById(pool, cast.calendar_id) : null;
      const member = cal ? await BinderDAO.getMember(pool, cal.binder_id, context.sender_id) : null;
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
