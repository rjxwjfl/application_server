const express = require('express');
const router = express.Router();
const castController = require('../api/casts/castController');

router.patch('/:commentId', castController.updateComment);
router.delete('/:commentId', castController.deleteComment);

module.exports = router;
