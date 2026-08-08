const { SectionDAO } = require('../daos/sectionDAO');
const { AttachmentDAO } = require('../daos/attachmentDAO');
const { BinderDAO } = require('../daos');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const pool = require('../../config/db');
const withTransaction = require('../core/withTransaction');
const { NotFoundError, BadRequestError, ForbiddenError } = require('../core/errors');
const { TargetType, ActionType } = require('../utils/typeDefinitions');

class SectionService {
  async getSectionByBinderId(binderId, userId) {
    const member = await BinderDAO.getMember(pool, binderId, userId);
    if (!member || member.deleted_at) throw new ForbiddenError('바인더 멤버만 섹션을 조회할 수 있습니다');
    return await SectionDAO.findByBinderId(pool, binderId, userId);
  }

  // RLY-20260806-187 — User 판정: 공개 섹션(access_scope=0)은 editor 이상, 비공개(=1)는
  // manager 이상을 그대로 유지한다(D4 확정 정책 — 비공개는 완화 대상이 아니다). scope에 따라
  // 문턱이 갈리므로 scope를 먼저 확정(기존 검증 그대로: 미전송 시 기본값 0=공개, 0·1이
  // 아니면 400 — 이 문턱을 그대로 통과한 값만 아래 역할 검사에 쓴다. "모르는 값이면
  // 느슨한 쪽으로 실패" 문제 자체가 여기서 원천 차단된다 — 0·1 외 값은 역할 검사 도달 전에
  // 이미 400으로 끝난다).
  async createSection(data, context) {
    const section = await withTransaction(async (client) => {
      const actor = await BinderDAO.getMember(client, data.binder_id, context.sender_id);
      if (!actor || actor.deleted_at) throw new ForbiddenError('바인더 멤버만 섹션을 만들 수 있습니다');
      if (Object.prototype.hasOwnProperty.call(data, 'group_id')) throw new BadRequestError('group_id는 지원하지 않습니다');
      const scope = data.access_scope ?? 0;
      if (![0, 1].includes(scope)) throw new BadRequestError('access_scope는 0 또는 1이어야 합니다');
      const minRole = scope === 1 ? 1 : 2; // 비공개=manager(1) 이상, 공개=editor(2) 이상
      if (actor.role > minRole) {
        throw new ForbiddenError(scope === 1 ? 'manager 이상 권한이 필요합니다' : '편집자 이상 권한이 필요합니다');
      }
      const created = await SectionDAO.create(client, {
        id: data.id || generateUUID(),
        binder_id: actor.binder_id,
        title: data.title,
        access_scope: scope,
      });
      if (scope === 1) await SectionDAO.addMember(client, created.id, context.sender_id, generateUUID());
      return created;
    });

    eventBus.emit('sync', {
      binder_id: section.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.CREATE, target_type: TargetType.SECTION, target_id: section.id,
    });

    return section;
  }

  async updateSection(sectionId, updateData, context) {
    const { section, result } = await withTransaction(async (client) => {
      const section = await SectionDAO.findById(client, sectionId, true);
      if (!section) throw new NotFoundError('섹션을 찾을 수 없습니다');
      const actor = await BinderDAO.getMember(client, section.binder_id, context.sender_id);
      if (!actor || actor.deleted_at || actor.role > 1) throw new ForbiddenError('manager 이상 권한이 필요합니다');
      if (Object.keys(updateData).some((key) => key !== 'title')) {
        throw new BadRequestError('수정 가능한 필드는 title뿐입니다');
      }
      const result = await SectionDAO.update(client, sectionId, updateData);
      return { section, result };
    });

    eventBus.emit('sync', {
      binder_id: section.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.UPDATE, target_type: TargetType.SECTION, target_id: sectionId,
    });

    return result;
  }

  async deleteSection(sectionId, context) {
    const { binder_id } = await withTransaction(async (client) => {
      const section = await SectionDAO.findById(client, sectionId);
      if (!section) throw new NotFoundError('섹션을 찾을 수 없습니다');
      if (section.is_default) throw new BadRequestError('기본 섹션은 삭제할 수 없습니다');
      const actor = await BinderDAO.getMember(client, section.binder_id, context.sender_id);
      if (!actor || actor.deleted_at || actor.role > 1) throw new ForbiddenError('manager 이상 권한이 필요합니다');

      await SectionDAO.softDelete(client, sectionId);
      return { binder_id: section.binder_id };
    });

    eventBus.emit('sync', {
      binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE, target_type: TargetType.SECTION, target_id: sectionId,
    });
  }

  // RLY-20260806-156 — User 판정("즉시 표시가 기본, 포기는 예외")에 따라 클라가 낙관적으로
  // 붙이기 전에 서버를 미리 준비한다. 로컬 section_members에도 uq_section_members_active
  // (section_id,user_id) WHERE deleted_at IS NULL 파샬 유니크가 이미 있어(143 확인) 멘션·
  // 반응과 같은 함정이 성립할 수 있다 — 지금은 클라가 낙관적 로컬 삽입을 안 해서(addMembers가
  // enqueueRequest만 하고 _dao 로컬 쓰기가 없음, section_repository.dart:153-171 확인) 터지지
  // 않을 뿐이다. `members: [{id, user_id}]`(embeds[]·mentions와 동일 모양)를 새로 받고, 구
  // 형태(`user_ids: [uuid]` 평문 배열)도 하위호환으로 받는다 — 새 패턴을 만들지 않았다.
  async addMembers(sectionId, membersInput, context) {
    if (!Array.isArray(membersInput) || membersInput.length === 0) throw new BadRequestError('user_ids 배열이 필요합니다');
    // clientId — "클라가 실제로 이 id를 원한다"는 명시적 의도만 담는다(신 형태에서만 존재).
    // id — 신규 INSERT 경로에 항상 필요한 값(신 형태면 clientId와 동일, 구 형태면 서버 발급).
    const normalized = membersInput.map((m) => (
      typeof m === 'string'
        ? { id: generateUUID(), user_id: m, clientId: null }             // 구 형태 — 서버가 발급(기존 동작 유지)
        : { id: m.id || generateUUID(), user_id: m.user_id, clientId: m.id || null } // 신 형태 — 클라 id 존중
    ));
    // user_id 기준 중복 제거 — 신 형태는 객체라 Set으로 못 거른다(참조가 매번 달라 중복이
    // 하나도 안 걸러짐). 값(user_id) 기준으로 직접 거른다.
    const seen = new Set();
    const uniqueMembers = normalized.filter((m) => (seen.has(m.user_id) ? false : (seen.add(m.user_id), true)));

    const result = await withTransaction(async (client) => {
      const section = await SectionDAO.findById(client, sectionId, true);
      if (!section) throw new NotFoundError('섹션을 찾을 수 없습니다');
      const actor = await BinderDAO.getMember(client, section.binder_id, context.sender_id);
      if (!actor || actor.deleted_at || actor.role > 1) throw new ForbiddenError('manager 이상 권한이 필요합니다');
      if (section.access_scope !== 1) throw new BadRequestError('public 섹션에는 멤버를 추가할 수 없습니다');
      const added = [];
      for (const m of uniqueMembers) {
        const target = await BinderDAO.getMember(client, section.binder_id, m.user_id);
        if (!target || target.deleted_at) throw new BadRequestError('모든 user_id는 활성 바인더 멤버여야 합니다');
        // RLY-20260806-159 — "복원(restored)" 경로도 이제 clientId가 있으면 그 id로 반영한다
        // (section_members.id는 참조하는 FK·폴리모픽 target_id가 없어 안전하다고 확인했다 —
        // sectionDAO.js addMember 주석 참조). clientId가 null(구 형태)이면 기존 id를 그대로
        // 둔다(하위호환).
        if (await SectionDAO.addMember(client, sectionId, m.user_id, m.id, m.clientId)) added.push(m.user_id);
      }
      return { binderId: section.binder_id, added_user_ids: added, member_count: await SectionDAO.countMembers(client, sectionId) };
    });
    eventBus.emit('sync', { binder_id: result.binderId, sender_id: context.sender_id, device_uuid: context.device_uuid,
      action: ActionType.UPDATE, target_type: TargetType.SECTION, target_id: sectionId });
    return { added_user_ids: result.added_user_ids, member_count: result.member_count };
  }

  async removeMember(sectionId, userId, context) {
    const result = await withTransaction(async (client) => {
      const section = await SectionDAO.findById(client, sectionId, true);
      if (!section) throw new NotFoundError('섹션을 찾을 수 없습니다');
      const actor = await BinderDAO.getMember(client, section.binder_id, context.sender_id);
      if (!actor || actor.deleted_at || actor.role > 1) throw new ForbiddenError('manager 이상 권한이 필요합니다');
      if (section.access_scope !== 1) throw new BadRequestError('public 섹션에는 멤버가 없습니다');
      await SectionDAO.removeMember(client, sectionId, userId);
      const memberCount = await SectionDAO.countMembers(client, sectionId);
      const sectionDeleted = memberCount === 0 ? await SectionDAO.softDelete(client, sectionId) : false;
      return { binderId: section.binder_id, removed_user_id: userId, member_count: memberCount, section_deleted: sectionDeleted };
    });
    eventBus.emit('sync', { binder_id: result.binderId, sender_id: context.sender_id, device_uuid: context.device_uuid,
      action: ActionType.UPDATE, target_type: TargetType.SECTION, target_id: sectionId });
    return { removed_user_id: result.removed_user_id, member_count: result.member_count, section_deleted: result.section_deleted };
  }

  async listFiles(sectionId, query, userId) {
    const section = await SectionDAO.findById(pool, sectionId);
    if (!section) throw new NotFoundError('섹션을 찾을 수 없습니다');

    await this.assertContentAccess(sectionId, userId);

    return await AttachmentDAO.findBySection(pool, sectionId, query);
  }

  async assertContentAccess(sectionId, userId) {
    if (!(await SectionDAO.hasAccess(pool, sectionId, userId))) throw new ForbiddenError('섹션 콘텐츠 접근 권한이 없습니다', 'SECTION_ACCESS_DENIED');
  }

  async assertMessageAccess(messageId, userId) {
    const sectionId = await SectionDAO.findSectionIdByMessage(pool, messageId);
    if (!sectionId) throw new NotFoundError('메시지를 찾을 수 없습니다');
    return this.assertContentAccess(sectionId, userId);
  }

}

module.exports = { SectionService: new SectionService() };
