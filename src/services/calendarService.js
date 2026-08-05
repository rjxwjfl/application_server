const { CalendarDAO } = require('../daos/calendarDAO');
const { BinderDAO } = require('../daos/binderDAO');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const withTransaction = require('../core/withTransaction');
const pool = require('../../config/db');
const { NotFoundError, ForbiddenError, BadRequestError } = require('../core/errors');
const { requireBinderMemberByCalendarId } = require('../core/authz');
const { TargetType, ActionType } = require('../utils/typeDefinitions');

class CalendarService {
  async getBinderCalendars(binderId, userId) {
    const member = await BinderDAO.getMember(pool, binderId, userId);
    if (!member || member.deleted_at) throw new ForbiddenError('바인더 멤버만 조회할 수 있습니다');
    return await CalendarDAO.findByBinderId(pool, binderId);
  }

  async create(data, context) {
    const { binder_id } = data;
    const member = await BinderDAO.getMember(pool, binder_id, context.sender_id);
    if (!member || member.deleted_at || member.role > 1)
      throw new ForbiddenError('관리자 이상만 캘린더를 생성할 수 있습니다');

    const calendar = await withTransaction(async (client) => {
      return await CalendarDAO.create(client, {
        id: data.id || generateUUID(),
        binder_id,
        title: data.title,
        description: data.description,
        color: data.color,
        is_public: data.is_public,
        created_at: data.created_at,
        updated_at: data.updated_at,
      });
    });

    eventBus.emit('sync', {
      binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.CREATE,
      target_type: TargetType.CALENDAR,
      target_id: calendar.id,
    });

    return calendar;
  }

  async update(calId, data, context) {
    const cal = await CalendarDAO.findById(pool, calId);
    if (!cal) throw new NotFoundError('캘린더를 찾을 수 없습니다');

    const member = await BinderDAO.getMember(pool, cal.binder_id, context.sender_id);
    if (!member || member.deleted_at || member.role > 1)
      throw new ForbiddenError('관리자 이상만 캘린더를 수정할 수 있습니다');

    const updated = await CalendarDAO.update(pool, calId, data);

    eventBus.emit('sync', {
      binder_id: cal.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.UPDATE,
      target_type: TargetType.CALENDAR,
      target_id: calId,
    });

    return updated;
  }

  async delete(calId, context) {
    const cal = await CalendarDAO.findById(pool, calId);
    if (!cal) throw new NotFoundError('캘린더를 찾을 수 없습니다');
    if (cal.is_default) throw new BadRequestError('기본 캘린더는 삭제할 수 없습니다');

    const member = await BinderDAO.getMember(pool, cal.binder_id, context.sender_id);
    if (!member || member.deleted_at || member.role !== 0)
      throw new ForbiddenError('마스터만 캘린더를 삭제할 수 있습니다');

    await CalendarDAO.softDelete(pool, calId);

    eventBus.emit('sync', {
      binder_id: cal.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE,
      target_type: TargetType.CALENDAR,
      target_id: calId,
    });
  }

  async subscribe(calId, context) {
    const cal = await CalendarDAO.findById(pool, calId);
    if (!cal) throw new NotFoundError('캘린더를 찾을 수 없습니다');
    if (!cal.is_public) throw new ForbiddenError('공개 캘린더만 구독할 수 있습니다');

    // AC-SEC-6(user_workflows.md §5-16): 이미 그 바인더의 멤버는 자기 바인더 캘린더를 구독할 수 없다.
    const member = await BinderDAO.getMember(pool, cal.binder_id, context.sender_id);
    if (member && !member.deleted_at) {
      throw new BadRequestError('이미 속한 바인더의 캘린더는 구독할 수 없습니다');
    }

    const sub = await CalendarDAO.subscribe(pool, context.sender_id, calId);

    eventBus.emit('sync', {
      binder_id: cal.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.SUBSCRIBE,
      target_type: TargetType.CALENDAR_SUBSCRIPTION,
      target_id: calId,
    });

    return sub;
  }

  async unsubscribe(calId, context) {
    const cal = await CalendarDAO.findById(pool, calId);
    if (!cal) throw new NotFoundError('캘린더를 찾을 수 없습니다');

    await CalendarDAO.unsubscribe(pool, context.sender_id, calId);

    eventBus.emit('sync', {
      binder_id: cal.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.UNSUBSCRIBE,
      target_type: TargetType.CALENDAR_SUBSCRIPTION,
      target_id: calId,
    });
  }

  async getMySubscriptions(userId) {
    return await CalendarDAO.getSubscriptionsByUserId(pool, userId);
  }

  async getById(calId, userId) {
    const { calendar } = await requireBinderMemberByCalendarId(pool, calId, userId);
    return calendar;
  }

  async getCalendarSubscriptions(calId, userId) {
    await requireBinderMemberByCalendarId(pool, calId, userId);
    return await CalendarDAO.getCalendarSubscriptions(pool, calId);
  }
}

module.exports = { CalendarService: new CalendarService() };
