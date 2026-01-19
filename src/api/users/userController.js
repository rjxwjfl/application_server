const userService = require('../../services/userService');
const { verifyIdToken } = require('../../utils/firebase');

const authenticate = async (req, res, next) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      const error = new Error('idToken이 필요합니다');
      error.status = 400;
      throw error;
    }

    const user = await userService.signUpOrLogin(idToken);

    res.status(200).json({
      success: true,
      data: user,
      message: '인증 성공',
    });
  } catch (error) {
    next(error);
  }
};

const getCurrentUser = async (req, res, next) => {
  try {
    const uid = req.user.uid;
    const user = await userService.getUserByUid(uid);

    res.json({
      success: true,
      data: user,
    });
  } catch (error) {
    next(error);
  }
};

const getPublicProfile = async (req, res, next) => {
  try {
    const { userCode } = req.params;
    const user = await userService.getUserByUserCode(userCode);

    res.json({
      success: true,
      data: user,
    });
  } catch (error) {
    next(error);
  }
};

const updateCurrentUser = async (req, res, next) => {
  try {
    const uid = req.user.uid;
    const { displayName, bio, imageUrl, thumbnailUrl } = req.body;

    const updatedUser = await userService.updateUser(uid, {
      displayName,
      bio,
      imageUrl,
      thumbnailUrl,
    });

    res.json({
      success: true,
      data: updatedUser,
      message: '사용자 정보가 수정되었습니다',
    });
  } catch (error) {
    next(error);
  }
};

const deleteCurrentUser = async (req, res, next) => {
  try {
    const uid = req.user.uid;

    await userService.deleteUser(uid);

    res.json({
      success: true,
      message: '사용자가 탈퇴되었습니다',
    });
  } catch (error) {
    next(error);
  }
};

const registerDevice = async (req, res, next) => {
  try {
    const uid = req.user.uid;

    const user = await userService.getUserByUid(uid);
    const device = await userService.registerDevice(user.id, req.body);

    res.status(201).json({
      success: true,
      data: device,
      message: '기기가 등록되었습니다',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  authenticate,
  getCurrentUser,
  getPublicProfile,
  updateCurrentUser,
  deleteCurrentUser,
  registerDevice,
};
