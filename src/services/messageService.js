const { MessageDAO } = require('../daos/messageDAO');
const { SectionDAO } = require('../daos/sectionDAO');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const pool = require('../../config/db');
const withTransaction = require('../core/withTransaction');
const { NotFoundError, ForbiddenError, BadRequestError, ConflictError } = require('../core/errors');
const { TargetType, ActionType } = require('../utils/typeDefinitions');

class MessageService {
  async getMessages(sectionId, query) {
    const messages = await MessageDAO.getBySectionId(pool, sectionId, query);
    if (messages.length === 0) return [];

    const messageIds = messages.map((m) => m.id);

    const [attachments, embeds, reactions, mentions] = await Promise.all([
      MessageDAO.getAttachmentsByMessageIds(pool, messageIds),
      MessageDAO.getEmbedsByMessageIds(pool, messageIds),
      MessageDAO.getReactionsByMessageIds(pool, messageIds),
      MessageDAO.getMentionsByMessageIds(pool, messageIds),
    ]);

    const groupBy = (arr, key) => arr.reduce((map, item) => {
      (map[item[key]] = map[item[key]] || []).push(item);
      return map;
    }, {});

    const attachMap = groupBy(attachments, 'message_id');
    const embedMap = groupBy(embeds, 'message_id');
    const reactionMap = groupBy(reactions, 'message_id');
    const mentionMap = groupBy(mentions, 'message_id');

    return messages.map((m) => ({
      ...m,
      attachments: attachMap[m.id] || [],
      embeds: embedMap[m.id] || [],
      reactions: reactionMap[m.id] || [],
      mentions: mentionMap[m.id] || [],
    }));
  }

  async createMessage(sectionId, data, context) {
    const section = await SectionDAO.findById(pool, sectionId);
    if (!section) throw new NotFoundError('섹션을 찾을 수 없습니다');

    const messageId = data.id || generateUUID();

    // F-S9b(정정) — 섹션 메시지 첨부는 presign/confirm으로 이미 만들어진 attachments 행을
    // messageDAO.linkAttachments가 링크만 한다. 402 한도 검사·applyStorageDelta는
    // presign/confirm 시점에 이미 끝나 있으므로 여기서 다시 하면 이중 계상이다 — 하지 않는다.
    const result = await withTransaction(async (client) => {
      const message = await MessageDAO.create(client, {
        id: messageId,
        section_id: sectionId,
        user_id: context.sender_id,
        parent_id: data.parent_id,
        content: data.content,
        mention_everyone: data.mention_everyone,
      });

      let attachments = [];
      let embeds = [];
      let mentions = [];

      if (data.attachments && data.attachments.length > 0) {
        attachments = await MessageDAO.linkAttachments(client, messageId, section.binder_id, context.sender_id, data.attachments);
      }
      if (data.embeds && data.embeds.length > 0) {
        embeds = await MessageDAO.insertEmbeds(client, messageId, data.embeds);
      }
      if (data.mention_user_ids && data.mention_user_ids.length > 0) {
        const mentionData = data.mention_user_ids.map((uid) => ({
          id: generateUUID(),
          user_id: uid,
        }));
        mentions = await MessageDAO.insertMentions(client, messageId, mentionData);
      }

      return { ...message, attachments, embeds, mentions };
    });

    eventBus.emit('sync', {
      binder_id: section.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.CREATE, target_type: TargetType.SECTION_MESSAGE, target_id: messageId,
    });

    if (data.mention_user_ids && data.mention_user_ids.length > 0) {
      eventBus.emit('alert', {
        binder_id: section.binder_id,
        sender_id: context.sender_id,
        type: 'mention',
        title: section.title || '',
        body: data.content ? data.content.substring(0, 100) : '메시지에서 멘션되었습니다.',
        target_user_ids: data.mention_user_ids,
        requiredLevel: 2,
        routeData: { route_type: TargetType.SECTION_MESSAGE, route_id: messageId },
        device_uuid: context.device_uuid,
      });
    }

    return result;
  }

  async updateMessage(messageId, data, context) {
    const { message, result } = await withTransaction(async (client) => {
      const message = await MessageDAO.findById(client, messageId);
      if (!message) throw new NotFoundError('메시지를 찾을 수 없습니다');
      if (message.user_id !== context.sender_id) throw new ForbiddenError('본인의 메시지만 수정할 수 있습니다');
      const result = await MessageDAO.update(client, messageId, data);
      return { message, result };
    });

    eventBus.emit('sync', {
      binder_id: data.binder_id || message.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.UPDATE, target_type: TargetType.SECTION_MESSAGE, target_id: messageId,
    });

    return result;
  }

  async deleteMessage(messageId, context) {
    const { binder_id } = await withTransaction(async (client) => {
      const message = await MessageDAO.findById(client, messageId);
      if (!message) throw new NotFoundError('메시지를 찾을 수 없습니다');
      await MessageDAO.softDelete(client, messageId);
      const section = await SectionDAO.findById(client, message.section_id);
      return { binder_id: section ? section.binder_id : null };
    });

    eventBus.emit('sync', {
      binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE, target_type: TargetType.SECTION_MESSAGE, target_id: messageId,
    });
  }

  async togglePin(messageId, context) {
    const { result, binder_id } = await withTransaction(async (client) => {
      const message = await MessageDAO.findById(client, messageId);
      if (!message) throw new NotFoundError('메시지를 찾을 수 없습니다');
      const result = await MessageDAO.togglePin(client, messageId);
      const section = await SectionDAO.findById(client, message.section_id);
      return { result, binder_id: section ? section.binder_id : null };
    });

    eventBus.emit('sync', {
      binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: result.is_pinned ? ActionType.PIN : ActionType.UNPIN, target_type: TargetType.SECTION_MESSAGE, target_id: messageId,
    });

    return result;
  }

  async addReaction(messageId, emoji, context) {
    return await withTransaction(async (client) => {
      return await MessageDAO.addReaction(client, {
        id: generateUUID(),
        message_id: messageId,
        user_id: context.sender_id,
        emoji,
      });
    });
  }

  async removeReaction(messageId, emoji, context) {
    await withTransaction(async (client) => {
      await MessageDAO.removeReaction(client, messageId, context.sender_id, emoji);
    });
  }

  async getPinnedMessages(sectionId) {
    return await MessageDAO.findPinned(pool, sectionId);
  }

  async updateCursor(sectionId, userId, data) {
    await MessageDAO.upsertCursor(pool, sectionId, userId, data);
  }

  async getPoll(messageId, pollId, userId) {
    const result = await pool.query(
      `SELECT p.*, json_agg(
         json_build_object(
           'id', po.id,
           'option_text', po.option_text,
           'display_order', po.display_order,
           'vote_count', (SELECT COUNT(*) FROM message_poll_votes v WHERE v.option_id = po.id AND v.deleted_at IS NULL),
           'voted_by_me', EXISTS(SELECT 1 FROM message_poll_votes v WHERE v.option_id = po.id AND v.user_id = $3 AND v.deleted_at IS NULL)
         ) ORDER BY po.display_order
       ) AS options
       FROM message_polls p
       JOIN message_poll_options po ON po.poll_id = p.id AND po.deleted_at IS NULL
       WHERE p.id = $1 AND p.message_id = $2 AND p.deleted_at IS NULL
       GROUP BY p.id`,
      [pollId, messageId, userId]
    );
    const poll = result.rows[0];
    if (!poll) throw new NotFoundError('투표를 찾을 수 없습니다');
    return {
      ...poll,
      total_votes: poll.options.reduce((sum, o) => sum + Number(o.vote_count), 0),
    };
  }

  async votePoll(messageId, pollId, { option_ids }, userId) {
    if (!option_ids || !option_ids.length) throw new BadRequestError('option_ids가 필요합니다');

    await withTransaction(async (client) => {
      const pollResult = await client.query(
        `SELECT allow_multiple, is_closed, closed_at FROM message_polls WHERE id = $1 AND message_id = $2 AND deleted_at IS NULL`,
        [pollId, messageId]
      );
      const poll = pollResult.rows[0];
      if (!poll) throw new NotFoundError('투표를 찾을 수 없습니다');
      if (poll.is_closed || poll.closed_at) throw new ConflictError('마감된 투표입니다');
      if (!poll.allow_multiple && option_ids.length > 1) throw new ConflictError('단일 선택 투표입니다');

      await client.query(
        `UPDATE message_poll_votes SET deleted_at = now() WHERE poll_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [pollId, userId]
      );
      for (const optionId of option_ids) {
        await client.query(
          `INSERT INTO message_poll_votes (id, poll_id, option_id, user_id, created_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (poll_id, option_id, user_id) DO UPDATE SET deleted_at = NULL`,
          [generateUUID(), pollId, optionId, userId]
        );
      }
    });
  }

  async closePoll(messageId, pollId, context) {
    const result = await pool.query(
      `UPDATE message_polls SET is_closed = TRUE, closed_at = now(), updated_at = now()
       WHERE id = $1 AND message_id = $2 AND deleted_at IS NULL
       RETURNING id`,
      [pollId, messageId]
    );
    if (!result.rows[0]) throw new NotFoundError('투표를 찾을 수 없습니다');
  }
}

module.exports = { MessageService: new MessageService() };
