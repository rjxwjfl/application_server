const { PostService } = require('../../services/postService');
const asyncHandler = require('../../core/asyncHandler');

const postController = {
  getPosts: asyncHandler(async (req, res) => {
    const posts = await PostService.getPosts(req.params.binderId, req.query, req.user_id);
    res.json({ success: true, data: posts });
  }),

  getPost: asyncHandler(async (req, res) => {
    const post = await PostService.getPost(req.params.postId, req.user_id);
    res.json({ success: true, data: post });
  }),

  create: asyncHandler(async (req, res) => {
    const post = await PostService.create(req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.status(201).json({ success: true, data: post, message: '게시물이 작성되었습니다' });
  }),

  update: asyncHandler(async (req, res) => {
    const post = await PostService.update(req.params.postId, req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, data: post, message: '게시물이 수정되었습니다' });
  }),

  delete: asyncHandler(async (req, res) => {
    await PostService.delete(req.params.postId, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, message: '게시물이 삭제되었습니다' });
  }),

  // Comments
  getComments: asyncHandler(async (req, res) => {
    const comments = await PostService.getComments(req.params.postId, req.query, req.user_id);
    res.json({ success: true, data: comments });
  }),

  addComment: asyncHandler(async (req, res) => {
    const comment = await PostService.addComment(req.params.postId, req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.status(201).json({ success: true, data: comment, message: '댓글이 작성되었습니다' });
  }),

  deleteComment: asyncHandler(async (req, res) => {
    await PostService.deleteComment(req.params.commentId, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, message: '댓글이 삭제되었습니다' });
  }),

  // Comments
  updateComment: asyncHandler(async (req, res) => {
    const comment = await PostService.updateComment(req.params.commentId, req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, data: comment, message: '댓글이 수정되었습니다' });
  }),

  // Pin
  pinPost: asyncHandler(async (req, res) => {
    const post = await PostService.pinPost(req.params.postId, req.body.is_pinned, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, data: post, message: '핀 상태가 변경되었습니다' });
  }),

  // Likes
  likePost: asyncHandler(async (req, res) => {
    const result = await PostService.likePost(req.params.postId, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, data: result });
  }),

  unlikePost: asyncHandler(async (req, res) => {
    const result = await PostService.unlikePost(req.params.postId, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, data: result });
  }),
};

module.exports = postController;
