const express = require('express');
const userController = require('../api/users/userController');
const router = express.Router();

router.get('/code/:code', userController.getUserByCode);
router.patch('/settings', userController.updateSettings);
router.get('/:id', userController.getUserById);
router.patch('/:id', userController.updateUser);

module.exports = router;
