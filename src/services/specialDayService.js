const { SpecialDayDAO } = require('../daos/specialDayDAO');
const { CalendarDAO } = require('../daos/calendarDAO');
const { DrawerDAO } = require('../daos/drawerDAO');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const withTransaction = require('../core/withTransaction');
const pool = require('../../config/db');
const { NotFoundError, ForbiddenError } = require('../core/errors');
const { TargetType, ActionType } = require('../utils/typeDefinitions');

class SpecialDayService {
  async getById(id) {
    const day = await SpecialDayDAO.findById(pool, id);
    if (!day) throw new NotFoundError('기념일을 찾을 수 없습니다');
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
    const { cal_id } = data;
    const cal = await CalendarDAO.findById(pool, cal_id);
    if (!cal) throw new NotFoundError('캘린더를 찾을 수 없습니다');

    const member = await DrawerDAO.getMember(pool, cal.host_id, context.sender_id);
    if (!member || member.deleted_at) throw new ForbiddenError('권한이 없습니다');
    if (member.role > 2) throw new ForbiddenError('편집자 이상만 기념일을 생성할 수 있습니다');

    const specialDay = await withTransaction(async (client) => {
      if (data.calendar) {
        const existing = await CalendarDAO.findById(client, cal_id);
        if (!existing) await CalendarDAO.create(client, data.calendar);
      }
      return await SpecialDayDAO.create(client, { ...data, id: data.id || generateUUID() });
    });

    eventBus.emit('sync', {
      drawer_id: cal.host_id,
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

    const cal = await CalendarDAO.findById(pool, specialDay.cal_id);
    const member = await DrawerDAO.getMember(pool, cal.host_id, context.sender_id);
    if (!member || member.deleted_at || member.role > 2) throw new ForbiddenError('권한이 없습니다');

    const updated = await SpecialDayDAO.update(pool, id, data);

    eventBus.emit('sync', {
      drawer_id: cal.host_id,
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

    const cal = await CalendarDAO.findById(pool, specialDay.cal_id);
    const member = await DrawerDAO.getMember(pool, cal.host_id, context.sender_id);
    if (!member || member.deleted_at || member.role > 2) throw new ForbiddenError('권한이 없습니다');

    await SpecialDayDAO.softDelete(pool, id);

    eventBus.emit('sync', {
      drawer_id: cal.host_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE,
      target_type: TargetType.SPECIAL_DAY,
      target_id: id,
    });
  }
}

module.exports = { SpecialDayService: new SpecialDayService() };
