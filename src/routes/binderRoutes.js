const express = require("express");
const router = express.Router();
const binderController = require("../api/binders/binderController");
const postController = require("../api/posts/postController");
const calendarController = require("../api/calendars/calendarController");
const sectionController = require("../api/sections/sectionController");
const asyncHandler = require('../core/asyncHandler');
const { GroupService } = require('../services/groupService');

// 검색 / 생성
router.get("/", binderController.searchBinders);
router.post("/", binderController.createBinder);

// 초대 토큰으로 가입 (POST /binders/join — /invitations/:code 보다 앞에)
router.post("/join", binderController.joinBinderByInvitation);

// 초대 미리보기 (/:binderId 보다 앞에 등록)
router.get("/invitations/:invitationCode", binderController.getInvitationPreview);

// 단건 조회 / 수정 / 삭제
router.get("/:binderId", binderController.getBinder);
router.patch("/:binderId", binderController.updateBinder);
router.delete("/:binderId", binderController.deleteBinder);

// 바인더 설정 수정 (master 전용)
router.patch("/:binderId/settings", binderController.updateBinderSettings);

// 초대 토큰 발급
router.post("/:binderId/invitations", binderController.issueBinderInvitation);

// 공개 Binder 가입 신청 (api.md:446-521 — RLY-20260806-024)
router.post("/:binderId/join-request", binderController.requestBinderJoin);
router.get("/:binderId/join-requests", binderController.getJoinRequests);
router.patch("/:binderId/join-requests/:requestId", binderController.decideJoinRequest);

// 멤버 목록
router.get("/:binderId/members", binderController.getBinderMembers);

// 멤버 역할 변경 (/:userId/role — /me 보다 앞에 등록 불필요, Express는 static 우선)
router.patch("/:binderId/members/me/nickname", binderController.updateNickname);
router.delete("/:binderId/members/me", binderController.leaveBinder);
router.patch("/:binderId/members/:userId/role", binderController.updateBinderMemberRole);
router.delete("/:binderId/members/:userId", binderController.kickBinderMember);

// 마스터 이전
router.post("/:binderId/members/transfer-master", binderController.transferBinderMaster);

// 알림 환경설정
router.patch("/:binderId/preferences", binderController.updatePreferences);

// Binder Boost
router.get("/:binderId/boost", binderController.getBoost);
router.get("/:binderId/boost/check", binderController.checkBoost);
router.post("/:binderId/boost/verify-purchase", binderController.verifyBoost);
router.patch("/:binderId/boost/transfer", binderController.transferBoost);
router.delete("/:binderId/boost", binderController.cancelBoost);

// 첨부파일
router.get("/:binderId/attachments", binderController.listAttachments);
router.delete("/:binderId/attachments/:attachmentId", binderController.deleteAttachment);

// 게시물
router.get("/:binderId/posts", postController.getPosts);
router.post("/:binderId/posts", (req, res, next) => {
  req.body.binder_id = req.params.binderId;
  postController.create(req, res, next);
});

// 캘린더
router.get("/:binderId/calendars", calendarController.getBinderCalendars);
router.post("/:binderId/calendars", (req, res, next) => {
  req.body.binder_id = req.params.binderId;
  calendarController.create(req, res, next);
});

// 섹션
router.get("/:binderId/sections", sectionController.getSection);
router.post("/:binderId/sections", (req, res, next) => {
  req.body.binder_id = req.params.binderId;
  sectionController.createSection(req, res, next);
});

router.get('/:binderId/groups', asyncHandler(async (req, res) => res.json({ success: true, data: { groups: await GroupService.getGroups(req.params.binderId, req.user_id) } })));
router.post('/:binderId/groups', asyncHandler(async (req, res) => res.status(201).json({ success: true, data: await GroupService.createGroup(req.params.binderId, req.body, req.user_id) })));

// 검색 (binder 내 전체 검색)
router.get("/:binderId/search", binderController.search);

// 캘린더 항목 picker (SC-messaging.md §20-4 — 메시지 링크 카드 대상 선택)
router.get("/:binderId/items", binderController.getItems);

module.exports = router;
