const userService = require('../../services/userService');
const asyncHandler = require('../../core/asyncHandler');

const getUserById = asyncHandler(async (req, res) => {
  // RLY-20260806-066 — 본인/타인 판정을 위해 인증 신원(req.user_id)을 넘긴다.
  const user = await userService.getUserById(req.params.id, req.user_id);
  res.json({ success: true, data: user });
});

const getUserByCode = asyncHandler(async (req, res) => {
  // RLY-20260806-066 — 동일.
  const user = await userService.getUserByUserCode(req.params.code, req.user_id);
  res.json({ success: true, data: user });
});

const updateUser = asyncHandler(async (req, res) => {
  // RLY-20260806-054 — req.params.id를 인증 신원(req.user_id)과 대조하지 않던 IDOR의 수리.
  const updated = await userService.updateUserById(req.params.id, req.body, req.user_id);
  res.json({ success: true, data: updated });
});

const updateSettings = asyncHandler(async (req, res) => {
  await userService.updateSettings(req.user_id, req.body);
  res.json({ success: true, message: '설정이 업데이트되었습니다' });
});

module.exports = { getUserById, getUserByCode, updateUser, updateSettings };
