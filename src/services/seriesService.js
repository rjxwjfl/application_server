const { SeriesDAO } = require('../daos/seriesDAO');
const { AttachmentDAO } = require('../daos/attachmentDAO');
const { DrawerDAO } = require('../daos');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const pool = require('../../config/db');
const withTransaction = require('../core/withTransaction');
const { NotFoundError, BadRequestError, ForbiddenError } = require('../core/errors');
const { TargetType, ActionType } = require('../utils/typeDefinitions');

class SeriesService {
  async getSeriesByDrawerId(drawerId) {
    return await SeriesDAO.findByDrawerId(pool, drawerId);
  }

  async createSeries(data, context) {
    const series = await withTransaction((client) =>
      SeriesDAO.create(client, {
        id: data.id || generateUUID(),
        drawer_id: data.drawer_id,
        title: data.title,
        access_scope: data.access_scope,
        required_grade: data.required_grade,
      })
    );

    eventBus.emit('sync', {
      drawer_id: data.drawer_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.CREATE, target_type: TargetType.SERIES, target_id: series.id,
    });

    return series;
  }

  async updateSeries(seriesId, updateData, context) {
    const { series, result } = await withTransaction(async (client) => {
      const series = await SeriesDAO.findById(client, seriesId);
      if (!series) throw new NotFoundError('시리즈를 찾을 수 없습니다');

      const result = await SeriesDAO.update(client, seriesId, updateData);
      return { series, result };
    });

    eventBus.emit('sync', {
      drawer_id: series.drawer_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.UPDATE, target_type: TargetType.SERIES, target_id: seriesId,
    });

    return result;
  }

  async deleteSeries(seriesId, context) {
    const { drawer_id } = await withTransaction(async (client) => {
      const series = await SeriesDAO.findById(client, seriesId);
      if (!series) throw new NotFoundError('시리즈를 찾을 수 없습니다');
      if (series.is_default) throw new BadRequestError('기본 시리즈는 삭제할 수 없습니다');

      await SeriesDAO.softDelete(client, seriesId);
      return { drawer_id: series.drawer_id };
    });

    eventBus.emit('sync', {
      drawer_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE, target_type: TargetType.SERIES, target_id: seriesId,
    });
  }

  async listFiles(seriesId, query, userId) {
    const series = await SeriesDAO.findById(pool, seriesId);
    if (!series) throw new NotFoundError('시리즈를 찾을 수 없습니다');

    const member = await DrawerDAO.getMember(pool, series.drawer_id, userId);
    if (!member || member.deleted_at) throw new ForbiddenError('서랍 멤버만 파일을 조회할 수 있습니다');

    return await AttachmentDAO.findBySeries(pool, seriesId, query);
  }

}

module.exports = { SeriesService: new SeriesService() };
