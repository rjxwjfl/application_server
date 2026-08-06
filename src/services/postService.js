const { PostDAO } = require('../daos/postDAO');
const { AttachmentDAO } = require('../daos/attachmentDAO');
const { BinderDAO } = require('../daos/binderDAO');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const pool = require('../../config/db');
const { NotFoundError, ForbiddenError } = require('../core/errors');
const { requireBinderMember } = require('../core/authz');
const { TargetType, ActionType } = require('../utils/typeDefinitions');

class PostService {
  async withAttachments(post) {
    if (!post) return post;
    const attachments = (await AttachmentDAO.findByContext(pool, 'POST', post.id))
      .filter((attachment) => attachment.status === 'ready');
    return { ...post, attachments };
  }

  async getPosts(binderId, query, userId) {
    const member = await BinderDAO.getMember(pool, binderId, userId);
    if (!member || member.deleted_at) throw new ForbiddenError('바인더 멤버만 조회할 수 있습니다');
    const posts = await PostDAO.findByBinderId(pool, binderId, query);
    return await Promise.all(posts.map((post) => this.withAttachments(post)));
  }

  async getPost(postId, userId) {
    const post = await PostDAO.findById(pool, postId);
    if (!post) throw new NotFoundError('게시물을 찾을 수 없습니다');
    await requireBinderMember(pool, post.binder_id, userId);
    return await this.withAttachments(post);
  }

  async create(data, context) {
    const member = await BinderDAO.getMember(pool, data.binder_id, context.sender_id);
    if (!member || member.deleted_at) throw new ForbiddenError('바인더 멤버만 게시물을 작성할 수 있습니다');

    const post = await PostDAO.create(pool, {
      ...data,
      id: data.id || generateUUID(),
      author_id: context.sender_id,
    });

    eventBus.emit('sync', {
      binder_id: member.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.CREATE,
      target_type: TargetType.POST,
      target_id: post.id,
    });

    return await this.withAttachments(post);
  }

  async update(postId, data, context) {
    const post = await PostDAO.findById(pool, postId);
    if (!post) throw new NotFoundError('게시물을 찾을 수 없습니다');

    if (post.author_id !== context.sender_id) {
      const member = await BinderDAO.getMember(pool, post.binder_id, context.sender_id);
      if (!member || member.deleted_at || member.role > 1)
        throw new ForbiddenError('권한이 없습니다');
    }

    const updated = await PostDAO.update(pool, postId, data);

    eventBus.emit('sync', {
      binder_id: post.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.UPDATE,
      target_type: TargetType.POST,
      target_id: postId,
    });

    return await this.withAttachments(updated);
  }

  async delete(postId, context) {
    const post = await PostDAO.findById(pool, postId);
    if (!post) throw new NotFoundError('게시물을 찾을 수 없습니다');

    if (post.author_id !== context.sender_id) {
      const member = await BinderDAO.getMember(pool, post.binder_id, context.sender_id);
      if (!member || member.deleted_at || member.role > 1)
        throw new ForbiddenError('권한이 없습니다');
    }

    await PostDAO.softDelete(pool, postId);

    eventBus.emit('sync', {
      binder_id: post.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE,
      target_type: TargetType.POST,
      target_id: postId,
    });
  }

  // Comments

  async getComments(postId, query, userId) {
    const post = await PostDAO.findById(pool, postId);
    if (!post) throw new NotFoundError('게시물을 찾을 수 없습니다');
    await requireBinderMember(pool, post.binder_id, userId);
    return await PostDAO.findCommentsByPostId(pool, postId, query);
  }

  async addComment(postId, data, context) {
    const post = await PostDAO.findById(pool, postId);
    if (!post) throw new NotFoundError('게시물을 찾을 수 없습니다');

    const member = await BinderDAO.getMember(pool, post.binder_id, context.sender_id);
    if (!member || member.deleted_at) throw new ForbiddenError('바인더 멤버만 댓글을 달 수 있습니다');

    const comment = await PostDAO.createComment(pool, {
      ...data,
      id: data.id || generateUUID(),
      post_id: postId,
      user_id: context.sender_id,
    });

    eventBus.emit('sync', {
      binder_id: post.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.CREATE,
      target_type: TargetType.POST_COMMENT,
      target_id: comment.id,
    });

    return comment;
  }

  async deleteComment(commentId, context) {
    const comment = await PostDAO.findCommentById(pool, commentId);
    if (!comment) throw new NotFoundError('댓글을 찾을 수 없습니다');

    const post = await PostDAO.findById(pool, comment.post_id);
    if (comment.user_id !== context.sender_id) {
      const member = post ? await BinderDAO.getMember(pool, post.binder_id, context.sender_id) : null;
      if (!member || member.deleted_at || member.role > 1)
        throw new ForbiddenError('권한이 없습니다');
    }

    await PostDAO.softDeleteComment(pool, commentId);

    eventBus.emit('sync', {
      binder_id: post?.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE,
      target_type: TargetType.POST_COMMENT,
      target_id: commentId,
    });
  }

  // Likes

  async likePost(postId, context) {
    const post = await PostDAO.findById(pool, postId);
    if (!post) throw new NotFoundError('게시물을 찾을 수 없습니다');

    const member = await BinderDAO.getMember(pool, post.binder_id, context.sender_id);
    if (!member || member.deleted_at) throw new ForbiddenError('바인더 멤버만 좋아요를 누를 수 있습니다');

    const existing = await PostDAO.findLike(pool, postId, context.sender_id);
    if (existing) return { count: await PostDAO.getLikeCount(pool, postId) };

    await PostDAO.createLike(pool, {
      post_id: postId,
      user_id: context.sender_id,
    });

    eventBus.emit('sync', {
      binder_id: post.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.REACT,
      target_type: TargetType.POST_LIKE,
      target_id: postId,
    });

    return { count: await PostDAO.getLikeCount(pool, postId) };
  }

  async unlikePost(postId, context) {
    const post = await PostDAO.findById(pool, postId);
    if (!post) throw new NotFoundError('게시물을 찾을 수 없습니다');

    const member = await BinderDAO.getMember(pool, post.binder_id, context.sender_id);
    if (!member || member.deleted_at) throw new ForbiddenError('바인더 멤버만 좋아요를 취소할 수 있습니다');

    await PostDAO.deleteLike(pool, postId, context.sender_id);

    eventBus.emit('sync', {
      binder_id: post.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.UNREACT,
      target_type: TargetType.POST_LIKE,
      target_id: postId,
    });

    return { count: await PostDAO.getLikeCount(pool, postId) };
  }

  async pinPost(postId, is_pinned, context) {
    const post = await PostDAO.findById(pool, postId);
    if (!post) throw new NotFoundError('게시물을 찾을 수 없습니다');

    const member = await BinderDAO.getMember(pool, post.binder_id, context.sender_id);
    if (!member || member.deleted_at || member.role > 1)
      throw new ForbiddenError('관리자 이상만 게시물을 핀할 수 있습니다');

    const updated = await PostDAO.pinPost(pool, postId, is_pinned);

    eventBus.emit('sync', {
      binder_id: post.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.UPDATE,
      target_type: TargetType.POST,
      target_id: postId,
    });

    return updated;
  }

  async updateComment(commentId, data, context) {
    const comment = await PostDAO.findCommentById(pool, commentId);
    if (!comment) throw new NotFoundError('댓글을 찾을 수 없습니다');
    if (comment.user_id !== context.sender_id) throw new ForbiddenError('본인의 댓글만 수정할 수 있습니다');

    return await PostDAO.updateComment(pool, commentId, data);
  }
}

module.exports = { PostService: new PostService() };
