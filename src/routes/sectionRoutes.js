const express = require("express");
const router = express.Router();
const seriesController = require("../api/series/seriesController");

router.route("/:seriesId")
  .patch(seriesController.updateSeries)
  .delete(seriesController.deleteSeries);

// Cursor (읽음 위치 갱신)
router.put("/:seriesId/cursor", seriesController.updateCursor);

// Pinned Messages — /:seriesId/messages/:messageId 보다 앞에 등록
router.get("/:seriesId/messages/pinned", seriesController.getPinnedMessages);

// Messages
router.route("/:seriesId/messages")
  .get(seriesController.getMessages)
  .post(seriesController.createMessage);

router.route("/:seriesId/messages/:messageId")
  .patch(seriesController.updateMessage)
  .delete(seriesController.deleteMessage);

router.patch("/:seriesId/messages/:messageId/pin", seriesController.togglePin);

// Files
router.get("/:seriesId/files", seriesController.listFiles);

// Reactions
router.post("/:seriesId/messages/:messageId/reactions", seriesController.addReaction);
router.delete("/:seriesId/messages/:messageId/reactions/:emoji", seriesController.removeReaction);

// Polls
router.get("/:seriesId/messages/:messageId/polls/:pollId", seriesController.getPoll);
router.post("/:seriesId/messages/:messageId/polls/:pollId/vote", seriesController.votePoll);
router.patch("/:seriesId/messages/:messageId/polls/:pollId/close", seriesController.closePoll);

module.exports = router;
