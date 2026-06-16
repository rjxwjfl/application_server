const express = require('express');
const router = express.Router();
const postController = require('../api/posts/postController');

// 게시물 단건 조회 / 수정 / 삭제 (생성은 /drawers/:drawerId/posts)
router.get('/:postId', postController.getPost);
router.patch('/:postId', postController.update);
router.delete('/:postId', postController.delete);

// 핀
router.patch('/:postId/pin', postController.pinPost);

// 댓글
router.get('/:postId/comments', postController.getComments);
router.post('/:postId/comments', postController.addComment);
router.patch('/:postId/comments/:commentId', postController.updateComment);
router.delete('/:postId/comments/:commentId', postController.deleteComment);

// 좋아요
router.post('/:postId/likes', postController.likePost);
router.delete('/:postId/likes', postController.unlikePost);

module.exports = router;
