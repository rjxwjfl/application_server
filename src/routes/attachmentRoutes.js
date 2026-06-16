const express = require('express');
const router = express.Router();
const mediaController = require('../api/media/mediaController');

// Presigned URL 발급 (설계: POST /attachments/presign)
router.post('/presign', mediaController.presign);

// 업로드 완료 확인 (설계: POST /attachments/:id/confirm)
router.post('/:id/confirm', mediaController.confirm);

// 원본 파일 Signed URL 발급
router.get('/:id/url', mediaController.getSignedUrl);

// 첨부파일 삭제
router.delete('/:id', mediaController.deleteAttachment);

module.exports = router;
