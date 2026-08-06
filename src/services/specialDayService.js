const { SpecialDayDAO } = require('../daos/specialDayDAO');
const { CalendarDAO } = require('../daos/calendarDAO');
const { BinderDAO } = require('../daos/binderDAO');
const { ReminderDAO } = require('../daos/reminderDAO');
const { generateUUID } = require('../utils/uuid');
const eventBus = require('../events/eventBus');
const withTransaction = require('../core/withTransaction');
const pool = require('../../config/db');
const { NotFoundError, ForbiddenError } = require('../core/errors');
const { TargetType, ActionType } = require('../utils/typeDefinitions');

// reminders.target_type: 0=event_instance 1=task_instance 2=special_day (schema.md §10-4)
const SPECIAL_DAY_TARGET_TYPE = 2;

// RLY-20260806-026 — SpecialDay 리마인더 수신자는 소유자(author_id) 한 명뿐이라(SC-reminder §2-B)
// "09:00 로컬"의 기준 시간대가 유일하게 정해진다. 유저별 timezone을 저장하는 기존 컬럼
// (user_settings.timezone, system.md §10-12)을 그대로 재사용한다 — 신규 컬럼 없음.
// ⚠️ 이 함수는 저장 시점 값을 **해석하지 않고 그대로 반환**한다 — 기본값 'system'인 계정은
// 'system' 문자열이 그대로 reminders.timezone에 저장된다. 'system'을 실제 IANA 타임존으로
// 해석하는 로직은 2단계(발송 dispatch)의 몫이다(이번 Task는 저장 계약까지만).
async function resolveOwnerTimezone(conn, authorId) {
  const { rows } = await conn.query('SELECT timezone FROM user_settings WHERE user_id = $1', [authorId]);
  return rows[0]?.timezone || 'UTC';
}

function isValidIanaTimeZone(tz) {
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// base_date(DATE, 시각 없음) 를 그 날 09:00 로컬(timezone)의 UTC 순간으로 변환한다(SC-reminder §1
// "SpecialDay: base_date @ 09:00 로컬"). timezone이 유효한 IANA 식별자가 아니면(예: 위 'system'
// sentinel) 이 **계산에 한해서만** UTC로 대체한다 — reminders.timezone 컬럼에 저장되는 값 자체는
// resolveOwnerTimezone이 반환한 원본 그대로다(해석은 여기서 trigger_at 산출에만 쓰인다).
//
// ⚠️ 범위: 이 함수는 저장된 base_date를 그대로 쓸 뿐, "이미 지난 날짜면 내년으로" 굴리는 롤링이나
// 음력→양력 변환(is_lunar=true)은 하지 않는다. 그 계산(§5A "다음 해 trigger_at 계산", 서버 npm
// `korean-lunar-calendar`)은 2단계 dispatch가 매 tick마다 수행하는 몫으로 문서에 명시돼 있고,
// 이 라이브러리는 현재 package.json에 없다(신규 프로덕션 의존성은 User 승인 필요 — 이번 Task는
// 추가하지 않는다). is_lunar=true인 기념일도 지금은 저장된 solar base_date로만 계산한다.
function localNineAmUtc(baseDate, timeZone) {
  const zone = isValidIanaTimeZone(timeZone) ? timeZone : 'UTC';
  const d = new Date(baseDate);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  const desired = Date.UTC(year, month, day, 9, 0, 0);

  // 벽시계 09:00을 UTC로 취급한 최초 추정치를, 그 zone에서 실제로 몇 시로 읽히는지 보고 보정한다
  // (DST 등 고정 오프셋이 아닌 zone도 다룬다). 2회 반복이면 실질적으로 수렴한다 — 09:00 부근에서
  // DST 전환이 겹치는 zone은 존재하나 극히 드물고, 그 경계 처리는 이번 스코프가 아니다.
  let guess = desired;
  for (let i = 0; i < 2; i += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(guess));
    const map = {};
    parts.forEach((p) => { map[p.type] = p.value; });
    const observed = Date.UTC(
      Number(map.year), Number(map.month) - 1, Number(map.day),
      Number(map.hour) % 24, Number(map.minute), Number(map.second)
    );
    guess += desired - observed;
  }
  return new Date(guess);
}

// events·tasks·special_days 세 축이 공유하는 파생 호출 지점 — special_days는 회차가 없어(fork
// 전환 대상 아님, 단일 row) 대상이 하나뿐이라 ReminderDAO.syncTarget을 1회만 호출한다.
async function syncSpecialDayReminders(conn, specialDay) {
  const timezone = await resolveOwnerTimezone(conn, specialDay.author_id);
  await ReminderDAO.syncTarget(conn, {
    targetType: SPECIAL_DAY_TARGET_TYPE,
    targetId: specialDay.id,
    baseTime: localNineAmUtc(specialDay.base_date, timezone),
    offsets: specialDay.reminder_offsets,
    timezone,
  });
}

class SpecialDayService {
  async getById(id, userId) {
    const day = await SpecialDayDAO.findById(pool, id);
    if (!day) throw new NotFoundError('기념일을 찾을 수 없습니다');

    // F-S8a(0e0e67f) — 상위 체인(calendar·binder) 부재를 day 부재와 같은 404로 위장한다.
    // day_id를 훑는 공격자가 응답 코드·메시지로 상위 상태(캘린더 존재 여부·바인더 soft-delete
    // 여부)를 추론하지 못하게 하는 존재 오라클 방어다. 59c0a81(인가 30+2)이 이 함수를 공유
    // 헬퍼(requireBinderMemberByCalendarId)로 교체하며 이 위장을 무너뜨렸다 — 그 헬퍼는
    // 캘린더 부재를 "캘린더를 찾을 수 없습니다"로, 바인더 soft-delete를 403으로 그대로
    // 흘려보낸다. RLY-20260806-020 조사: 이 위장이 필요한 진입점은 이 함수 하나뿐이다
    // (다른 모든 getXxx 인가는 59c0a81이 신설한 것이라 위장할 기존 계약 자체가 없었다).
    // 그래서 공유 헬퍼에 옵션을 얹지 않고(다른 20여 호출부를 위험에 노출시키므로) 이 함수만
    // 인라인으로 되돌린다 — 되돌리는 것은 오류 구분이지 인가 자체가 아니다.
    const cal = await CalendarDAO.findById(pool, day.calendar_id);
    if (!cal) throw new NotFoundError('기념일을 찾을 수 없습니다');

    const binder = await BinderDAO.findById(pool, cal.binder_id);
    if (!binder) throw new NotFoundError('기념일을 찾을 수 없습니다');

    const member = await BinderDAO.getMember(pool, cal.binder_id, userId);
    if (!member || member.deleted_at) {
      throw new ForbiddenError('바인더 멤버만 기념일을 조회할 수 있습니다');
    }
    return day;
  }

  async getHolidays({ country_code, year } = {}) {
    return await SpecialDayDAO.findHolidays(pool, { country_code, year });
  }

  async getByCalendar(calId, userId) {
    const cal = await CalendarDAO.findById(pool, calId);
    if (!cal) throw new NotFoundError('캘린더를 찾을 수 없습니다');
    return await SpecialDayDAO.findByCalId(pool, calId);
  }

  async create(data, context) {
    const { calendar_id } = data;
    const cal = await CalendarDAO.findById(pool, calendar_id);
    if (!cal) throw new NotFoundError('캘린더를 찾을 수 없습니다');

    const member = await BinderDAO.getMember(pool, cal.binder_id, context.sender_id);
    if (!member || member.deleted_at) throw new ForbiddenError('권한이 없습니다');
    if (member.role > 2) throw new ForbiddenError('편집자 이상만 기념일을 생성할 수 있습니다');

    const specialDay = await withTransaction(async (client) => {
      if (data.calendar) {
        const existing = await CalendarDAO.findById(client, calendar_id);
        if (!existing) await CalendarDAO.create(client, data.calendar);
      }
      // author_id NOT NULL(2026-08-03 확정 컬럼) — events/tasks와 동일하게 payload 값을 신뢰하되
      // (data.author_id 직접 사용 관례, eventDAO/taskDAO 참조), 이 필드를 아직 모르는 클라이언트가
      // 보내지 않은 경우에만 인증된 요청자로 대체한다.
      const specialDayData = { ...data, id: data.id || generateUUID(), author_id: data.author_id || context.sender_id };
      const created = await SpecialDayDAO.create(client, specialDayData);

      await syncSpecialDayReminders(client, created);

      return created;
    });

    eventBus.emit('sync', {
      binder_id: cal.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.CREATE,
      target_type: TargetType.SPECIAL_DAY,
      target_id: specialDay.id,
    });

    return specialDay;
  }

  async update(id, data, context) {
    const specialDay = await SpecialDayDAO.findById(pool, id);
    if (!specialDay) throw new NotFoundError('기념일을 찾을 수 없습니다');

    const cal = await CalendarDAO.findById(pool, specialDay.calendar_id);
    const member = await BinderDAO.getMember(pool, cal.binder_id, context.sender_id);
    if (!member || member.deleted_at || member.role > 2) throw new ForbiddenError('권한이 없습니다');

    // base_date·reminder_offsets 변경 시 발송 원장을 다시 파생해야 하므로(지시 §2), 갱신 행
    // UPDATE와 파생을 한 트랜잭션으로 묶는다 — 부분 반영(행은 바뀌었는데 원장은 옛 값) 방지.
    const updated = await withTransaction(async (client) => {
      const result = await SpecialDayDAO.update(client, id, data);
      await syncSpecialDayReminders(client, result);
      return result;
    });

    eventBus.emit('sync', {
      binder_id: cal.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.UPDATE,
      target_type: TargetType.SPECIAL_DAY,
      target_id: id,
    });

    return updated;
  }

  async delete(id, context) {
    const specialDay = await SpecialDayDAO.findById(pool, id);
    if (!specialDay) throw new NotFoundError('기념일을 찾을 수 없습니다');

    const cal = await CalendarDAO.findById(pool, specialDay.calendar_id);
    const member = await BinderDAO.getMember(pool, cal.binder_id, context.sender_id);
    if (!member || member.deleted_at || member.role > 2) throw new ForbiddenError('권한이 없습니다');

    // SC-reminder 액션D — 부모 삭제 시 발송 원장 hard delete(별도 history 테이블 없음).
    // eventDAO·taskDAO 쪽 동일 정리는 RLY-20260806-027(삭제 전파) 담당이라 여기서 건드리지 않는다
    // — special_days는 그 Task 경계 밖이라 이 축만 지금 정리한다.
    await withTransaction(async (client) => {
      await SpecialDayDAO.softDelete(client, id);
      await ReminderDAO.deleteByTarget(client, SPECIAL_DAY_TARGET_TYPE, id);
    });

    eventBus.emit('sync', {
      binder_id: cal.binder_id,
      sender_id: context.sender_id,
      device_uuid: context.device_uuid,
      action: ActionType.DELETE,
      target_type: TargetType.SPECIAL_DAY,
      target_id: id,
    });
  }
}

module.exports = { SpecialDayService: new SpecialDayService() };
