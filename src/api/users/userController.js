const userService = require('../../services/userService');
const asyncHandler = require('../../core/asyncHandler');

const getUserById = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.params.id);
  res.json({ success: true, data: user });
});

const getUserByCode = asyncHandler(async (req, res) => {
  const user = await userService.getUserByUserCode(req.params.code);
  res.json({ success: true, data: user });
});

const updateUser = asyncHandler(async (req, res) => {
  const updated = await userService.updateUserById(req.params.id, req.body);
  res.json({ success: true, data: updated });
});

const updateSettings = asyncHandler(async (req, res) => {
  await userService.updateSettings(req.user_id, req.body);
  res.json({ success: true, message: '설정이 업데이트되었습니다' });
});

module.exports = { getUserById, getUserByCode, updateUser, updateSettings };
