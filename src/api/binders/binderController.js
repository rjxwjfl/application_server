const { DrawerService } = require('../../services/drawerService');
const asyncHandler = require('../../core/asyncHandler');
const { BadRequestError } = require('../../core/errors');

const drawerController = {
  searchDrawers: asyncHandler(async (req, res) => {
    const keyword = req.query.keyword || req.query.q;
    if (!keyword) throw new BadRequestError('검색 키워드가 필요합니다');
    const drawers = await DrawerService.searchDrawers(keyword);
    res.json({ success: true, data: drawers });
  }),

  createDrawer: asyncHandler(async (req, res) => {
    const drawer = await DrawerService.createDrawer(req.body, req.device_uuid);
    res.status(201).json({ success: true, data: drawer, message: '서랍이 생성되었습니다' });
  }),

  getDrawer: asyncHandler(async (req, res) => {
    const drawer = await DrawerService.getDrawer(req.params.drawerId, req.user_id);
    res.json({ success: true, data: drawer });
  }),

  updateDrawer: asyncHandler(async (req, res) => {
    const result = await DrawerService.updateDrawer(req.params.drawerId, req.body, req.user_id);
    res.json({ success: true, data: result, message: '서랍이 수정되었습니다' });
  }),

  deleteDrawer: asyncHandler(async (req, res) => {
    await DrawerService.deleteDrawer(req.params.drawerId, req.user_id);
    res.json({ success: true, message: '서랍이 삭제되었습니다' });
  }),

  issueDrawerInvitation: asyncHandler(async (req, res) => {
    const invitation = await DrawerService.issueDrawerInvitation(req.params.drawerId, req.user_id);
    res.status(201).json({ success: true, data: invitation, message: '초대 토큰이 생성되었습니다' });
  }),

  getInvitationPreview: asyncHandler(async (req, res) => {
    const invitation = await DrawerService.getInvitationPreview(req.params.invitationCode);
    res.json({ success: true, data: invitation });
  }),

  // 가입 신청 목록 (manage GET)
  getJoinRequests: asyncHandler(async (req, res) => {
    const requests = await DrawerService.getJoinRequests(req.params.drawerId, req.user_id);
    res.json({ success: true, data: requests });
  }),

  // 가입 신청 (manage POST)
  requestDrawerJoin: asyncHandler(async (req, res) => {
    await DrawerService.requestDrawerJoin(req.params.drawerId, req.user_id, req.device_uuid);
    res.status(201).json({ success: true, message: '가입 신청이 완료되었습니다' });
  }),

  // 가입 승인 (manage PATCH)
  approveJoinRequest: asyncHandler(async (req, res) => {
    const { request_id } = req.body;
    if (!request_id) throw new BadRequestError('request_id가 필요합니다');
    await DrawerService.approveJoinRequest(req.params.drawerId, request_id, req.user_id);
    res.json({ success: true, message: '가입 신청이 승인되었습니다' });
  }),

  // 가입 거절 (manage DELETE)
  rejectJoinRequest: asyncHandler(async (req, res) => {
    const { request_id } = req.body;
    if (!request_id) throw new BadRequestError('request_id가 필요합니다');
    await DrawerService.rejectJoinRequest(req.params.drawerId, request_id, req.user_id);
    res.json({ success: true, message: '가입 신청이 거절되었습니다' });
  }),

  getDrawerMembers: asyncHandler(async (req, res) => {
    const members = await DrawerService.getDrawerMembers(req.params.drawerId);
    res.json({ success: true, data: members });
  }),

  joinDrawerByInvitation: asyncHandler(async (req, res) => {
    const { invitation_code } = req.body;
    if (!invitation_code) throw new BadRequestError('초대 코드가 필요합니다');
    await DrawerService.joinDrawerByInvitation(invitation_code, req.user_id, req.device_uuid);
    res.json({ success: true, message: '서랍에 가입되었습니다' });
  }),

  updateDrawerMemberRole: asyncHandler(async (req, res) => {
    const { drawerId, userId } = req.params;
    const { role } = req.body;
    if (role === undefined) throw new BadRequestError('role이 필요합니다');
    await DrawerService.updateDrawerMemberRole(drawerId, userId, role, req.user_id);
    res.json({ success: true, message: '멤버 역할이 수정되었습니다' });
  }),

  kickDrawerMember: asyncHandler(async (req, res) => {
    const { drawerId, userId } = req.params;
    await DrawerService.kickDrawerMember(drawerId, userId, req.user_id, req.device_uuid);
    res.json({ success: true, message: '멤버가 제거되었습니다' });
  }),

  leaveDrawer: asyncHandler(async (req, res) => {
    await DrawerService.leaveDrawer(req.params.drawerId, req.user_id, req.device_uuid);
    res.json({ success: true, message: '서랍에서 탈퇴되었습니다' });
  }),

  updateNickname: asyncHandler(async (req, res) => {
    const { nickname } = req.body;
    await DrawerService.updateNickname(req.params.drawerId, req.user_id, nickname);
    res.json({ success: true, message: '닉네임이 수정되었습니다' });
  }),

  transferDrawerMaster: asyncHandler(async (req, res) => {
    const { new_master_id, new_master_user_id } = req.body;
    const targetId = new_master_user_id || new_master_id;
    if (!targetId) throw new BadRequestError('new_master_user_id가 필요합니다');
    await DrawerService.transferDrawerMaster(req.params.drawerId, targetId, req.user_id);
    res.json({ success: true, message: '마스터 권한이 이전되었습니다' });
  }),

  updateDrawerSettings: asyncHandler(async (req, res) => {
    const result = await DrawerService.updateDrawer(req.params.drawerId, req.body, req.user_id);
    res.json({ success: true, data: result, message: '서랍 설정이 수정되었습니다' });
  }),

  updatePreferences: asyncHandler(async (req, res) => {
    const { notification_level } = req.body;
    if (notification_level === undefined) throw new BadRequestError('notification_level이 필요합니다');
    await DrawerService.updatePreferences(req.params.drawerId, req.user_id, { notification_level });
    res.json({ success: true, message: '환경설정이 업데이트되었습니다' });
  }),

  // Boost
  getBoost: asyncHandler(async (req, res) => {
    const boost = await DrawerService.getBoost(req.params.drawerId, req.user_id);
    res.json({ success: true, data: boost });
  }),

  checkBoost: asyncHandler(async (req, res) => {
    const result = await DrawerService.checkBoost(req.params.drawerId, req.user_id);
    res.json({ success: true, data: result });
  }),

  verifyBoost: asyncHandler(async (req, res) => {
    const boost = await DrawerService.verifyBoost(req.params.drawerId, req.user_id, req.body);
    res.status(201).json({ success: true, data: boost, message: 'Boost가 활성화되었습니다' });
  }),

  transferBoost: asyncHandler(async (req, res) => {
    const boost = await DrawerService.transferBoost(req.params.drawerId, req.user_id, req.body);
    res.json({ success: true, data: boost });
  }),

  cancelBoost: asyncHandler(async (req, res) => {
    await DrawerService.cancelBoost(req.params.drawerId, req.user_id);
    res.json({ success: true, message: 'Boost 구독이 취소 예약되었습니다' });
  }),

  // 첨부파일
  listAttachments: asyncHandler(async (req, res) => {
    const files = await DrawerService.listAttachments(req.params.drawerId, req.query, req.user_id);
    res.json({ success: true, data: files });
  }),

  deleteAttachment: asyncHandler(async (req, res) => {
    await DrawerService.deleteAttachment(req.params.drawerId, req.params.attachmentId, req.user_id);
    res.json({ success: true, message: '첨부파일이 삭제되었습니다' });
  }),

  search: asyncHandler(async (req, res) => {
    const result = await DrawerService.search(req.params.drawerId, req.query, req.user_id);
    res.json({ success: true, data: result });
  }),
};

module.exports = drawerController;
