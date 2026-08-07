class CalendarDAO {
  // ============================================
  // Calendars 테이블
  // ============================================

  async findById(conn, calendarId) {
    const query = `
      SELECT id, binder_id, title, description, color, is_public,
             created_at, updated_at, deleted_at
      FROM calendars
      WHERE id = $1 AND deleted_at IS NULL
    `;
    const result = await conn.query(query, [calendarId]);
    return result.rows[0] || null;
  }

  async findByBinderId(conn, binderId) {
    const query = `
      SELECT id, binder_id, title, description, color, is_public,
             created_at, updated_at, deleted_at
      FROM calendars
      WHERE binder_id = $1 AND deleted_at IS NULL
      ORDER BY created_at ASC
    `;
    const result = await conn.query(query, [binderId]);
    return result.rows;
  }

  async create(conn, data) {
    const query = `
      INSERT INTO calendars (id, binder_id, title, description, color, is_public, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()), COALESCE($8, now()))
      RETURNING *
    `;
    const result = await conn.query(query, [
      data.id,
      data.binder_id,
      data.title,
      data.description || null,
      data.color || 0,
      data.is_public || false,
      data.created_at,
      data.updated_at
    ]);
    return result.rows[0];
  }

  async update(conn, calendarId, updateData) {
    const { title, description, color, is_public } = updateData;
    const query = `
      UPDATE calendars
      SET title = COALESCE($1, title),
          description = COALESCE($2, description),
          color = COALESCE($3, color),
          is_public = COALESCE($4, is_public),
          updated_at = now()
      WHERE id = $5 AND deleted_at IS NULL
      RETURNING *
    `;
    const result = await conn.query(query, [title, description, color, is_public, calendarId]);
    return result.rows[0];
  }

  async softDelete(conn, calendarId) {
    const query = `
      UPDATE calendars
      SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
    `;
    await conn.query(query, [calendarId]);
  }

  // 바인더 내 삭제되지 않은 캘린더 수 — §16-5(SC-calendar-manage.md) Option B(최소 1개 보장) 판정용.
  // is_default 컬럼이 schema.sql에 없어(Option A는 스키마 변경 필요) 대신 이 카운트로 "마지막 남은
  // 캘린더"를 막는다(RLY-20260806-025).
  async countActiveByBinderId(conn, binderId) {
    const query = `
      SELECT COUNT(*)::int AS count FROM calendars WHERE binder_id = $1 AND deleted_at IS NULL
    `;
    const result = await conn.query(query, [binderId]);
    return result.rows[0].count;
  }

  // ============================================================================================
  // 삭제 전파(cascade soft delete) — RLY-20260806-025
  // ============================================================================================
  // H13(docs/calendar/SC-calendar-manage.md:169-185)이 명시한 전 테이블에 deleted_at을 심는다.
  // 각 UPDATE에 `AND deleted_at IS NULL`을 걸어 이미 삭제된 행의 삭제 시각을 덮어쓰지 않는다(밀리면
  // 30일 정리 배치 시점이 어긋난다). 회차(instance)는 이벤트/태스크당 최대 365개까지 실데이터로
  // 존재하므로 행 단위 루프 없이 집합 단위(UPDATE ... FROM ... WHERE)로 처리한다 — 각 문이
  // idx_events_sync/idx_tasks_sync(calendar_id 선두)·idx_event_inst_sync/idx_task_inst_task_id
  // (event_id/task_id 선두)를 타서 인덱스 스캔으로 좁혀진다.
  //
  // reminders 테이블은 schema.sql에 deleted_at 컬럼이 없다(soft delete 불가 — 스키마 변경 없이는
  // 고칠 수 없음). target_type/target_id로 참조 무결성 없는 폴리모픽 FK라 hard delete로 정리한다
  // (기존 ReminderDAO.deleteByTarget과 동일 패턴, uq_reminders_target(target_type, target_id, ...)
  // 인덱스를 태우도록 target_type을 선두 조건으로 둔다). ⚠️ ReminderDAO.create/findById 등은
  // user_id·base_time·is_sent 등 이 스키마에 없는 컬럼을 참조하는 기존 드리프트다 — 이 Task와
  // 무관한 pre-existing 문제라 여기서 고치지 않는다(보고서에 별도 명시).
  async cascadeSoftDelete(conn, calendarId) {
    await conn.query(
      `UPDATE events SET deleted_at = now(), updated_at = now()
       WHERE calendar_id = $1 AND deleted_at IS NULL`,
      [calendarId]
    );
    await conn.query(
      `UPDATE tasks SET deleted_at = now(), updated_at = now()
       WHERE calendar_id = $1 AND deleted_at IS NULL`,
      [calendarId]
    );
    await conn.query(
      `UPDATE special_days SET deleted_at = now(), updated_at = now()
       WHERE calendar_id = $1 AND deleted_at IS NULL`,
      [calendarId]
    );
    // RLY-20260806-138 — events·tasks·special_days와 같은 축(calendar_id 직접 소속)인데 casts만
    // 이 cascade에서 빠져 있었다. 발견 경로: search()·getItems(128)·EMBED_TARGET_VALIDATORS(100)
    // 전부 `JOIN calendars c ... WHERE c.binder_id = $1 AND ca.deleted_at IS NULL`처럼 캘린더
    // 자신의 deleted_at은 안 보고 casts.deleted_at만 본다 — event/task/special_day는 그래도
    // 안전한데(이 cascade가 그 셋은 이미 함께 지운다) casts만 지워지지 않아 **캘린더나 바인더가
    // 소프트 삭제돼도 그 캘린더의 cast가 검색·picker·임베드 링크에 계속 살아 있었다**(정상 조회
    // 경로 castService.getCasts는 requireBinderMemberByCalendarId가 먼저 캘린더 존재를 확인해
    // 이 문제를 안 겪는다 — 우회 경로에서만 샌다). 이 한 줄로 세 호출부 전부가 한 번에 닫힌다
    // (search()·getItems·EMBED_TARGET_VALIDATORS 코드 자체는 건드리지 않았다).
    await conn.query(
      `UPDATE casts SET deleted_at = now(), updated_at = now()
       WHERE calendar_id = $1 AND deleted_at IS NULL`,
      [calendarId]
    );
    await conn.query(
      `UPDATE event_instances ei SET deleted_at = now(), updated_at = now()
       FROM events e
       WHERE ei.event_id = e.id AND e.calendar_id = $1 AND ei.deleted_at IS NULL`,
      [calendarId]
    );
    await conn.query(
      `UPDATE task_instances ti SET deleted_at = now(), updated_at = now()
       FROM tasks t
       WHERE ti.task_id = t.id AND t.calendar_id = $1 AND ti.deleted_at IS NULL`,
      [calendarId]
    );
    await conn.query(
      `UPDATE event_participants ep SET deleted_at = now(), updated_at = now()
       FROM event_instances ei JOIN events e ON e.id = ei.event_id
       WHERE ep.instance_id = ei.id AND e.calendar_id = $1 AND ep.deleted_at IS NULL`,
      [calendarId]
    );
    await conn.query(
      `UPDATE task_participants tp SET deleted_at = now(), updated_at = now()
       FROM task_instances ti JOIN tasks t ON t.id = ti.task_id
       WHERE tp.instance_id = ti.id AND t.calendar_id = $1 AND tp.deleted_at IS NULL`,
      [calendarId]
    );
    await conn.query(
      `DELETE FROM reminders
       WHERE target_type = 0 AND target_id IN (
         SELECT ei.id FROM event_instances ei JOIN events e ON e.id = ei.event_id WHERE e.calendar_id = $1
       )`,
      [calendarId]
    );
    await conn.query(
      `DELETE FROM reminders
       WHERE target_type = 1 AND target_id IN (
         SELECT ti.id FROM task_instances ti JOIN tasks t ON t.id = ti.task_id WHERE t.calendar_id = $1
       )`,
      [calendarId]
    );
    await conn.query(
      `DELETE FROM reminders
       WHERE target_type = 2 AND target_id IN (
         SELECT sd.id FROM special_days sd WHERE sd.calendar_id = $1
       )`,
      [calendarId]
    );
    await conn.query(
      `UPDATE calendar_subscriptions SET deleted_at = now(), updated_at = now()
       WHERE calendar_id = $1 AND deleted_at IS NULL`,
      [calendarId]
    );
    await conn.query(
      `UPDATE calendars SET deleted_at = now(), updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL`,
      [calendarId]
    );
  }

  // ============================================
  // Calendar Subscriptions 테이블
  // ============================================

  async subscribe(conn, userId, calId) {
    const query = `
      INSERT INTO calendar_subscriptions (user_id, calendar_id, created_at, updated_at)
      VALUES ($1, $2, now(), now())
      ON CONFLICT (user_id, calendar_id) DO UPDATE
      SET deleted_at = NULL, updated_at = now()
      RETURNING user_id, calendar_id, created_at, updated_at
    `;
    const result = await conn.query(query, [userId, calId]);
    return result.rows[0];
  }

  async unsubscribe(conn, userId, calId) {
    const query = `
      UPDATE calendar_subscriptions
      SET deleted_at = now(), updated_at = now()
      WHERE user_id = $1 AND calendar_id = $2 AND deleted_at IS NULL
    `;
    await conn.query(query, [userId, calId]);
  }

  async getSubscriptionsByUserId(conn, userId) {
    const query = `
      SELECT c.id, c.binder_id, c.title, c.description, c.color, c.is_public,
             c.created_at, c.updated_at,
             cs.created_at AS subscribed_at
      FROM calendar_subscriptions cs
      JOIN calendars c ON cs.calendar_id = c.id
      WHERE cs.user_id = $1 AND cs.deleted_at IS NULL AND c.deleted_at IS NULL
      ORDER BY cs.created_at ASC
    `;
    const result = await conn.query(query, [userId]);
    return result.rows;
  }

  async getSubscribersByCalId(conn, calId) {
    const query = `
      SELECT cs.user_id, cs.created_at AS subscribed_at,
             ui.display_name, ui.image_url, ui.thumbnail_url
      FROM calendar_subscriptions cs
      JOIN users u ON cs.user_id = u.id
      LEFT JOIN user_infos ui ON cs.user_id = ui.user_id
      WHERE cs.calendar_id = $1 AND cs.deleted_at IS NULL AND u.deleted_at IS NULL
      ORDER BY cs.created_at ASC
    `;
    const result = await conn.query(query, [calId]);
    return result.rows;
  }

  async getCalendarSubscriptions(conn, calId) {
    return this.getSubscribersByCalId(conn, calId);
  }
}

module.exports = { CalendarDAO: new CalendarDAO() };
