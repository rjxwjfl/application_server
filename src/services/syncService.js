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
    const prevToken = SyncToken.decode(rawToken) || { ts: 0, d_ids: [], c_ids: [] };
    const oldTsDate = prevToken.ts > 0 ? new Date(prevToken.ts * 1000) : null;

    // 2. 현재 유저의 '진짜' 권한 조회 (DB 기준)
    const [currDIds, currCIds] = await Promise.all([
      SyncDAO.getDrawerIdsByUserId(pool, userId),
      SyncDAO.getSubscribedCalIdsByUserId(pool, userId),
    ]);

    if (!currDIds.length && !currCIds.length) {
      return this._buildEmptyResponse(now, currDIds, currCIds);
    }

    // 3. Sync Context (상태 Diff) 객체 생성 - 이 객체 하나로 모든 DAO 쿼리가 동작합니다.
    const ctx = {
      userId,
      oldTs: oldTsDate,
      oldDIds: prevToken.d_ids.filter(id => currDIds.includes(id)), // 유지된 기존 서랍
      oldCIds: prevToken.c_ids.filter(id => currCIds.includes(id)), // 유지된 기존 캘린더
      newDIds: diff(currDIds, prevToken.d_ids), // 새로 가입한 서랍
      newCIds: diff(currCIds, prevToken.c_ids), // 새로 구독한 캘린더
      calWindowFrom,
      calWindowTo,
      msgWindowFrom
    };

    // 4. 병렬 데이터 패칭 (3 트랙 완벽 분리)
    const [metaData, calendarData, messagingData, personalData] = await Promise.all([
      this._fetchTrackAMeta(userId, currDIds, currCIds, oldTsDate),
      this._fetchTrackBCalendar(ctx),
      this._fetchTrackCMessaging(ctx),
      this._fetchPersonalData(userId, currDIds, oldTsDate, msgWindowFrom)
    ]);

    // 5. 다음 동기화를 위한 새 토큰 발급
    const next_sync_token = SyncToken.encode({
      ts: Math.floor(now.getTime() / 1000),
      d_ids: currDIds,
      c_ids: currCIds,
    });
    
    return {
      data: {
        ...metaData,
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
      SyncDAO.getDrawerIdsByUserId(pool, userId),
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

  async _fetchTrackAMeta(userId, currDIds, currCIds, oldTs) {
    // 뼈대 데이터는 ts, old/new 따지지 않고 무조건 현재 소속 기준으로 100% 덮어씌움 (FK 에러 방지)
    const [drawers, drawerMembers, drawerPreferences, drawerSettings, users, series, calendars, subscribedCals] = await Promise.all([
      SyncDAO.getDrawersForSync(pool, currDIds, currCIds),
      SyncDAO.getDrawerMembers(pool, currDIds),
      SyncDAO.getDrawerPreferences(pool, userId, currDIds),
      SyncDAO.getDrawerSettings(pool, currDIds),
      SyncDAO.getUsersForSync(pool, currDIds, oldTs),
      SyncDAO.getSeries(pool, currDIds),
      SyncDAO.getCalendarsForSync(pool, currDIds, currCIds),
      SyncDAO.getSubscribedCalendarRecords(pool, currCIds)
    ]);

    return {
      drawers, drawer_members: drawerMembers, drawer_preferences: drawerPreferences,
      drawer_settings: drawerSettings, users, series, calendars,
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
    
    if (!messages.length) {
      return { messages: [], attachments: [], message_embeds: [], message_reactions: [], message_mentions: [] };
    }

    const messageIds = messages.map(m => m.id);
    const [attachments, embeds, reactions, mentions] = await Promise.all([
      SyncDAO.getMessageAttachments(pool, messageIds, ctx.oldTs),
      SyncDAO.getMessageEmbeds(pool, messageIds, ctx.oldTs),
      SyncDAO.getMessageReactions(pool, messageIds, ctx.oldTs),
      SyncDAO.getMessageMentions(pool, messageIds, ctx.oldTs)
    ]);

    return { messages, attachments, message_embeds: embeds, message_reactions: reactions, message_mentions: mentions };
  }

  async _fetchPersonalData(userId, currDIds, oldTs, msgWindowFrom) {
    const [notifications, activityFeeds, activityFeedCursors, subscriptions, assets, holidayCountries] = await Promise.all([
      SyncDAO.getNotifications(pool, userId, oldTs || msgWindowFrom),
      SyncDAO.getActivityFeedsForSync(pool, currDIds, oldTs),
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

  _buildEmptyResponse(now, currDIds, currCIds) {
    return {
      data: {},
      next_sync_token: SyncToken.encode({ ts: Math.floor(now.getTime() / 1000), d_ids: currDIds, c_ids: currCIds })
    };
  }
}

module.exports = new SyncService();