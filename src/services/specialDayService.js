const { SpecialDayDAO } = require('../daos/specialDayDAO');
const { CalendarDAO } = require('../daos/calendarDAO');
const { BinderDAO } = require('../daos/binderDAO');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const withTransaction = require('../core/withTransaction');
const pool = require('../../config/db');
const { NotFoundError, ForbiddenError } = require('../core/errors');
const { TargetType, ActionType } = require('../utils/typeDefinitions');

class SpecialDayService {
  async getById(id, userId) {
    const day = await SpecialDayDAO.findById(pool, id);
    if (!day) throw new NotFoundError('기념일을 찾을 수 없습니다');

    // F-S8a(0e0e67f) — 상위 체인(calendar·binder) 부재를 day 부재와 같은 404로 위장한다.
    // day_id를 훑는 공격자가 응답 코드·메시지로 상위 상태(캘린더 존재 여부·바인더 soft-delete
    // 여부)를 추론하지 못하게 하는 존재 오라클 방어다. 59c0a81(인가 30+2)이 이 함수를 공유
    // 헬퍼(requireBinderMemberByCalendarId)로 교체하며 이 위장을 무너뜨렸다 — 그 헬퍼는
    // 캘린더 부재를 "캘린더를 찾을 수 없습니다"로, 바인더 soft-delete를 403으로 그대로
    // 흘려보낸다. RLY-20260806-020 조사: 이 위장이 필요한 진입점은 이 함수 하나뿐이다
    // (다른 모든 getXxx 인가는 59c0a81이 신설한 것이라 위장할 기존 계약 자체가 없었다).
    // 그래서 공유 헬퍼에 옵션을 얹지 않고(다른 20여 호출부를 위험에 노출시키므로) 이 함수만
    // 인라인으로 되돌린다 — 되돌리는 것은 오류 구분이지 인가 자체가 아니다.
    const cal = await CalendarDAO.findById(pool, day.calendar_id);
    if (!cal) throw new NotFoundError('기념일을 찾을 수 없습니다');

    const binder = await BinderDAO.findById(pool, cal.binder_id);
    if (!binder) throw new NotFoundError('기념일을 찾을 수 없습니다');

    const member = await BinderDAO.getMember(pool, cal.binder_id, userId);
    if (!member || member.deleted_at) {
      throw new ForbiddenError('바인더 멤버만 기념일을 조회할 수 있습니다');
    }
    return day;
  }

  async getHolidays({ country_code, year } = {}) {
    return await SpecialDayDAO.findHolidays(pool, { country_code, year });
  }

  async getByCalendar(calId, userId) {
    const cal = await CalendarDAO.findById(pool, calId);
    if (!cal) throw new NotFoundError('캘린더를 찾을 수 없습니다');
    return await SpecialDayDAO.findByCalId(pool, calId);
  }

  async create(data, context) {
    const { calendar_id } = data;
    const cal = await CalendarDAO.findById(pool, calendar_id);
    if (!cal) throw new NotFoundError('캘린더를 찾을 수 없습니다');

    const member = await BinderDAO.getMember(pool, cal.binder_id, context.sender_id);
    if (!member || member.deleted_at) throw new ForbiddenError('권한이 없습니다');
    if (member.role > 2) throw new ForbiddenError('편집자 이상만 기념일을 생성할 수 있습니다');

    const specialDay = await withTransaction(async (client) => {
      if (data.calendar) {
        const existing = await CalendarDAO.findById(client, calendar_id);
        if (!existing) await CalendarDAO.create(client, data.calendar);
      }
      return await SpecialDayDAO.create(client, { ...data, id: data.id || generateUUID() });
    });

    eventBus.emit('sync', {
      binder_id: cal.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.CREATE,
      target_type: TargetType.SPECIAL_DAY,
      target_id: specialDay.id,
    });

    return specialDay;
  }

  async update(id, data, context) {
    const specialDay = await SpecialDayDAO.findById(pool, id);
    if (!specialDay) throw new NotFoundError('기념일을 찾을 수 없습니다');

    const cal = await CalendarDAO.findById(pool, specialDay.calendar_id);
    const member = await BinderDAO.getMember(pool, cal.binder_id, context.sender_id);
    if (!member || member.deleted_at || member.role > 2) throw new ForbiddenError('권한이 없습니다');

    const updated = await SpecialDayDAO.update(pool, id, data);

    eventBus.emit('sync', {
      binder_id: cal.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.UPDATE,
      target_type: TargetType.SPECIAL_DAY,
      target_id: id,
    });

    return updated;
  }

  async delete(id, context) {
    const specialDay = await SpecialDayDAO.findById(pool, id);
    if (!specialDay) throw new NotFoundError('기념일을 찾을 수 없습니다');

    const cal = await CalendarDAO.findById(pool, specialDay.calendar_id);
    const member = await BinderDAO.getMember(pool, cal.binder_id, context.sender_id);
    if (!member || member.deleted_at || member.role > 2) throw new ForbiddenError('권한이 없습니다');

    await SpecialDayDAO.softDelete(pool, id);

    eventBus.emit('sync', {
      binder_id: cal.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE,
      target_type: TargetType.SPECIAL_DAY,
      target_id: id,
    });
  }
}

module.exports = { SpecialDayService: new SpecialDayService() };
