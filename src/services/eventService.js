const { EventDAO } = require('../daos/eventDAO');
const { CalendarDAO } = require('../daos/calendarDAO');
const { SeriesDAO } = require('../daos/seriesDAO');
const { ReminderDAO } = require('../daos/reminderDAO');
const { DrawerDAO } = require('../daos');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const withTransaction = require('../core/withTransaction');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../core/errors');
const { TargetType, ActionType } = require('../utils/typeDefinitions');
const pool = require('../../config/db');

class EventService {
  async getEvent(eventId) {
    const event = await EventDAO.findById(pool, eventId);
    if (!event) throw new NotFoundError('이벤트를 찾을 수 없습니다');
    return event;
  }

  async createEvent(data, context) {
    const event = await withTransaction(async (client) => {
      if (data.calendar) {
        const existing = await CalendarDAO.findById(client, data.calendar.id);
        if (!existing) {
          await CalendarDAO.create(client, data.calendar);
        }
      }

      if (data.series) {
        const existing = await SeriesDAO.findById(client, data.series.id);
        if (!existing) {
          await SeriesDAO.create(client, data.series);
        }
      }

      const created = await EventDAO.createEvent(client, data);

      if (data.series_id) {
        await EventDAO.addSeries(client, data.id, data.series_id);
      }

      if (data.reminders && data.reminders.length > 0) {
        for (const reminder of data.reminders) {
          await ReminderDAO.create(client, {
            ...reminder,
            user_id: context.sender_id,
          });
        }
      }

      return created;
    });

    eventBus.emit('sync', {
      drawer_id: data.drawer_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.CREATE,
      target_type: TargetType.EVENT,
      target_id: event.id,
    });

    const participants = new Set();
    if (data.instances && Array.isArray(data.instances)) {
      data.instances.forEach(inst => {
        if (inst.participants && Array.isArray(inst.participants)) {
          inst.participants.forEach(p => {
            if (p.user_id && p.user_id !== context.sender_id) {
              participants.add(p.user_id);
            }
          });
        }
      });
    }

    if (participants.size > 0) {
      eventBus.emit('alert', {
        drawer_id: data.drawer_id,
        sender_id: context.sender_id,
        type: 'assignment',
        title: data.drawer_name || '새로운 일정',
        body: `'${data.summary}' 일정에 배정되었습니다.`,
        target_user_ids: Array.from(participants),
        requiredLevel: 1,
        routeData: { route_type: 2, route_id: event.id },
        device_uuid: context.device_uuid,
      });
    }

    return event;
  }

  async updateEvent(event_id, updateData, context) {
    const { event, result } = await withTransaction(async (client) => {
      const event = await EventDAO.findById(client, event_id);
      if (!event) throw new NotFoundError('이벤트를 찾을 수 없습니다');
      const result = await EventDAO.updateEvent(client, event_id, updateData);
      return { event, result };
    });

    eventBus.emit('sync', {
      drawer_id: event.drawer_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.UPDATE,
      target_type: TargetType.EVENT,
      target_id: event_id,
    });

    return result;
  }

  async updateEventInstance(instance_id, updateData, context) {
    const { instance, result } = await withTransaction(async (client) => {
      const instance = await EventDAO.findInstanceById(client, instance_id);
      if (!instance) throw new NotFoundError('이벤트 인스턴스를 찾을 수 없습니다');
      const result = await EventDAO.updateEventInstance(client, instance_id, updateData);
      return { instance, result };
    });

    eventBus.emit('sync', {
      drawer_id: instance.drawer_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.UPDATE,
      target_type: TargetType.EVENT_INSTANCE,
      target_id: instance_id,
    });

    return result;
  }

  async splitEvent(splitData, context) {
    const { event_id, instance_id } = splitData;
    if (!event_id || !instance_id) {
      throw new BadRequestError('eventId와 instanceId가 필요합니다');
    }

    const new_event_id = generateUUID();

    const result = await withTransaction(async (client) => {
      return await EventDAO.splitEvent(client, event_id, instance_id, new_event_id);
    });

    eventBus.emit('sync', {
      drawer_id: splitData.drawer_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.CREATE,
      target_type: TargetType.EVENT,
      target_id: new_event_id,
    });

    return result;
  }

  async deleteEvent(event_id, context) {
    const { drawer_id } = await withTransaction(async (client) => {
      const event = await EventDAO.findById(client, event_id);
      if (!event) throw new NotFoundError('이벤트를 찾을 수 없습니다');
      await EventDAO.softDeleteEvent(client, event_id);
      return { drawer_id: event.drawer_id };
    });

    eventBus.emit('sync', {
      drawer_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE,
      target_type: TargetType.EVENT,
      target_id: event_id,
    });
  }

  async deleteEventInstance(instance_id, context) {
    const { drawer_id } = await withTransaction(async (client) => {
      const instance = await EventDAO.findInstanceById(client, instance_id);
      if (!instance) throw new NotFoundError('이벤트 인스턴스를 찾을 수 없습니다');
      await EventDAO.softDeleteEventInstance(client, instance_id);
      return { drawer_id: instance.drawer_id };
    });

    eventBus.emit('sync', {
      drawer_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE,
      target_type: TargetType.EVENT_INSTANCE,
      target_id: instance_id,
    });
  }

  async addParticipant(instance_id, participantData, context) {
    const { user_id } = participantData;
    if (!user_id) throw new BadRequestError('userId가 필요합니다');

    const result = await withTransaction(async (client) => {
      return await EventDAO.addParticipant(client, instance_id, user_id, context.sender_id);
    });

    if (participantData.drawer_id) {
      eventBus.emit('sync', {
        drawer_id: participantData.drawer_id,
        sender_id: context.sender_id,
        device_uuid: context.device_uuid,
        action: ActionType.CREATE,
        target_type: TargetType.EVENT_PARTICIPANT,
        target_id: instance_id,
      });

      eventBus.emit('alert', {
        drawer_id: participantData.drawer_id,
        sender_id: context.sender_id,
        type: 'assignment',
        title: participantData.drawer_name || '',
        body: participantData.alert_body || '이벤트에 참가자로 배정되었습니다.',
        target_user_ids: [user_id],
        requiredLevel: 1,
        routeData: { route_type: 2, route_id: instance_id },
        device_uuid: context.device_uuid,
      });
    }

    return result;
  }

  async updateMyParticipation(instance_id, user_id, updateData, context) {
    const { state } = updateData;
    if (state === undefined) throw new BadRequestError('state가 필요합니다');
    // confirm(0) is immutable host state; rejected(6) is host-only
    if (state === 0) throw new ForbiddenError('confirm 상태는 호스트 전용이며 변경할 수 없습니다');
    if (state === 6) throw new ForbiddenError('rejected 상태는 호스트만 설정할 수 있습니다');

    await withTransaction(async (client) => {
      const participant = await EventDAO.findParticipant(client, instance_id, user_id);
      if (!participant) throw new NotFoundError('참가자 정보를 찾을 수 없습니다');
      if (participant.state === 0) throw new ForbiddenError('호스트 상태는 변경할 수 없습니다');
      if (participant.state === 6) throw new ForbiddenError('호스트에 의해 거부된 신청은 변경할 수 없습니다');
      await EventDAO.updateParticipantState(client, instance_id, user_id, state);
    });

    if (updateData.drawer_id) {
      eventBus.emit('sync', {
        drawer_id: updateData.drawer_id,
        sender_id: context.sender_id,
        device_uuid: context.device_uuid,
        action: ActionType.RSVP_UPDATE,
        target_type: TargetType.EVENT_PARTICIPANT,
        target_id: instance_id,
      });
    }
  }

  async rejectApply(instance_id, targetUserId, drawerId, context) {
    await withTransaction(async (client) => {
      const requester = await DrawerDAO.getMember(client, drawerId, context.sender_id);
      if (!requester || requester.role > 1) throw new ForbiddenError('권한이 없습니다');

      const participant = await EventDAO.findParticipant(client, instance_id, targetUserId);
      if (!participant) throw new NotFoundError('참가자를 찾을 수 없습니다');
      if (participant.state === 0) throw new ForbiddenError('호스트는 거부할 수 없습니다');
      if (participant.state !== 2) {
        throw new BadRequestError('신청(apply) 상태의 참가자만 거부할 수 있습니다');
      }

      await EventDAO.updateParticipantState(client, instance_id, targetUserId, 6);
    });

    eventBus.emit('sync', {
      drawer_id: drawerId,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.REJECT,
      target_type: TargetType.EVENT_PARTICIPANT,
      target_id: instance_id,
    });
  }

  async restoreRejected(instance_id, targetUserId, newState, drawerId, context) {
    if (newState !== 3 && newState !== 4) {
      throw new BadRequestError('accept(3) 또는 tentative(4)로만 복원할 수 있습니다');
    }

    await withTransaction(async (client) => {
      const requester = await DrawerDAO.getMember(client, drawerId, context.sender_id);
      if (!requester || requester.role > 1) throw new ForbiddenError('권한이 없습니다');

      const participant = await EventDAO.findParticipant(client, instance_id, targetUserId);
      if (!participant || participant.state !== 6) {
        throw new BadRequestError('rejected 상태의 참가자만 복원할 수 있습니다');
      }

      await EventDAO.updateParticipantState(client, instance_id, targetUserId, newState);
    });

    eventBus.emit('sync', {
      drawer_id: drawerId,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.RSVP_UPDATE,
      target_type: TargetType.EVENT_PARTICIPANT,
      target_id: instance_id,
    });
  }

  async removeParticipant(instance_id, target_user_id, context) {
    await withTransaction(async (client) => {
      await EventDAO.removeParticipant(client, instance_id, target_user_id);
    });

    eventBus.emit('sync', {
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE,
      target_type: TargetType.EVENT_PARTICIPANT,
      target_id: instance_id,
    });
  }
}

module.exports = {
  EventService: new EventService(),
};
