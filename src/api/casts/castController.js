const { CastService } = require('../../services/castService');
const asyncHandler = require('../../core/asyncHandler');

const castController = {
  getCasts: asyncHandler(async (req, res) => {
    const casts = await CastService.getCasts(req.params.calId, req.query, req.user_id);
    res.json({ success: true, data: casts });
  }),

  getCast: asyncHandler(async (req, res) => {
    const cast = await CastService.getCast(req.params.castId, req.user_id);
    res.json({ success: true, data: cast });
  }),

  create: asyncHandler(async (req, res) => {
    const casts = await CastService.create(req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.status(201).json({ success: true, data: casts, message: '캐스트가 생성되었습니다' });
  }),

  update: asyncHandler(async (req, res) => {
    const cast = await CastService.update(req.params.castId, req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, data: cast, message: '캐스트가 수정되었습니다' });
  }),

  delete: asyncHandler(async (req, res) => {
    await CastService.delete(req.params.castId, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, message: '캐스트가 삭제되었습니다' });
  }),

  // Comments
  getComments: asyncHandler(async (req, res) => {
    const comments = await CastService.getComments(req.params.castId, req.query, req.user_id);
    res.json({ success: true, data: comments });
  }),

  addComment: asyncHandler(async (req, res) => {
    const comment = await CastService.addComment(req.params.castId, req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.status(201).json({ success: true, data: comment, message: '댓글이 작성되었습니다' });
  }),

  updateComment: asyncHandler(async (req, res) => {
    const comment = await CastService.updateComment(req.params.commentId, req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, data: comment, message: '댓글이 수정되었습니다' });
  }),

  deleteComment: asyncHandler(async (req, res) => {
    await CastService.deleteComment(req.params.commentId, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.json({ success: true, message: '댓글이 삭제되었습니다' });
  }),
};

module.exports = castController;
