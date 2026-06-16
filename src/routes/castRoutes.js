const express = require('express');
const router = express.Router();
const castController = require('../api/casts/castController');

// 캐스트 CRUD
router.get('/:castId', castController.getCast);
router.post('/', castController.create);
router.patch('/:castId', castController.update);
router.delete('/:castId', castController.delete);

// 댓글
router.get('/:castId/comments', castController.getComments);
router.post('/:castId/comments', castController.addComment);

module.exports = router;
