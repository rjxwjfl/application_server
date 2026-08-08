const { MessageDAO } = require('../daos/messageDAO');
const { SectionDAO } = require('../daos/sectionDAO');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const pool = require('../../config/db');
const withTransaction = require('../core/withTransaction');
const { NotFoundError, ForbiddenError, BadRequestError, ConflictError } = require('../core/errors');
const { TargetType, ActionType } = require('../utils/typeDefinitions');
const { requireBinderMember } = require('../core/authz');

// RLY-20260806-100 — F7 링크 카드(SC-messaging.md §20-2 L1~L6)의 target_type별 접근 검증.
// L4가 "같은 binder 멤버는 events·tasks·special_days·casts·posts 자동 노출"이라 명시하므로
// (Calendar 도메인은 binder 멤버=자동 접근, Section의 access_scope 게이트와 다름 —
// standards/domain.md §3-6-B·SC-section-manage.md:60-63), 대상이 **이 메시지가 속한 섹션과
// 같은 binder에 있는가**만 확인하면 된다 — 그 이상의 개별 권한 판정이 필요 없다. 발신자가
// 이 binder 멤버라는 것은 createMessage 이전에 SectionService.assertContentAccess가 이미
// 검증한다(section.binder_id가 그 binder). target_type 값은 activity_feeds·audit_logs와
// 동일한 TargetType enum(SCREAMING_SNAKE_CASE)을 그대로 재사용한다 — 새 enum을 만들지 않았다.
const EMBED_TARGET_VALIDATORS = {
  [TargetType.EVENT_INSTANCE]: `
    SELECT 1 FROM event_instances ei
    JOIN events e ON e.id = ei.event_id
    JOIN calendars c ON c.id = e.calendar_id
    WHERE ei.id = $1 AND ei.deleted_at IS NULL AND c.binder_id = $2
  `,
  [TargetType.TASK_INSTANCE]: `
    SELECT 1 FROM task_instances ti
    JOIN tasks t ON t.id = ti.task_id
    JOIN calendars c ON c.id = t.calendar_id
    WHERE ti.id = $1 AND ti.deleted_at IS NULL AND c.binder_id = $2
  `,
  [TargetType.SPECIAL_DAY]: `
    SELECT 1 FROM special_days sd
    JOIN calendars c ON c.id = sd.calendar_id
    WHERE sd.id = $1 AND sd.deleted_at IS NULL AND c.binder_id = $2
  `,
  [TargetType.CAST]: `
    SELECT 1 FROM casts ca
    JOIN calendars c ON c.id = ca.calendar_id
    WHERE ca.id = $1 AND ca.deleted_at IS NULL AND c.binder_id = $2
  `,
  [TargetType.POST]: `
    SELECT 1 FROM posts p
    WHERE p.id = $1 AND p.deleted_at IS NULL AND p.binder_id = $2
  `,
};

// RLY-20260806-103 — SC-messaging.md §20-1 Q2 "핀 한도: 섹션당 5개 고정 — BM tier 무관"·
// §16-12 "초과 시 동작: ✅ 차단 + 사용자 명시 해제"(자동 최고령 unpin 아님). api.md:1902·1908이
// PATCH .../pin에 "섹션당 5개 한도"·"Error 409 — 핀 한도 초과"를 이미 명시(HTTP 409는 기존
// 계약 그대로 사용 — ConflictError). 해제(핀→비핀)는 이 한도 검증을 아예 타지 않는다.
const PIN_LIMIT = 5;

// RLY-20260806-103 — SC-messaging.md §20-2 V1 "TextField 질문(필수·최대 300자)"·
// "ListView 옵션 N개(기본 2개·최대 10개)".
const POLL_QUESTION_MAX_LENGTH = 300;
const POLL_OPTIONS_MIN = 2;
const POLL_OPTIONS_MAX = 10;

class MessageService {
  async getMessages(sectionId, query) {
    const messages = await MessageDAO.getBySectionId(pool, sectionId, query);
    if (messages.length === 0) return [];

    const messageIds = messages.map((m) => m.id);

    const [attachments, embeds, reactions, mentions] = await Promise.all([
      MessageDAO.getAttachmentsByMessageIds(pool, messageIds),
      MessageDAO.getEmbedsByMessageIds(pool, messageIds),
      MessageDAO.getReactionsByMessageIds(pool, messageIds),
      MessageDAO.getMentionsByMessageIds(pool, messageIds),
    ]);

    const groupBy = (arr, key) => arr.reduce((map, item) => {
      (map[item[key]] = map[item[key]] || []).push(item);
      return map;
    }, {});

    const attachMap = groupBy(attachments, 'message_id');
    const embedMap = groupBy(embeds, 'message_id');
    const reactionMap = groupBy(reactions, 'message_id');
    const mentionMap = groupBy(mentions, 'message_id');

    return messages.map((m) => ({
      ...m,
      attachments: attachMap[m.id] || [],
      embeds: embedMap[m.id] || [],
      reactions: reactionMap[m.id] || [],
      mentions: mentionMap[m.id] || [],
    }));
  }

  async createMessage(sectionId, data, context) {
    const section = await SectionDAO.findById(pool, sectionId);
    if (!section) throw new NotFoundError('섹션을 찾을 수 없습니다');

    const messageId = data.id || generateUUID();

    // F-S9b(정정) — 섹션 메시지 첨부는 presign/confirm으로 이미 만들어진 attachments 행을
    // messageDAO.linkAttachments가 링크만 한다. 402 한도 검사·applyStorageDelta는
    // presign/confirm 시점에 이미 끝나 있으므로 여기서 다시 하면 이중 계상이다 — 하지 않는다.
    const result = await withTransaction(async (client) => {
      const message = await MessageDAO.create(client, {
        id: messageId,
        section_id: sectionId,
        user_id: context.sender_id,
        parent_id: data.parent_id,
        content: data.content,
        mention_everyone: data.mention_everyone,
      });

      let attachments = [];
      let embeds = [];
      let mentions = [];
      let poll = null;

      if (data.attachments && data.attachments.length > 0) {
        attachments = await MessageDAO.linkAttachments(client, messageId, section.binder_id, context.sender_id, data.attachments);
      }
      if (data.embeds && data.embeds.length > 0) {
        await this._assertEmbedTargetsAccessible(client, data.embeds, section.binder_id);
        // RLY-20260806-130 — 종단 검증 중 발견(Blocker): 클라 `EmbedRequest` DTO
        // (lib/data/dto/section_message/embed_request.dart)에 `id` 필드가 아예 없다. 그런데
        // `message_embeds.id`는 `UUID NOT NULL PRIMARY KEY`이고 기본값이 없다(config/schema.sql:704)
        // — `MessageDAO.insertEmbeds`가 `e.id`를 그대로 파라미터에 꽂는다. 클라가 실제로 보낼 수
        // 있는 요청(EmbedRequest.toJson())에는 id가 없으므로 이 경로로 만들어지는 모든 임베드
        // (F7 이전부터 있던 link·image·video 포함, F7의 5종도 전부)가 여기서 NOT NULL 위반으로
        // 깨진다 — 기존 회귀(messageEmbedTargetAuthzRegression.test.js)는 fixture가 매번
        // 수동으로 `id`를 채워 넣어 이 공백을 가려 왔다(실제 클라 DTO 형태를 반영하지 않음).
        // 첨부(attachments)는 presign 단계에서 클라가 UUID v7을 미리 생성해 로컬 optimistic
        // 행과 서버 행을 같은 id로 맞춰야 하지만, 임베드는 그 필요가 없다 — 아래 mentions와
        // 정확히 같은 상황(클라가 id를 안 보내는 하위 엔티티)이라 그 처리를 그대로 따른다
        // (data.mention_user_ids.map(... id: generateUUID() ...), 새 패턴을 만들지 않았다).
        const embedsData = data.embeds.map((e) => ({ ...e, id: e.id || generateUUID() }));
        embeds = await MessageDAO.insertEmbeds(client, messageId, embedsData);
      }
      // RLY-20260806-153 — User 판정(가, 2026-08-07): 멘션은 클라가 로컬에 먼저 만들어
      // "@" 강조를 즉시 보여준다 → system.md §10-2 판정 축의 조건①이 참으로 바뀌어 더는
      // 파생물이 아니다(반응과 같은 축). 확정 형태는 `embeds[].id`·`poll.options[].id`와
      // 같은 모양인 `mentions: [{id, user_id}]` — 새 패턴을 만들지 않았다.
      // 하위호환: 구 형태(`mention_user_ids: [uuid, ...]` 평문 배열)도 계속 받는다 — 그
      // 형태는 클라가 애초에 id를 안 보내므로(구버전 클라) 서버가 그대로 발급한다(기존 동작).
      // MessageDAO.insertMentions는 이미 `uid.id || uid`·`uid.user_id || uid`로 문자열·
      // 객체 둘 다 받아들이지만(직접 확인, DAO 미변경) 구 형태를 그 폴백에 맡기면
      // `id === user_id`가 되는 값 없는 행이 생겨(문자열엔 `.id`가 없어 `uid` 자체가 두 자리
      // 모두에 들어간다) 실제 멘션 row id로 부적절하다 — 그래서 구 형태는 여기서 명시적으로
      // `generateUUID()`를 채워 기존 동작을 그대로 유지한다.
      const mentionsInput = data.mentions ?? data.mention_user_ids;
      if (mentionsInput && mentionsInput.length > 0) {
        const mentionData = mentionsInput.map((m) => (
          typeof m === 'string'
            ? { id: generateUUID(), user_id: m }
            : { id: m.id || generateUUID(), user_id: m.user_id }
        ));
        mentions = await MessageDAO.insertMentions(client, messageId, mentionData);
      }
      // RLY-20260806-103 — 투표 생성 경로 자체가 없었다(087·094가 두 번 등재). SC-messaging.md
      // §20-2 V2 시나리오가 "[전송] 트랜잭션: section_messages INSERT + message_polls INSERT +
      // message_poll_options bulk INSERT"를 메시지 생성과 **같은 트랜잭션**으로 명시하고,
      // 클라 MessageCreateRequest에 이미 `poll` 필드(PollRequest)가 있다 — embeds와 동일하게
      // inline 경로로 배선한다. §20-4가 별도 `POST /messages/{id}/poll`도 나열하지만 "메시지
      // 작성 시점에 일괄 포함 가능"인 embeds와 달리 poll은 대안 언급이 없고, V2 시나리오 자체가
      // 단일 트랜잭션을 전제해 별도 endpoint는 만들지 않았다(구현보고서 §근거).
      // 인가는 새로 만들지 않는다 — 이 메서드에 도달했다는 것 자체가 컨트롤러의
      // SectionService.assertContentAccess(§20-1 "투표 작성 권한: member 이상 — 메시지
      // 작성 가능자")를 이미 통과했다는 뜻이다.
      if (data.poll) {
        poll = await this._createPoll(client, messageId, data.poll);
      }

      return { ...message, attachments, embeds, mentions, poll };
    });

    eventBus.emit('sync', {
      binder_id: section.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.CREATE, target_type: TargetType.SECTION_MESSAGE, target_id: messageId,
    });

    // RLY-20260806-153 — 신 형태(data.mentions)로 오면 data.mention_user_ids가 비어 있어 이
    // 알림이 안 나갈 뻔했다 — 위 INSERT 분기와 같은 정규화(data.mentions ?? data.mention_user_ids)
    // 로 target_user_ids를 뽑는다.
    const mentionTargetUserIds = (data.mentions ?? data.mention_user_ids)?.map(
      (m) => (typeof m === 'string' ? m : m.user_id)
    ) || [];
    if (mentionTargetUserIds.length > 0) {
      eventBus.emit('alert', {
        binder_id: section.binder_id,
        sender_id: context.sender_id,
        type: 'mention',
        title: section.title || '',
        body: data.content ? data.content.substring(0, 100) : '메시지에서 멘션되었습니다.',
        target_user_ids: mentionTargetUserIds,
        requiredLevel: 2,
        routeData: { route_type: TargetType.SECTION_MESSAGE, route_id: messageId },
        device_uuid: context.device_uuid,
      });
    }

    return result;
  }

  // RLY-20260806-100 — target_type이 있는 임베드(F7 링크 카드)마다 target_id가 실제로
  // 존재하고 이 메시지가 속한 binder 소속인지 검증한다. 검증 없이 INSERT하면 아무 UUID나
  // 넣어 다른 binder의(권한 없는) 이벤트·태스크·게시글을 링크 카드로 만들 수 있다 — 그
  // 카드 자체는 "권한 없음" placeholder로 렌더되겠지만(L4), target_id 존재 여부·소속
  // binder를 응답 타이밍차·에러 유무로 추론하는 IDOR 탐색 표면 자체를 원천 차단한다.
  // link/image/video(target_type 없음, 기존 임베드)는 검증 대상이 아니다.
  async _assertEmbedTargetsAccessible(client, embeds, binderId) {
    for (const e of embeds) {
      if (!e.target_type) continue;
      const validator = EMBED_TARGET_VALIDATORS[e.target_type];
      if (!validator) throw new BadRequestError(`지원하지 않는 embed target_type입니다: ${e.target_type}`);
      if (!e.target_id) throw new BadRequestError('target_type이 있으면 target_id가 필요합니다');
      const { rowCount } = await client.query(validator, [e.target_id, binderId]);
      if (rowCount === 0) throw new ForbiddenError('링크 카드 대상에 접근할 권한이 없습니다', 'SECTION_ACCESS_DENIED');
    }
  }

  // RLY-20260806-103 — message_polls·message_poll_options INSERT. 094가 이미 파악해 둔
  // 3테이블 관계(투표:옵션:기록)와 어긋나지 않게 한다 — 여기서는 poll·options만 만들고,
  // message_poll_votes(투표 기록)는 건드리지 않는다(재투표 hard delete+재삽입은 기존
  // votePoll 그대로). message_polls.UNIQUE(message_id) 제약이 "메시지당 최대 1 투표"를
  // DB 레벨에서 이미 보장한다 — 이 경로는 새 messageId에만 호출되므로 위반 여지가 없다.
  async _createPoll(client, messageId, pollData) {
    const question = (pollData.question || '').trim();
    if (!question) throw new BadRequestError('투표 질문은 필수입니다');
    if (question.length > POLL_QUESTION_MAX_LENGTH) {
      throw new BadRequestError(`투표 질문은 최대 ${POLL_QUESTION_MAX_LENGTH}자입니다`);
    }

    const options = pollData.options || [];
    if (options.length < POLL_OPTIONS_MIN || options.length > POLL_OPTIONS_MAX) {
      throw new BadRequestError(`투표 옵션은 ${POLL_OPTIONS_MIN}~${POLL_OPTIONS_MAX}개여야 합니다`);
    }
    if (options.some((o) => !o.option_text || !o.option_text.trim())) {
      throw new BadRequestError('투표 옵션 텍스트는 비어 있을 수 없습니다');
    }

    const pollId = pollData.id || generateUUID();
    const pollResult = await client.query(
      `INSERT INTO message_polls (id, message_id, question, allow_multiple, is_anonymous, closes_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), now())
       RETURNING id, message_id, question, allow_multiple, is_anonymous, closes_at, closed_at, created_at, updated_at`,
      [pollId, messageId, question, !!pollData.allow_multiple, !!pollData.is_anonymous, pollData.closes_at || null]
    );
    const poll = pollResult.rows[0];

    const values = [];
    const params = [];
    let idx = 1;
    options.forEach((o, i) => {
      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, now())`);
      params.push(o.id || generateUUID(), pollId, o.option_text.trim(), o.display_order ?? i);
    });
    const optionsResult = await client.query(
      `INSERT INTO message_poll_options (id, poll_id, option_text, display_order, created_at)
       VALUES ${values.join(', ')}
       RETURNING id, poll_id, option_text, display_order, created_at`,
      params
    );

    return { ...poll, options: optionsResult.rows };
  }

  async updateMessage(messageId, data, context) {
    // message는 section_messages 행이라 binder_id 컬럼이 없다 — section을 거쳐 도출한다
    // (deleteMessage와 동일 패턴). data.binder_id는 클라 payload라 신뢰할 수 없다.
    const { binder_id, result } = await withTransaction(async (client) => {
      const message = await MessageDAO.findById(client, messageId);
      if (!message) throw new NotFoundError('메시지를 찾을 수 없습니다');
      if (message.user_id !== context.sender_id) throw new ForbiddenError('본인의 메시지만 수정할 수 있습니다');
      const result = await MessageDAO.update(client, messageId, data);
      const section = await SectionDAO.findById(client, message.section_id);
      return { binder_id: section ? section.binder_id : null, result };
    });

    eventBus.emit('sync', {
      binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.UPDATE, target_type: TargetType.SECTION_MESSAGE, target_id: messageId,
    });

    return result;
  }

  async deleteMessage(messageId, context) {
    const { binder_id } = await withTransaction(async (client) => {
      const message = await MessageDAO.findById(client, messageId);
      if (!message) throw new NotFoundError('메시지를 찾을 수 없습니다');

      const section = await SectionDAO.findById(client, message.section_id);
      if (!section) throw new NotFoundError('섹션을 찾을 수 없습니다');

      // RLY-20260806-111 — api.md:1895 "소프트 삭제. 작성자 또는 master·manager." 가 서버에
      // 전혀 집행되지 않았다(107이 찾아 등재). 107의 togglePin(minRole:1, 예외 없음)과 다르다 —
      // 여기는 **작성자 예외가 있다**(postService.delete·castService.delete와 동일 패턴,
      // `role > 1 && author_id !== sender_id`). requireBinderMember(minRole:1)를 작성자가
      // 아닐 때만 태워 같은 조건을 표현한다 — 새 인가 로직을 설계하지 않았다.
      if (message.user_id !== context.sender_id) {
        await requireBinderMember(client, section.binder_id, context.sender_id, { minRole: 1 });
      }

      await MessageDAO.softDelete(client, messageId);
      return { binder_id: section.binder_id };
    });

    eventBus.emit('sync', {
      binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE, target_type: TargetType.SECTION_MESSAGE, target_id: messageId,
    });
  }

  async togglePin(messageId, context) {
    const { result, binder_id } = await withTransaction(async (client) => {
      const message = await MessageDAO.findById(client, messageId);
      if (!message) throw new NotFoundError('메시지를 찾을 수 없습니다');

      const section = await SectionDAO.findById(client, message.section_id);
      if (!section) throw new NotFoundError('섹션을 찾을 수 없습니다');

      // RLY-20260806-107 — api.md:1902 "핀 토글. master·manager 전용." 이 서버 어디에도
      // 집행되지 않았다(컨트롤러는 SectionService.assertMessageAccess로 콘텐츠 접근만
      // 확인 — role 게이트가 없어 member·editor도 핀을 걸고 뗄 수 있었다). 새 미들웨어를
      // 만들지 않고 기존 requireBinderMember(minRole)를 재사용한다 — role 0=master·
      // 1=manager(숫자가 낮을수록 상위 권한)이므로 minRole:1은 master·manager만 통과.
      await requireBinderMember(client, section.binder_id, context.sender_id, { minRole: 1 });

      // RLY-20260806-103 — 한도는 "지금부터 핀을 거는" 액션에만 적용한다(해제는 무관,
      // §16-12). message.is_pinned는 갱신 전(현재) 값 — 이게 false일 때만 곧 true로
      // 바뀔 액션이므로 이 분기에서만 카운트를 확인한다.
      if (!message.is_pinned) {
        const pinnedCount = await MessageDAO.countPinned(client, message.section_id);
        if (pinnedCount >= PIN_LIMIT) {
          throw new ConflictError(`핀 한도(섹션당 ${PIN_LIMIT}개)를 초과했습니다`, 'PIN_LIMIT_EXCEEDED');
        }
      }

      const result = await MessageDAO.togglePin(client, messageId, context.sender_id);
      return { result, binder_id: section.binder_id };
    });

    eventBus.emit('sync', {
      binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: result.is_pinned ? ActionType.PIN : ActionType.UNPIN, target_type: TargetType.SECTION_MESSAGE, target_id: messageId,
    });

    return result;
  }

  // RLY-20260806-142 — context.origin_uuid는 클라의 X-Origin-UUID 헤더값(로컬에 이미 그 id로
  // 써 둔 반응 행) — 있으면 그대로 쓴다. calendarService.create의 `data.id || generateUUID()`와
  // 같은 관행(클라 id 존중, 없으면 서버 발급 — 하위호환)이지만 여기는 채널이 body가 아니라
  // 헤더라는 점만 다르다(클라가 emoji만 body로 보내므로).
  //
  // RLY-20260806-179 — addReaction·removeReaction 둘 다 eventBus.emit('sync') 자체가 아예
  // 없었다. design_intent.md "이벤트 버스 흐름"·§16-7(H4)이 ActionType 30~33(PIN·UNPIN·
  // REACT·UNREACT)을 "메시징 → 피드 INSERT"로 명시하고 "모든 도메인 이벤트는 audit_logs와
  // activity_feeds 양쪽에 동시 기록된다"고 규정한다 — PIN·UNPIN(togglePin)은 이미 emit하는데
  // REACT·UNREACT만 빠져 있었다(정책 침묵이 아니라 명시된 규정 누락 — 153과 같은 부류).
  // 그 결과 반응 추가·제거가 ①activity_feeds에 안 남고 ②audit_logs에도 안 남고
  // ③다른 기기에 실시간 sync push(FCM SYNC, 2초 디바운스)도 안 갔다 — 다음 정기 pull까지는
  // 아무도 몰랐다. target_type은 TargetType.MESSAGE_REACTION(44, message_reactions 테이블
  // 전용 — design_intent.md TargetType표, PIN처럼 SECTION_MESSAGE를 재사용하지 않는다.
  // PIN은 message_reactions 같은 자기 테이블이 없어(is_pinned 컬럼뿐) SECTION_MESSAGE를
  // 썼지만, REACT는 message_reactions.id라는 실제 PK가 있고 그 전용 TargetType이 이미
  // 정의돼 있다 — 있는 것을 그대로 썼다.
  //
  // ⚠️ addReaction에만 alert(사용자 대면 푸시)도 추가했다 — "발송 정책을 바꾸지 마라"가
  // 아니라 "문서가 이미 규정했는데 emit이 없는" 경우다: SC-notifications.md E17 "target_type=
  // SECTION_MESSAGE(41)+action_type=REACT(32) — Given 내 메시지에 반응 추가됨 Then 섹션
  // 메시징 화면 진입"이 명시돼 있고, notificationService.ALERT_TYPE_MAP에도 이미
  // `reaction: ActionType.REACT`가 있었다(미리 준비돼 있었으나 호출부가 끝내 없었던 것 —
  // 이 자체가 누락의 증거). 메시지 "작성자"에게만 보낸다(mention과 동일하게 explicit
  // target_user_ids, sendAlert의 자기-필터가 자기 메시지 자기 반응은 자동으로 걸러준다).
  // routeData.route_type은 E17이 명시한 그대로 SECTION_MESSAGE(41) — sync/feed의
  // MESSAGE_REACTION과 다른 것이 맞다(라우팅 대상은 "탭하면 이동할 화면"이라 메시지가
  // 맞고, feed/audit의 target_type은 "무엇이 바뀌었는가"라 반응 자체가 맞다 — 둘의
  // 관심사가 다르다). requiredLevel:1(relatedOnly)로 잡았다 — E9가 "본인 작성 메시지의
  // 반응·답글"을 relatedOnly 등급으로 명시한다(mention의 requiredLevel:2/mentionOnly보다
  // 낮은, 더 널리 받는 등급). ⚠️ 단 이 값은 target_user_ids를 명시로 넘기는 현재
  // sendAlert 경로에서 실제로는 참조되지 않는다(getMembersForAlert의 requiredLevel 필터는
  // target_user_ids가 비어 있을 때만 탄다) — mention 등 다른 explicit-target alert도
  // 전부 같은 상태다. 이건 sendAlert 자체의 구조적 공백(수신자 개인의 notification_level을
  // explicit-target 경로가 아예 안 본다)이라 이번 태스크(emit 누락) 범위를 넘어 별도로
  // 보고만 한다 — 여기서 고치지 않았다.
  // 반응 "제거"(removeReaction)는 alert를 추가하지 않았다 — E17은 "추가됨"만 명시한다.
  async addReaction(messageId, emoji, context) {
    const { result, binder_id, authorId, sectionTitle } = await withTransaction(async (client) => {
      const message = await MessageDAO.findById(client, messageId);
      if (!message) throw new NotFoundError('메시지를 찾을 수 없습니다');
      const section = await SectionDAO.findById(client, message.section_id);
      if (!section) throw new NotFoundError('섹션을 찾을 수 없습니다');

      const result = await MessageDAO.addReaction(client, {
        id: context.origin_uuid || generateUUID(),
        message_id: messageId,
        user_id: context.sender_id,
        emoji,
      });
      return { result, binder_id: section.binder_id, authorId: message.user_id, sectionTitle: section.title };
    });

    eventBus.emit('sync', {
      binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.REACT, target_type: TargetType.MESSAGE_REACTION, target_id: result.id,
    });

    eventBus.emit('alert', {
      binder_id,
      sender_id: context.sender_id,
      type: 'reaction',
      title: sectionTitle || '',
      body: `메시지에 ${emoji} 반응이 달렸습니다.`,
      target_user_ids: [authorId],
      requiredLevel: 1,
      routeData: { route_type: TargetType.SECTION_MESSAGE, route_id: messageId },
      device_uuid: context.device_uuid,
    });

    return result;
  }

  async removeReaction(messageId, emoji, context) {
    const { removed, binder_id } = await withTransaction(async (client) => {
      const message = await MessageDAO.findById(client, messageId);
      if (!message) throw new NotFoundError('메시지를 찾을 수 없습니다');
      const section = await SectionDAO.findById(client, message.section_id);
      if (!section) throw new NotFoundError('섹션을 찾을 수 없습니다');

      const removed = await MessageDAO.removeReaction(client, messageId, context.sender_id, emoji);
      return { removed, binder_id: section.binder_id };
    });

    // removed가 null이면(이미 없던/이미 지워진 반응 — 멱등 재시도 등) 실제로 바뀐 게
    // 없으므로 이벤트를 내지 않는다 — 아무 변화 없는 요청까지 활동 피드·sync push를
    // 발생시키지 않는다.
    if (removed) {
      eventBus.emit('sync', {
        binder_id,
        sender_id: context.sender_id,
        device_uuid: context.device_uuid,
        action: ActionType.UNREACT, target_type: TargetType.MESSAGE_REACTION, target_id: removed.id,
      });
    }
  }

  async getPinnedMessages(sectionId) {
    return await MessageDAO.findPinned(pool, sectionId);
  }

  async updateCursor(sectionId, userId, data) {
    await MessageDAO.upsertCursor(pool, sectionId, userId, data);
  }

  async getPoll(messageId, pollId, userId) {
    const result = await pool.query(
      `SELECT p.*, json_agg(
         json_build_object(
           'id', po.id,
           'option_text', po.option_text,
           'display_order', po.display_order,
           'vote_count', (SELECT COUNT(*) FROM message_poll_votes v WHERE v.option_id = po.id),
           'voted_by_me', EXISTS(SELECT 1 FROM message_poll_votes v WHERE v.option_id = po.id AND v.user_id = $3)
         ) ORDER BY po.display_order
       ) AS options
       FROM message_polls p
       JOIN message_poll_options po ON po.poll_id = p.id
       WHERE p.id = $1 AND p.message_id = $2
       GROUP BY p.id`,
      [pollId, messageId, userId]
    );
    const poll = result.rows[0];
    if (!poll) throw new NotFoundError('투표를 찾을 수 없습니다');
    return {
      ...poll,
      total_votes: poll.options.reduce((sum, o) => sum + Number(o.vote_count), 0),
    };
  }

  async votePoll(messageId, pollId, { option_ids }, userId) {
    if (!option_ids || !option_ids.length) throw new BadRequestError('option_ids가 필요합니다');

    await withTransaction(async (client) => {
      const pollResult = await client.query(
        `SELECT allow_multiple, closed_at FROM message_polls WHERE id = $1 AND message_id = $2`,
        [pollId, messageId]
      );
      const poll = pollResult.rows[0];
      if (!poll) throw new NotFoundError('투표를 찾을 수 없습니다');
      if (poll.closed_at) throw new ConflictError('마감된 투표입니다');
      if (!poll.allow_multiple && option_ids.length > 1) throw new ConflictError('단일 선택 투표입니다');

      // message_poll_votes에는 deleted_at이 없다(design_intent.md §message_poll_votes —
      // "단일 선택 시 서비스 레이어가 기존 (poll_id, user_id) 행을 모두 삭제 후 재 INSERT").
      // 재투표는 soft delete가 아니라 hard delete + 재삽입이다.
      await client.query(
        `DELETE FROM message_poll_votes WHERE poll_id = $1 AND user_id = $2`,
        [pollId, userId]
      );
      for (const optionId of option_ids) {
        await client.query(
          `INSERT INTO message_poll_votes (poll_id, option_id, user_id, voted_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (poll_id, option_id, user_id) DO NOTHING`,
          [pollId, optionId, userId]
        );
      }
    });
  }

  // RLY-20260806-111 — api.md:1992 "투표 수동 마감. 작성자 또는 master·manager." 가 서버에
  // 전혀 집행되지 않았다(107이 찾아 등재) — context 파라미터가 아예 미사용이었다.
  // message_polls에는 별도 author 컬럼이 없다(poll은 항상 메시지 생성과 같은 트랜잭션에서만
  // 만들어진다 — 103) — "작성자"는 그 poll이 딸린 메시지의 작성자(message.user_id)다.
  // deleteMessage와 동일 패턴(작성자 예외 + requireBinderMember(minRole:1)).
  async closePoll(messageId, pollId, context) {
    const message = await MessageDAO.findById(pool, messageId);
    if (!message) throw new NotFoundError('메시지를 찾을 수 없습니다');

    if (message.user_id !== context.sender_id) {
      const section = await SectionDAO.findById(pool, message.section_id);
      if (!section) throw new NotFoundError('섹션을 찾을 수 없습니다');
      await requireBinderMember(pool, section.binder_id, context.sender_id, { minRole: 1 });
    }

    const result = await pool.query(
      `UPDATE message_polls SET closed_at = now(), updated_at = now()
       WHERE id = $1 AND message_id = $2
       RETURNING id`,
      [pollId, messageId]
    );
    if (!result.rows[0]) throw new NotFoundError('투표를 찾을 수 없습니다');
  }
}

module.exports = { MessageService: new MessageService() };
