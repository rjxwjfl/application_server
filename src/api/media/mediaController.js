const { MediaService } = require('../../services/mediaService');
const asyncHandler = require('../../core/asyncHandler');

const mediaController = {
  presign: asyncHandler(async (req, res) => {
    const result = await MediaService.presign(req.body, { sender_id: req.user_id, device_uuid: req.device_uuid });
    res.status(201).json({ success: true, data: result });
  }),

  confirm: asyncHandler(async (req, res) => {
    const attachment = await MediaService.confirm(req.params.id, { sender_id: req.user_id });
    res.status(201).json({ success: true, data: attachment, message: '파일 업로드가 확인되었습니다' });
  }),

  getSignedUrl: asyncHandler(async (req, res) => {
    const result = await MediaService.getSignedUrl(req.params.id, req.user_id);
    res.json({ success: true, data: result });
  }),

  deleteAttachment: asyncHandler(async (req, res) => {
    await MediaService.deleteAttachment(req.params.id, req.user_id);
    res.status(204).send();
  }),
};

module.exports = mediaController;
