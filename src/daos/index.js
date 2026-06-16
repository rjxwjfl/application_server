/**
 * src/daos/index.js
 * =========================================
 * 데이터 접근 객체 (DAO) 진입점
 * 
 * 역할:
 * - 데이터베이스 접근 추상화
 * - SQL 쿼리 실행
 * - 데이터 CRUD 작업
 * =========================================
 */

// DAO 클래스 import
const { DrawerDAO } = require('./drawerDAO');
const { UserDAO } = require('./userDAO');
const { EventDAO } = require('./eventDAO');
const { TaskDAO } = require('./taskDAO');
const { SyncDAO } = require('./syncDAO');
const { NotificationDAO } = require('./notificationDAO');
const { AuditDAO } = require('./auditDAO');
const { ActivityFeedDAO } = require('./activityFeedDAO');
const { ReminderDAO } = require('./reminderDAO');
const { UserSettingsDAO } = require('./userSettingsDAO');
const { SeriesDAO } = require('./seriesDAO');
const { MessageDAO } = require('./messageDAO');
const { CalendarDAO } = require('./calendarDAO');
const { BillingDAO } = require('./billingDAO');
const { SpecialDayDAO } = require('./specialDayDAO');
const { CastDAO } = require('./castDAO');
const { PostDAO } = require('./postDAO');
const { AttachmentDAO } = require('./attachmentDAO');

// 모든 DAO를 export
module.exports = {
  DrawerDAO,
  UserDAO,
  EventDAO,
  TaskDAO,
  SyncDAO,
  NotificationDAO,
  AuditDAO,
  ActivityFeedDAO,
  ReminderDAO,
  UserSettingsDAO,
  SeriesDAO,
  MessageDAO,
  CalendarDAO,
  BillingDAO,
  SpecialDayDAO,
  CastDAO,
  PostDAO,
  AttachmentDAO,
};
