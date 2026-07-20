const express = require("express");
const router = express.Router();
const eventController = require("../api/events/eventController");

router.post("/", eventController.createEvent);

router.get("/:eventId", eventController.getEvent);
router.patch("/:eventId", eventController.updateEvent);
router.delete("/:eventId", eventController.deleteEvent);

router.patch("/:eventId/instances/:instanceId", eventController.updateEventInstance);
router.delete("/:eventId/instances/:instanceId", eventController.deleteEventInstance);
router.post("/:eventId/instances/:instanceId/split", eventController.splitEvent);

router.post("/:eventId/instances/:instanceId/participants", eventController.addParticipant);
router.patch("/:eventId/instances/:instanceId/participants/:userId", eventController.updateParticipantState);
router.delete("/:eventId/instances/:instanceId/participants/:userId", eventController.removeParticipant);

module.exports = router;
