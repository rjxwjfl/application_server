const { SyncDAO } = require('../daos/syncDAO');
const { UserSettingsDAO } = require('../daos/userSettingsDAO');
const pool = require('../../config/db');
const SyncToken = require('../utils/syncToken');
const logger = require('../utils/logger');

const CALENDAR_PAST_DAYS = 90;
const CALENDAR_FUTURE_DAYS = 365;
const MESSAGING_PAST_DAYS = 30;

// 고속 차집합 연산 유틸
function diff(currArray, oldArray) {
  const oldSet = new Set(oldArray);
  return currArray.filter(x => !oldSet.has(x));
}

class SyncService {
  /**
   * [Core Sync] 앱 기동 및 포그라운드 전환 시 호출되는 메인 동기화 파이프라인
   */
  async pullChanges(userId, rawToken) {
    const now = new Date();
    
    // Time Windows 계산
    const calWindowFrom = new Date(now.getTime() - (CALENDAR_PAST_DAYS * 24 * 60 * 60 * 1000));
    const calWindowTo = new Date(now.getTime() + (CALENDAR_FUTURE_DAYS * 24 * 60 * 60 * 1000));
    const msgWindowFrom = new Date(now.getTime() - (MESSAGING_PAST_DAYS * 24 * 60 * 60 * 1000));

    // 1. 토큰 디코딩
    const prevToken = SyncToken.decode(rawToken) || { ts: 0, d_ids: [], c_ids: [], s_ids: [] };
    const previousSectionIds = Array.isArray(prevToken.s_ids) ? prevToken.s_ids : [];
    const oldTsDate = prevToken.ts > 0 ? new Date(prevToken.ts * 1000) : null;

    // 2. 현재 유저의 '진짜' 권한 조회 (DB 기준)
    const [currDIds, currCIds] = await Promise.all([
      SyncDAO.getBinderIdsByUserId(pool, userId),
      SyncDAO.getSubscribedCalIdsByUserId(pool, userId),
    ]);

    if (!currDIds.length && !currCIds.length) {
      // 바인더·캘린더가 모두 0개가 된 유저(=마지막 바인더에서 삭제·강퇴·탈퇴로 밀려난 경우 포함) —
      // 아래 일반 경로와 똑같이 정리 목록을 실어야 한다(RLY-20260806-039). 그렇지 않으면 "잃은
      // 마지막 하나"만 이 조기 반환 경로로 빠져 정리 목록에서 영원히 누락되는 사각지대가 생긴다.
      return this._buildEmptyResponse(now, currDIds, currCIds, prevToken, previousSectionIds);
    }

    // 3. Sync Context (상태 Diff) 객체 생성 - 이 객체 하나로 모든 DAO 쿼리가 동작합니다.
    const ctx = {
      userId,
      oldTs: oldTsDate,
      oldDIds: prevToken.d_ids.filter(id => currDIds.includes(id)), // 유지된 기존 바인더
      oldCIds: prevToken.c_ids.filter(id => currCIds.includes(id)), // 유지된 기존 캘린더
      newDIds: diff(currDIds, prevToken.d_ids), // 새로 가입한 바인더
      newCIds: diff(currCIds, prevToken.c_ids), // 새로 구독한 캘린더
      currDIds, // RLY-20260806-078 — getMessageAttachments가 부모 messageIds 없이도 인가
      // 경계(현재 접근 가능한 바인더 전체)를 판정할 수 있어야 해서 추가. 동기화 토큰(ts·d_ids·
      // c_ids·s_ids)과는 무관한 내부 ctx 필드다 — oldDIds∪newDIds와 값은 같지만 이미 위에서
      // 계산된 currDIds를 그대로 재사용한다(새로 파생하지 않음).
      calWindowFrom,
      calWindowTo,
      msgWindowFrom
    };

    // ACL은 콘텐츠보다 먼저 읽어 revoke tombstone이 새 접근 필터에 가려지지 않게 한다.
    const metaData = await this._fetchTrackAMeta(
      userId,
      currDIds,
      currCIds,
      oldTsDate,
      previousSectionIds
    );
    const accessibleSectionIds = await SyncDAO.getAccessibleSectionIds(pool, userId, currDIds);
    // purge_binder_ids(RLY-20260806-039) — purge_section_ids와 같은 기제를 바인더 레벨로 확장한
    // 것이다: 삭제·강퇴·자진탈퇴로 바인더 접근을 잃으면 그 바인더가 currDIds에서 빠지고(025가
    // 세운 방어선 — getBinderIdsByUserId가 binder_members.deleted_at·binders.deleted_at을
    // 확인), 그 결과 그 바인더는 oldDIds(델타 스코프)에서도 함께 빠져 자식 tombstone이 원리적으로
    // 전달되지 않는다(025 구현보고서 §구조적 발견). 세 경로(deleteBinder·kickBinderMember·
    // leaveBinder) 전부 BinderDAO.cascadeSoftDelete/removeMember로 binder_members.deleted_at을
    // 세워 currDIds 재계산에 동일하게 반영되므로, 이 diff 하나로 세 경로 전부를 구분 없이 잡는다
    // (경로별 개별 훅 불필요 — "이미 있는 기제를 한 단계 위로 올리는 것").
    //
    // 과잉정리 위험(구현보고서 참조) — currDIds는 위 35행에서 단일 SELECT(getBinderIdsByUserId)로
    // 얻는다. Postgres MVCC 하에서 이 쿼리는 커밋된 스냅샷 전체를 원자적으로 반환하므로 "일부만
    // 반영된 반쪽 상태"가 결과에 섞일 수 없다 — 쿼리는 성공(완전한 최신 스냅샷) 아니면 예외(rejected
    // Promise, pullChanges 자체가 실패해 응답이 만들어지지 않음) 둘 중 하나만 가능하다. 즉
    // purgeBinderIds가 "실제로는 아직 멤버인" 바인더를 실을 수 있는 유일한 경로는 이 SELECT
    // 자체가 잘못된 값을 반환하는 경우인데, 그러면 sync 전체(ACL의 뿌리, 34행 주석)가 이미
    // 신뢰할 수 없는 상태 — purge_binder_ids만의 문제가 아니라 시스템 전체 authz가 깨진 것이다.
    const purgeBinderIds = diff(prevToken.d_ids, currDIds);
    if (purgeBinderIds.length > 0) {
      // 관측성 — 정리가 오발동하면(위험 판단, 구현보고서 참조) 로그 볼륨으로 가장 먼저 드러난다.
      logger.info('sync: purge_binder_ids emitted', { userId, count: purgeBinderIds.length, binderIds: purgeBinderIds });
    }
    const accessReconciliation = {
      hydrate_section_ids: diff(accessibleSectionIds, previousSectionIds),
      purge_section_ids: diff(previousSectionIds, accessibleSectionIds),
      purge_binder_ids: purgeBinderIds,
    };
    ctx.hydrateSectionIds = accessReconciliation.hydrate_section_ids;

    // 접근집합 재계산 뒤 hydrate/purge 지시를 확정한 다음 일반 delta를 조회한다.
    const [calendarData, messagingData, personalData] = await Promise.all([
      this._fetchTrackBCalendar(ctx),
      this._fetchTrackCMessaging(ctx),
      this._fetchPersonalData(userId, currDIds, oldTsDate, msgWindowFrom)
    ]);

    // 5. 다음 동기화를 위한 새 토큰 발급
    const next_sync_token = SyncToken.encode({
      ts: Math.floor(now.getTime() / 1000),
      d_ids: currDIds,
      c_ids: currCIds,
      s_ids: accessibleSectionIds,
    });
    
    return {
      data: {
        ...metaData,
        access_reconciliation: accessReconciliation,
        ...calendarData,
        ...messagingData,
        ...personalData,
      },
      next_sync_token
    };
  }

  /**
   * [Contextual Fetch] 캘린더 과거/미래 무한 스크롤 시 데이터 요청
   */
  async fetchCalendarWindow(userId, startIso, endIso) {
    const startDate = new Date(startIso);
    const endDate = new Date(endIso);

    const [currDIds, currCIds] = await Promise.all([
      SyncDAO.getBinderIdsByUserId(pool, userId),
      SyncDAO.getSubscribedCalIdsByUserId(pool, userId),
    ]);

    const ctx = {
      userId,
      currDIds,
      currCIds,
      calWindowFrom: startDate,
      calWindowTo: endDate
    };

    // 토큰 갱신 없이 데이터만 리턴 (로컬 DB Backfill 용도)
    return await SyncDAO.getCalendarDataOnlyByWindow(pool, ctx);
  }

  // =========================================================================
  // PRIVATE METHODS : 도메인별 패칭 로직 (JS 필터링 제거)
  // =========================================================================

  async _fetchTrackAMeta(userId, currDIds, currCIds, oldTs, previousSectionIds) {
    // 뼈대 데이터는 ts, old/new 따지지 않고 무조건 현재 소속 기준으로 100% 덮어씌움 (FK 에러 방지)
    const [binders, binderMembers, binderPreferences, binderSettings, users, groups, groupMembers, sectionMembersByBinder, section, calendars, subscribedCals] = await Promise.all([
      SyncDAO.getBindersForSync(pool, currDIds, currCIds),
      SyncDAO.getBinderMembers(pool, currDIds),
      SyncDAO.getBinderPreferences(pool, userId, currDIds),
      SyncDAO.getBinderSettings(pool, currDIds),
      SyncDAO.getUsersForSync(pool, currDIds), // RLY-20260806-050 — oldTs 인자 제거(무조건 100%로 정정)
      SyncDAO.getGroups(pool, currDIds), // RLY-20260806-050 — 동일(getUsersForSync와 같은 결함)
      SyncDAO.getOwnGroupMembers(pool, userId, oldTs),
      Promise.all(currDIds.map((binderId) => SyncDAO.fetchSectionMembers(pool, binderId, userId, oldTs))),
      SyncDAO.getSection(pool, userId, currDIds, oldTs, previousSectionIds),
      SyncDAO.getCalendarsForSync(pool, currDIds, currCIds),
      SyncDAO.getSubscribedCalendarRecords(pool, currCIds)
    ]);

    return {
      binders, binder_members: binderMembers, binder_preferences: binderPreferences,
      binder_settings: binderSettings, users, groups, group_members: groupMembers,
      sectionMembers: sectionMembersByBinder.flat(), section, calendars,
      subscribed_calendars: subscribedCals
    };
  }

  async _fetchTrackBCalendar(ctx) {
    // 연쇄 호출(Cascading)의 악몽을 지우고, DAO 단에서 UNION ALL을 통해 각각 독립적으로 가져옵니다.
    const [events, eventInstances, eventParticipants, tasks, taskInstances, taskParticipants, specialDays] = await Promise.all([
      SyncDAO.getEventsDeltaFull(pool, ctx),
      SyncDAO.getEventInstancesDeltaFull(pool, ctx), // 부모(events) 참조 없이 독자 검사!
      SyncDAO.getEventParticipantsDeltaFull(pool, ctx),
      SyncDAO.getTasksDeltaFull(pool, ctx),
      SyncDAO.getTaskInstancesDeltaFull(pool, ctx),
      SyncDAO.getTaskParticipantsDeltaFull(pool, ctx),
      SyncDAO.getSpecialDaysDeltaFull(pool, ctx)
    ]);

    return {
      events, event_instances: eventInstances, event_participants: eventParticipants,
      tasks, task_instances: taskInstances, task_participants: taskParticipants, special_days: specialDays
    };
  }

  async _fetchTrackCMessaging(ctx) {
    const messages = await SyncDAO.getMessagesDeltaFull(pool, ctx);
    const messageIds = messages.map(m => m.id);
    const relatedOldTs = ctx.hydrateSectionIds.length ? null : ctx.oldTs;

    // RLY-20260806-078 — 첨부는 messages.length===0(부모 메시지가 이번 델타에 하나도 없는
    // 경우)이어도 계속 조회한다. Worker의 비동기 confirm→ready/rejected 전환이 메시지 자신의
    // 동기화보다 항상 늦게 끝나(1분 폴링), "메시지는 이미 동기화됐는데 그 메시지에 달린 첨부
    // 상태만 나중에 바뀌는" 순서가 예외가 아니라 일반적이다(구현 보고서 §1 재현). messageIds만
    // 으로 스코프하면 그 변화가 부모 메시지 자신이 다시 바뀌지 않는 한 영원히 델타에서 빠진다 —
    // getMessageAttachments에 독자 updated_at 조건을 추가해 이를 닫았다(인가는 messageIds가
    // 아니라 ctx.currDIds·userId 기반 섹션 접근 검증으로 대체 — DAO 내부 주석 참조).
    //
    // RLY-20260806-079 — 같은 부류 조사(구현 보고서 §1): message_reactions는 정확히 같은
    // 성질(react/unreact가 메시지 생성과 독립된 시점에 일어난다, 취소는 소프트 delete라
    // updated_at으로 잡힌다) — attachments와 동일하게 messages.length와 무관하게 조회하고
    // ctx.userId·ctx.currDIds를 넘긴다. message_embeds·message_mentions는 조사 결과 다른
    // 성질이다 — createMessage 트랜잭션 안에서만 생성되고 그 뒤 독립적으로 바뀌는 경로가
    // 없어(코드 전수 확인) "부모 불변+자식만 변경" 상황 자체가 지금 발생할 수 없다. 그래서
    // 둘은 기존 동작(messages 없으면 조회 안 함, messageIds 스코프만)을 그대로 뒀다.
    const [attachments, embeds, reactions, mentions] = await Promise.all([
      SyncDAO.getMessageAttachments(pool, messageIds, relatedOldTs, ctx.userId, ctx.currDIds),
      messages.length ? SyncDAO.getMessageEmbeds(pool, messageIds, relatedOldTs) : [],
      SyncDAO.getMessageReactions(pool, messageIds, relatedOldTs, ctx.userId, ctx.currDIds),
      messages.length ? SyncDAO.getMessageMentions(pool, messageIds, relatedOldTs) : [],
    ]);

    return { messages, attachments, message_embeds: embeds, message_reactions: reactions, message_mentions: mentions };
  }

  async _fetchPersonalData(userId, currDIds, oldTs, msgWindowFrom) {
    const [notifications, activityFeeds, activityFeedCursors, subscriptions, assets, holidayCountries] = await Promise.all([
      SyncDAO.getNotifications(pool, userId, oldTs || msgWindowFrom),
      SyncDAO.getActivityFeedsForSync(pool, userId, currDIds, oldTs),
      SyncDAO.getActivityFeedCursorsForSync(pool, userId, currDIds),
      SyncDAO.getUserSubscriptions(pool, userId, oldTs),
      SyncDAO.getUserAssets(pool, userId, oldTs),
      SyncDAO.getUserHolidayCountries(pool, userId)
    ]);

    let holidays = [];
    if (holidayCountries.length) {
      holidays = await SyncDAO.getHolidays(pool, holidayCountries, oldTs);
    }

    return {
      notifications, activity_feeds: activityFeeds, activity_feed_cursors: activityFeedCursors,
      user_subscriptions: subscriptions, user_assets: assets, holidays
    };
  }

  async syncSettings(userId, settings) {
    return await UserSettingsDAO.updatePartial(pool, userId, settings);
  }

  _buildEmptyResponse(now, currDIds, currCIds, prevToken, previousSectionIds) {
    // 이 경로에 들어왔다는 건 currDIds가 비었다는 뜻 — 접근 가능한 섹션도 있을 수 없으므로
    // hydrate는 항상 []이고, 이전에 알던 바인더/섹션은 전부 상실로 취급해 purge로 내려보낸다.
    // 일반 경로의 diff(old, curr) 대칭과 동일 규칙(curr=[])이다.
    const purgeBinderIds = diff(prevToken.d_ids, currDIds);
    const purgeSectionIds = diff(previousSectionIds, []);
    return {
      data: {
        sectionMembers: [],
        access_reconciliation: {
          hydrate_section_ids: [],
          purge_section_ids: purgeSectionIds,
          purge_binder_ids: purgeBinderIds,
        },
      },
      next_sync_token: SyncToken.encode({ ts: Math.floor(now.getTime() / 1000), d_ids: currDIds, c_ids: currCIds, s_ids: [] })
    };
  }
}

module.exports = new SyncService();
