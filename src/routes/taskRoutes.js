const express = require("express");
const router = express.Router();
const taskController = require("../api/tasks/taskController");

router.post("/", taskController.createTask);

router.get("/:taskId", taskController.getTask);
router.patch("/:taskId", taskController.updateTask);
router.delete("/:taskId", taskController.deleteTask);

router.patch("/:taskId/instances/:instanceId", taskController.updateTaskInstance);
router.delete("/:taskId/instances/:instanceId", taskController.deleteTaskInstance);
router.post("/:taskId/instances/:instanceId/split", taskController.splitTask);

router.post("/:taskId/instances/:instanceId/participants", taskController.adjustParticipants);
router.patch("/:taskId/instances/:instanceId/participants/me", taskController.updateMyParticipation);
router.delete("/:taskId/instances/:instanceId/participants/:userId", taskController.removeParticipant);

module.exports = router;
