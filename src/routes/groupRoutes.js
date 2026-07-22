const express = require('express');
const asyncHandler = require('../core/asyncHandler');
const { GroupService } = require('../services/groupService');

const router = express.Router();
router.patch('/:groupId', asyncHandler(async (req, res) => res.json({ success: true, data: await GroupService.updateGroup(req.params.groupId, req.body, req.user_id) })));
router.delete('/:groupId', asyncHandler(async (req, res) => { await GroupService.deleteGroup(req.params.groupId, req.user_id); res.json({ success: true }); }));
router.post('/:groupId/members', asyncHandler(async (req, res) => res.status(201).json({ success: true, data: await GroupService.addMember(req.params.groupId, req.body, req.user_id) })));
router.delete('/:groupId/members/:userId', asyncHandler(async (req, res) => { await GroupService.removeMember(req.params.groupId, req.params.userId, req.user_id); res.json({ success: true }); }));

module.exports = router;
