const { CalendarDAO } = require('../daos/calendarDAO');
const { BinderDAO } = require('../daos/binderDAO');
const { ForbiddenError, NotFoundError } = require('./errors');

/**
 * calendar_id로부터 바인더를 도출해 멤버십(과 선택적으로 role)을 확인한다.
 * 이미 정상 동작하던 항목들(specialDayService.update/delete 등)이 반복하던
 * "CalendarDAO.findById → BinderDAO.getMember → role 비교" 3줄짜리 인라인 패턴을 뽑은 것이다.
 *
 * @param {object} conn - DB 커넥션(Pool 또는 트랜잭션 client)
 * @param {string} calendarId
 * @param {string} userId
 * @param {object} [options]
 * @param {number} [options.minRole] - 요구되는 최대 role 값(낮을수록 상위 권한). 생략 시 멤버십만 확인.
 * @param {boolean} [options.allowPublicRead] - true면 비멤버라도 캘린더가 is_public이면 통과(읽기 전용 게이트, 결정 5)
 * @returns {{ calendar: object, member: object|null }} - member는 allowPublicRead로 통과한 비멤버의 경우 null
 */
async function requireBinderMemberByCalendarId(conn, calendarId, userId, options = {}) {
  const { minRole, allowPublicRead = false } = options;
  const calendar = await CalendarDAO.findById(conn, calendarId);
  if (!calendar) throw new NotFoundError('캘린더를 찾을 수 없습니다');

  const member = await BinderDAO.getMember(conn, calendar.binder_id, userId);
  const isActiveMember = !!member && !member.deleted_at;

  if (!isActiveMember) {
    if (allowPublicRead && calendar.is_public) return { calendar, member: null };
    throw new ForbiddenError('바인더 멤버만 접근할 수 있습니다');
  }

  if (minRole !== undefined && member.role > minRole) {
    throw new ForbiddenError('권한이 없습니다');
  }

  return { calendar, member };
}

/**
 * binder_id를 이미 알고 있는(또는 파생받은) 경로의 멤버십(과 선택적으로 role) 확인.
 *
 * @param {object} conn
 * @param {string} binderId
 * @param {string} userId
 * @param {object} [options]
 * @param {number} [options.minRole]
 * @returns {object} member row
 */
async function requireBinderMember(conn, binderId, userId, options = {}) {
  const { minRole } = options;
  const member = await BinderDAO.getMember(conn, binderId, userId);
  if (!member || member.deleted_at) throw new ForbiddenError('바인더 멤버만 접근할 수 있습니다');
  if (minRole !== undefined && member.role > minRole) throw new ForbiddenError('권한이 없습니다');
  return member;
}

module.exports = {
  requireBinderMemberByCalendarId,
  requireBinderMember,
};
