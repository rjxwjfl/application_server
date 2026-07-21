const express = require("express");
const router = express.Router();
const drawerController = require("../api/drawers/drawerController");
const postController = require("../api/posts/postController");
const calendarController = require("../api/calendars/calendarController");
const seriesController = require("../api/series/seriesController");

// 검색 / 생성
router.get("/", drawerController.searchDrawers);
router.post("/", drawerController.createDrawer);

// 초대 토큰으로 가입 (POST /drawers/join — /invitations/:code 보다 앞에)
router.post("/join", drawerController.joinDrawerByInvitation);

// 초대 미리보기 (/:drawerId 보다 앞에 등록)
router.get("/invitations/:invitationCode", drawerController.getInvitationPreview);

// 단건 조회 / 수정 / 삭제
router.get("/:drawerId", drawerController.getDrawer);
router.patch("/:drawerId", drawerController.updateDrawer);
router.delete("/:drawerId", drawerController.deleteDrawer);

// 서랍 설정 수정 (master 전용)
router.patch("/:drawerId/settings", drawerController.updateDrawerSettings);

// 초대 토큰 발급
router.post("/:drawerId/invitations", drawerController.issueDrawerInvitation);

// 공개 Drawer 가입 신청
router.post("/:drawerId/join-request", drawerController.requestDrawerJoin);

// 가입 신청 관리 (미설계 라우트 — 관리자용 유지)
router.get("/:drawerId/join-requests", drawerController.getJoinRequests);
router.patch("/:drawerId/join-requests/approve", drawerController.approveJoinRequest);
router.delete("/:drawerId/join-requests/reject", drawerController.rejectJoinRequest);

// 멤버 목록
router.get("/:drawerId/members", drawerController.getDrawerMembers);

// 멤버 역할 변경 (/:userId/role — /me 보다 앞에 등록 불필요, Express는 static 우선)
router.patch("/:drawerId/members/me/nickname", drawerController.updateNickname);
router.delete("/:drawerId/members/me", drawerController.leaveDrawer);
router.patch("/:drawerId/members/:userId/role", drawerController.updateDrawerMemberRole);
router.delete("/:drawerId/members/:userId", drawerController.kickDrawerMember);

// 마스터 이전
router.post("/:drawerId/members/transfer-master", drawerController.transferDrawerMaster);

// 알림 환경설정
router.patch("/:drawerId/preferences", drawerController.updatePreferences);

// Drawer Boost
router.get("/:drawerId/boost", drawerController.getBoost);
router.get("/:drawerId/boost/check", drawerController.checkBoost);
router.post("/:drawerId/boost/verify-purchase", drawerController.verifyBoost);
router.patch("/:drawerId/boost/transfer", drawerController.transferBoost);
router.delete("/:drawerId/boost", drawerController.cancelBoost);

// 첨부파일
router.get("/:drawerId/attachments", drawerController.listAttachments);
router.delete("/:drawerId/attachments/:attachmentId", drawerController.deleteAttachment);

// 게시물
router.get("/:drawerId/posts", postController.getPosts);
router.post("/:drawerId/posts", (req, res, next) => {
  req.body.drawer_id = req.params.drawerId;
  postController.create(req, res, next);
});

// 캘린더
router.get("/:drawerId/calendars", calendarController.getDrawerCalendars);
router.post("/:drawerId/calendars", (req, res, next) => {
  req.body.drawer_id = req.params.drawerId;
  calendarController.create(req, res, next);
});

// 시리즈
router.get("/:drawerId/series", seriesController.getSeries);
router.post("/:drawerId/series", (req, res, next) => {
  req.body.drawer_id = req.params.drawerId;
  seriesController.createSeries(req, res, next);
});

// 검색 (drawer 내 전체 검색)
router.get("/:drawerId/search", drawerController.search);

module.exports = router;
