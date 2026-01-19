
const { DrawerService } = require('../../services/drawerService');

const drawerController = {
  searchDrawers: async (req, res, next) => {
    try {
      const { q } = req.query;

      if (!q) {
        const error = new Error('검색 키워드가 필요합니다');
        error.status = 400;
        throw error;
      }

      const drawers = await DrawerService.searchDrawers(q);

      res.json({
        success: true,
        data: drawers,
      });
    } catch (error) {
      next(error);
    }
  },

  createDrawer: async (req, res, next) => {
    try {
      const uid = req.user.uid;
      const drawer = await DrawerService.createDrawer(uid, req.body);

      res.status(201).json({
        success: true,
        data: drawer,
        message: '서랍이 생성되었습니다',
      });
    } catch (error) {
      next(error);
    }
  },

  issueDrawerInvitation: async (req, res, next) => {
    try {
      const uid = req.user.uid;
      const { drawerId } = req.params;

      const invitation = await DrawerService.issueDrawerInvitation(drawerId, uid);

      res.status(201).json({
        success: true,
        data: invitation,
        message: '초대 토큰이 생성되었습니다',
      });
    } catch (error) {
      next(error);
    }
  },

  getInvitationPreview: async (req, res, next) => {
    try {
      const { invitationCode } = req.params;

      const invitation = await DrawerService.getInvitationPreview(invitationCode);

      res.json({
        success: true,
        data: invitation,
      });
    } catch (error) {
      next(error);
    }
  },

  joinDrawerByInvitation: async (req, res, next) => {
    try {
      const uid = req.user.uid;
      const { invitationCode } = req.body;

      if (!invitationCode) {
        const error = new Error('초대 코드가 필요합니다');
        error.status = 400;
        throw error;
      }

      await DrawerService.joinDrawerByInvitation(invitationCode, uid);

      res.json({
        success: true,
        message: '서랍에 가입되었습니다',
      });
    } catch (error) {
      next(error);
    }
  },

  requestDrawerJoin: async (req, res, next) => {
    try {
      const uid = req.user.uid;
      const { drawerId } = req.params;

      await DrawerService.requestDrawerJoin(drawerId, uid);

      res.status(201).json({
        success: true,
        message: '가입 신청이 완료되었습니다',
      });
    } catch (error) {
      next(error);
    }
  },

  getDrawerMembers: async (req, res, next) => {
    try {
      const { drawerId } = req.params;

      const members = await DrawerService.getDrawerMembers(drawerId);

      res.json({
        success: true,
        data: members,
      });
    } catch (error) {
      next(error);
    }
  },

  updateDrawerMemberRole: async (req, res, next) => {
    try {
      const uid = req.user.uid;
      const { drawerId, userId } = req.params;
      const { role } = req.body;

      if (role === undefined) {
        const error = new Error('역할(role)이 필요합니다');
        error.status = 400;
        throw error;
      }

      await DrawerService.updateDrawerMemberRole(drawerId, userId, role, uid);

      res.json({
        success: true,
        message: '멤버 역할이 수정되었습니다',
      });
    } catch (error) {
      next(error);
    }
  },

  kickDrawerMember: async (req, res, next) => {
    try {
      const uid = req.user.uid;
      const { drawerId } = req.params;
      const { user_id } = req.body;

      if (!user_id) {
        const error = new Error('user_id가 필요합니다');
        error.status = 400;
        throw error;
      }

      await DrawerService.kickDrawerMember(drawerId, user_id, uid);

      res.json({
        success: true,
        message: '멤버가 제거되었습니다',
      });
    } catch (error) {
      next(error);
    }
  },

  leaveDrawer: async (req, res, next) => {
    try {
      const uid = req.user.uid;
      const { drawerId } = req.params;

      await DrawerService.leaveDrawer(drawerId, uid);

      res.json({
        success: true,
        message: '서랍에서 탈퇴되었습니다',
      });
    } catch (error) {
      next(error);
    }
  },

  updateDrawerInfo: async (req, res, next) => {
    try {
      const uid = req.user.uid;
      const { drawerId } = req.params;

      const drawer = await DrawerService.updateDrawerInfo(drawerId, req.body, uid);

      res.json({
        success: true,
        data: drawer,
        message: '서랍 정보가 수정되었습니다',
      });
    } catch (error) {
      next(error);
    }
  },

  updateDrawerSettings: async (req, res, next) => {
    try {
      const uid = req.user.uid;
      const { drawerId } = req.params;

      const settings = await DrawerService.updateDrawerSettings(drawerId, req.body, uid);

      res.json({
        success: true,
        data: settings,
        message: '서랍 설정이 수정되었습니다',
      });
    } catch (error) {
      next(error);
    }
  },

  getJoinRequests: async (req, res, next) => {
    try {
      const uid = req.user.uid;
      const { drawerId } = req.params;

      const requests = await DrawerService.getJoinRequests(drawerId, uid);

      res.json({
        success: true,
        data: requests,
      });
    } catch (error) {
      next(error);
    }
  },

  approveJoinRequest: async (req, res, next) => {
    try {
      const uid = req.user.uid;
      const { drawerId, requestId } = req.params;

      await DrawerService.approveJoinRequest(drawerId, requestId, uid);

      res.json({
        success: true,
        message: '가입 요청이 승인되었습니다',
      });
    } catch (error) {
      next(error);
    }
  },

  rejectJoinRequest: async (req, res, next) => {
    try {
      const uid = req.user.uid;
      const { drawerId, requestId } = req.params;

      await DrawerService.rejectJoinRequest(drawerId, requestId, uid);

      res.json({
        success: true,
        message: '가입 요청이 거절되었습니다',
      });
    } catch (error) {
      next(error);
    }
  },

  transferDrawerMaster: async (req, res, next) => {
    try {
      const uid = req.user.uid;
      const { drawerId } = req.params;
      const { user_id } = req.body;

      if (!user_id) {
        const error = new Error('user_id가 필요합니다');
        error.status = 400;
        throw error;
      }

      await DrawerService.transferDrawerMaster(drawerId, user_id, uid);

      res.json({
        success: true,
        message: '마스터 권한이 이전되었습니다',
      });
    } catch (error) {
      next(error);
    }
  },

  deleteDrawer: async (req, res, next) => {
    try {
      const uid = req.user.uid;
      const { drawerId } = req.params;

      await DrawerService.deleteDrawer(drawerId, uid);

      res.json({
        success: true,
        message: '서랍이 삭제되었습니다',
      });
    } catch (error) {
      next(error);
    }
  },
};

module.exports = drawerController;