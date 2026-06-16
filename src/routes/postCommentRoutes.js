const express = require('express');
const router = express.Router();
const postController = require('../api/posts/postController');

router.patch('/:commentId', postController.updateComment);
router.delete('/:commentId', postController.deleteComment);

module.exports = router;
