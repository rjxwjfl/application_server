const { BinderService } = require('../../services/binderService');
const asyncHandler = require('../../core/asyncHandler');
const { BadRequestError } = require('../../core/errors');

const binderController = {
  searchBinders: asyncHandler(async (req, res) => {
    const keyword = req.query.keyword || req.query.q;
    if (!keyword) throw new BadRequestError('검색 키워드가 필요합니다');
    const binders = await BinderService.searchBinders(keyword);
    res.json({ success: true, data: binders });
  }),

  createBinder: asyncHandler(async (req, res) => {
    const binder = await BinderService.createBinder(req.body, req.user_id, req.device_uuid);
    res.status(201).json({ success: true, data: binder, message: '바인더가 생성되었습니다' });
  }),

  getBinder: asyncHandler(async (req, res) => {
    const binder = await BinderService.getBinder(req.params.binderId, req.user_id);
    res.json({ success: true, data: binder });
  }),

  updateBinder: asyncHandler(async (req, res) => {
    const result = await BinderService.updateBinder(req.params.binderId, req.body, req.user_id, req.device_uuid);
    res.json({ success: true, data: result, message: '바인더가 수정되었습니다' });
  }),

  deleteBinder: asyncHandler(async (req, res) => {
    await BinderService.deleteBinder(req.params.binderId, req.user_id, req.device_uuid);
    res.json({ success: true, message: '바인더가 삭제되었습니다' });
  }),

  issueBinderInvitation: asyncHandler(async (req, res) => {
    const invitation = await BinderService.issueBinderInvitation(req.params.binderId, req.user_id, req.device_uuid);
    res.status(201).json({ success: true, data: invitation, message: '초대 토큰이 생성되었습니다' });
  }),

  getInvitationPreview: asyncHandler(async (req, res) => {
    const invitation = await BinderService.getInvitationPreview(req.params.invitationCode);
    res.json({ success: true, data: invitation });
  }),

  // 가입 신청 목록 (api.md:474-496) — status/page/limit 쿼리
  getJoinRequests: asyncHandler(async (req, res) => {
    const { status, page, limit } = req.query;
    const result = await BinderService.getJoinRequests(req.params.binderId, req.user_id, { status, page, limit });
    res.json({ success: true, data: result });
  }),

  // 공개 Binder 가입 신청 (api.md:446-461)
  requestBinderJoin: asyncHandler(async (req, res) => {
    const joinRequest = await BinderService.requestBinderJoin(req.params.binderId, req.user_id, req.device_uuid);
    if (joinRequest) {
      res.status(201).json({
        success: true,
        data: { id: joinRequest.id, status: joinRequest.status, expires_at: joinRequest.expires_at },
        message: '가입 신청이 완료되었습니다',
      });
    } else {
      res.status(201).json({ success: true, message: '바인더에 가입되었습니다' });
    }
  }),

  // 가입 신청 승인·거절·차단 (api.md:500-521) — action: approve | reject | block
  decideJoinRequest: asyncHandler(async (req, res) => {
    const { action } = req.body;
    if (!['approve', 'reject', 'block'].includes(action)) {
      throw new BadRequestError('action은 approve|reject|block 중 하나여야 합니다');
    }
    const result = await BinderService.decideJoinRequest(req.params.binderId, req.params.requestId, action, req.user_id, req.device_uuid);
    res.json({ success: true, data: { id: result.id, status: result.status, decided_at: result.decided_at } });
  }),

  getBinderMembers: asyncHandler(async (req, res) => {
    const members = await BinderService.getBinderMembers(req.params.binderId, req.user_id);
    res.json({ success: true, data: members });
  }),

  joinBinderByInvitation: asyncHandler(async (req, res) => {
    const { invitation_code } = req.body;
    if (!invitation_code) throw new BadRequestError('초대 코드가 필요합니다');
    await BinderService.joinBinderByInvitation(invitation_code, req.user_id, req.device_uuid);
    res.json({ success: true, message: '바인더에 가입되었습니다' });
  }),

  updateBinderMemberRole: asyncHandler(async (req, res) => {
    const { binderId, userId } = req.params;
    const { role } = req.body;
    if (role === undefined) throw new BadRequestError('role이 필요합니다');
    await BinderService.updateBinderMemberRole(binderId, userId, role, req.user_id, req.device_uuid);
    res.json({ success: true, message: '멤버 역할이 수정되었습니다' });
  }),

  kickBinderMember: asyncHandler(async (req, res) => {
    const { binderId, userId } = req.params;
    await BinderService.kickBinderMember(binderId, userId, req.user_id, req.device_uuid);
    res.json({ success: true, message: '멤버가 제거되었습니다' });
  }),

  leaveBinder: asyncHandler(async (req, res) => {
    await BinderService.leaveBinder(req.params.binderId, req.user_id, req.device_uuid);
    res.json({ success: true, message: '바인더에서 탈퇴되었습니다' });
  }),

  updateNickname: asyncHandler(async (req, res) => {
    const { nickname } = req.body;
    await BinderService.updateNickname(req.params.binderId, req.user_id, nickname);
    res.json({ success: true, message: '닉네임이 수정되었습니다' });
  }),

  transferBinderMaster: asyncHandler(async (req, res) => {
    const { new_master_id, new_master_user_id } = req.body;
    const targetId = new_master_user_id || new_master_id;
    if (!targetId) throw new BadRequestError('new_master_user_id가 필요합니다');
    await BinderService.transferBinderMaster(req.params.binderId, targetId, req.user_id, req.device_uuid);
    res.json({ success: true, message: '마스터 권한이 이전되었습니다' });
  }),

  updateBinderSettings: asyncHandler(async (req, res) => {
    const result = await BinderService.updateBinder(req.params.binderId, req.body, req.user_id, req.device_uuid);
    res.json({ success: true, data: result, message: '바인더 설정이 수정되었습니다' });
  }),

  updatePreferences: asyncHandler(async (req, res) => {
    const { notification_level } = req.body;
    if (notification_level === undefined) throw new BadRequestError('notification_level이 필요합니다');
    await BinderService.updatePreferences(req.params.binderId, req.user_id, { notification_level });
    res.json({ success: true, message: '환경설정이 업데이트되었습니다' });
  }),

  // Boost
  getBoost: asyncHandler(async (req, res) => {
    const boost = await BinderService.getBoost(req.params.binderId, req.user_id);
    res.json({ success: true, data: boost });
  }),

  checkBoost: asyncHandler(async (req, res) => {
    const result = await BinderService.checkBoost(req.params.binderId, req.user_id);
    res.json({ success: true, data: result });
  }),

  verifyBoost: asyncHandler(async (req, res) => {
    const boost = await BinderService.verifyBoost(req.params.binderId, req.user_id, req.body);
    res.status(201).json({ success: true, data: boost, message: 'Boost가 활성화되었습니다' });
  }),

  transferBoost: asyncHandler(async (req, res) => {
    const boost = await BinderService.transferBoost(req.params.binderId, req.user_id, req.body);
    res.json({ success: true, data: boost });
  }),

  cancelBoost: asyncHandler(async (req, res) => {
    await BinderService.cancelBoost(req.params.binderId, req.user_id);
    res.json({ success: true, message: 'Boost 구독이 취소 예약되었습니다' });
  }),

  // 첨부파일
  listAttachments: asyncHandler(async (req, res) => {
    const files = await BinderService.listAttachments(req.params.binderId, req.query, req.user_id);
    res.json({ success: true, data: files });
  }),

  deleteAttachment: asyncHandler(async (req, res) => {
    await BinderService.deleteAttachment(req.params.binderId, req.params.attachmentId, req.user_id);
    res.json({ success: true, message: '첨부파일이 삭제되었습니다' });
  }),

  search: asyncHandler(async (req, res) => {
    const result = await BinderService.search(req.params.binderId, req.query, req.user_id);
    res.json({ success: true, data: result });
  }),

  // RLY-20260806-128 — SC-messaging.md §20-4 링크 카드 picker.
  getItems: asyncHandler(async (req, res) => {
    const items = await BinderService.getItems(req.params.binderId, req.query, req.user_id);
    res.json({ success: true, data: items });
  }),
};

module.exports = binderController;
