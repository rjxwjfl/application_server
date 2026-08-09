const authService = require("../../services/authService");
const asyncHandler = require("../../core/asyncHandler");

const getMe = asyncHandler(async (req, res) => {
  const result = await authService.getMe(req.user.uid);
  res.json({ success: true, data: result });
});

const register = asyncHandler(async (req, res) => {
  // 가입 트랜잭션이 만든 기본 바인더도 그대로 전달한다. 여기서 binder를 버리면
  // 클라이언트는 사용자는 저장했지만 초기 바인더를 복원할 수 없어 첫 실행이 실패한다.
  const { user, settings, binder } = await authService.register(req.user, req.body);
  res.status(201).json({ success: true, data: { user, settings, binder }, message: "사용자가 등록되었습니다" });
});

const updateMe = asyncHandler(async (req, res) => {
  const updatedUser = await authService.updateMe(req.user.uid, req.body);
  res.json({ success: true, data: updatedUser, message: "사용자 정보가 수정되었습니다" });
});

const deleteMe = asyncHandler(async (req, res) => {
  await authService.deleteMe(req.user.uid);
  res.json({ success: true, message: "사용자가 탈퇴되었습니다" });
});

const registerDevice = asyncHandler(async (req, res) => {
  const device = await authService.registerDevice(req.user.uid, req.body);
  res.status(201).json({ success: true, data: device, message: "기기가 등록되었습니다" });
});

const updateProfileImage = asyncHandler(async (req, res) => {
  const updated = await authService.updateProfileImage(req.user.uid, req.body);
  res.json({ success: true, data: updated, message: "프로필 이미지가 수정되었습니다" });
});

const logout = asyncHandler(async (req, res) => {
  await authService.logout(req.user.uid, req.device_uuid);
  res.json({ success: true, message: "로그아웃 되었습니다" });
});

const reactivate = asyncHandler(async (req, res) => {
  const result = await authService.reactivate(req.user.uid, req.body);
  res.json({ success: true, data: result, message: "계정이 복구되었습니다" });
});

const getDevices = asyncHandler(async (req, res) => {
  const devices = await authService.getDevices(req.user.uid);
  res.json({ success: true, data: devices });
});

const removeDevice = asyncHandler(async (req, res) => {
  await authService.removeDevice(req.user.uid, req.params.deviceUuid || req.params.uuid);
  res.json({ success: true, message: "기기가 제거되었습니다" });
});

const updateSettings = asyncHandler(async (req, res) => {
  const settings = await authService.updateSettings(req.user_id, req.body);
  res.json({ success: true, data: settings, message: "설정이 수정되었습니다" });
});

module.exports = { getMe, register, updateMe, deleteMe, registerDevice, updateProfileImage, logout, reactivate, getDevices, removeDevice, updateSettings };
