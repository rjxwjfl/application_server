/**
 * src/routes/drawerRoutes.js
 * =========================================
 * 서랍(Drawer) 관련 라우트 정의
 * 
 * 대부분의 라우트는 인증 필요
 * index.js에서 firebaseAuth 미들웨어가 적용됨
 * 
 * 예외:
 * - GET /invitations/:invitationCode (공개 초대 미리보기)
 * =========================================
 */

const express = require('express');
const router = express.Router();
const drawerController = require('../api/drawers/drawerController');
const { firebaseAuth } = require('../utils/authMiddleware');

/**
 * Protected 라우트 (인증 필요)
 * index.js에서 이미 firebaseAuth 미들웨어가 적용됨
 */
router.get('/search', drawerController.searchDrawers);
router.post('/', drawerController.createDrawer);

router.post('/:drawerId/invitations', drawerController.issueDrawerInvitation);
router.post('/join', drawerController.joinDrawerByInvitation);

router.post('/:drawerId/requests', drawerController.requestDrawerJoin);
router.get('/:drawerId/requests', drawerController.getJoinRequests);
router.patch('/:drawerId/requests/:requestId', drawerController.approveJoinRequest);
router.delete('/:drawerId/requests/:requestId', drawerController.rejectJoinRequest);

router.get('/:drawerId/members', drawerController.getDrawerMembers);
router.patch('/:drawerId/users/:userId', drawerController.updateDrawerMemberRole);
router.delete('/:drawerId/users', drawerController.kickDrawerMember);

router.patch('/:drawerId/info', drawerController.updateDrawerInfo);
router.patch('/:drawerId/settings', drawerController.updateDrawerSettings);
router.patch('/:drawerId/master', drawerController.transferDrawerMaster);
router.delete('/:drawerId', drawerController.deleteDrawer);

/**
 * Public 라우트 (인증 불필요)
 * 재사용 가능한 초대 링크 미리보기
 */
router.get('/invitations/:invitationCode', drawerController.getInvitationPreview);

module.exports = router;
