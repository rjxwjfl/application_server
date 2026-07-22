const express = require("express");
const router = express.Router();
const sectionController = require("../api/sections/sectionController");

router.route("/:sectionId")
  .patch(sectionController.updateSection)
  .delete(sectionController.deleteSection);

router.post('/:sectionId/groups', sectionController.connectGroup);
router.delete('/:sectionId/groups/:groupId', sectionController.disconnectGroup);

// Cursor (읽음 위치 갱신)
router.put("/:sectionId/cursor", sectionController.updateCursor);

// Pinned Messages — /:sectionId/messages/:messageId 보다 앞에 등록
router.get("/:sectionId/messages/pinned", sectionController.getPinnedMessages);

// Messages
router.route("/:sectionId/messages")
  .get(sectionController.getMessages)
  .post(sectionController.createMessage);

router.route("/:sectionId/messages/:messageId")
  .patch(sectionController.updateMessage)
  .delete(sectionController.deleteMessage);

router.patch("/:sectionId/messages/:messageId/pin", sectionController.togglePin);

// Files
router.get("/:sectionId/files", sectionController.listFiles);

// Reactions
router.post("/:sectionId/messages/:messageId/reactions", sectionController.addReaction);
router.delete("/:sectionId/messages/:messageId/reactions/:emoji", sectionController.removeReaction);

// Polls
router.get("/:sectionId/messages/:messageId/polls/:pollId", sectionController.getPoll);
router.post("/:sectionId/messages/:messageId/polls/:pollId/vote", sectionController.votePoll);
router.patch("/:sectionId/messages/:messageId/polls/:pollId/close", sectionController.closePoll);

module.exports = router;
