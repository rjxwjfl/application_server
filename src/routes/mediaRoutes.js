const express = require('express');
const router = express.Router();
const mediaController = require('../api/media/mediaController');

router.post('/presign', mediaController.presign);
router.post('/:id/confirm', mediaController.confirm);

module.exports = router;
