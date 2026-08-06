class EventDAO {
  // ============================================
  // Event 마스터 테이블
  // ============================================

  async findById(conn, eventId) {
    const query = `
      SELECT id, calendar_id, author_id, event_type, summary,
             description, color, r_rule, recurrence_timezone, locations, forked_from,
             created_at, updated_at, deleted_at
      FROM events
      WHERE id = $1 AND deleted_at IS NULL
    `;
    const result = await conn.query(query, [eventId]);
    return result.rows[0] || null;
  }

  async createEvent(conn, data) {
    const eventQuery = `
      INSERT INTO events (
        id, calendar_id, author_id, event_type, summary,
        description, color, r_rule, locations, forked_from,
        recurrence_timezone, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, COALESCE($12, now()), COALESCE($13, now())
      )
      RETURNING *
    `;

    const eventResult = await conn.query(eventQuery, [
      data.id,
      data.calendar_id,
      data.author_id,
      data.event_type || 0,
      data.summary,
      data.description || null,
      data.color,
      data.r_rule || null,
      data.locations ? JSON.stringify(data.locations) : null,
      data.forked_from || null,
      data.recurrence_timezone || null,
      data.created_at,
      data.updated_at
    ]);

    if (data.instances && data.instances.length > 0) {
      for (const instance of data.instances) {
        await this.createEventInstance(conn, {
          ...instance,
          event_id: data.id
        });

        if (instance.participants && instance.participants.length > 0) {
          for (const participant of instance.participants) {
            await this.addParticipantRaw(conn, instance.id, participant.user_id, participant.inviter_id, participant.state, participant.memo);
          }
        }
      }
    }

    return eventResult.rows[0];
  }

  async updateEvent(conn, eventId, updateData) {
    const { summary, description, color, r_rule, locations, recurrence_timezone } = updateData;
    // recurrence_timezone은 COALESCE가 아니라 hasOwnProperty 기반 CASE WHEN을 쓴다 — 이 저장소의
    // 기존 관례(postDAO.js update()의 title/special_day_id, groupDAO.js updateGroup()의 color)를
    // 그대로 따른 것이다. COALESCE는 "필드 부재(변경 없음)"와 "필드가 명시적으로 null(지우기)"을
    // 구분 못해 지우기를 영원히 표현할 수 없다(RLY-20260806-019). 이 함수의 다른 컬럼(summary 등)은
    // 일부러 COALESCE를 유지했다 — 각 필드의 "명시적 지우기" 필요 여부는 개별 판정해야 하고,
    // 이번 범위는 recurrence_timezone 하나뿐이다. 이 컬럼만 다르다고 "빠뜨린 COALESCE"로 오해해
    // 통일하지 말 것 — 통일하면 지우기가 다시 죽는다.
    const hasRecurrenceTimezone = Object.prototype.hasOwnProperty.call(updateData, 'recurrence_timezone');
    const query = `
      UPDATE events
      SET summary = COALESCE($1, summary),
          description = COALESCE($2, description),
          color = COALESCE($3, color),
          r_rule = COALESCE($4, r_rule),
          locations = COALESCE($5, locations),
          recurrence_timezone = CASE WHEN $6 THEN $7 ELSE recurrence_timezone END,
          updated_at = now()
      WHERE id = $8 AND deleted_at IS NULL
      RETURNING *
    `;
    const result = await conn.query(query, [
      summary, description, color, r_rule,
      locations ? JSON.stringify(locations) : null,
      hasRecurrenceTimezone, recurrence_timezone,
      eventId
    ]);
    return result.rows[0];
  }

  async softDeleteEvent(conn, eventId) {
    const query = `
      UPDATE events
      SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
    `;
    await conn.query(query, [eventId]);
  }

  async splitEvent(conn, originalEventId, instanceId, newEventId) {
    const instance = await this.findInstanceById(conn, instanceId);
    if (!instance) throw new Error("인스턴스를 찾을 수 없습니다");

    const newEventQuery = `
      INSERT INTO events (
        id, calendar_id, author_id, event_type, summary,
        description, color, r_rule, locations, forked_from,
        recurrence_timezone, created_at, updated_at
      )
      SELECT $1, calendar_id, author_id, event_type, summary,
             description, color, r_rule, locations, id,
             recurrence_timezone, now(), now()
      FROM events WHERE id = $2
      RETURNING *
    `;
    const newEvent = await conn.query(newEventQuery, [newEventId, originalEventId]);

    const moveQuery = `
      UPDATE event_instances
      SET event_id = $1, updated_at = now()
      WHERE event_id = $2 AND original_date >= $3
    `;
    await conn.query(moveQuery, [newEventId, originalEventId, instance.original_date]);

    return {
      originalEventId,
      newEventId,
      newEvent: newEvent.rows[0]
    };
  }

  // ============================================
  // Event Instance 테이블
  // ============================================

  async findInstanceById(conn, instanceId) {
    const query = `
      SELECT id, event_id, instance_type, parent_id,
             summary, description, color, locations,
             is_all_day, original_date, start_date, end_date,
             created_at, updated_at, deleted_at
      FROM event_instances
      WHERE id = $1 AND deleted_at IS NULL
    `;
    const result = await conn.query(query, [instanceId]);
    return result.rows[0] || null;
  }

  // TaskDAO.findInstanceContext(taskDAO.js:226-234)와 동일 패턴 — 인스턴스가 실제로
  // 해당 event_id에 속하는지 확인하면서 인가에 필요한 calendar_id/binder_id/author_id를 한 번에 확보한다.
  async findInstanceContext(conn, eventId, instanceId) {
    const result = await conn.query(`
      SELECT ei.id, ei.deleted_at, e.calendar_id, e.author_id, c.binder_id
      FROM event_instances ei
      JOIN events e ON e.id = ei.event_id
      JOIN calendars c ON c.id = e.calendar_id
      WHERE ei.id = $1 AND ei.event_id = $2 AND ei.deleted_at IS NULL
        AND e.deleted_at IS NULL AND c.deleted_at IS NULL
    `, [instanceId, eventId]);
    return result.rows[0] || null;
  }

  async createEventInstance(conn, data) {
    const query = `
      INSERT INTO event_instances (
        id, event_id, instance_type, parent_id,
        summary, description, color, locations,
        is_all_day, original_date, start_date, end_date,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        COALESCE($13, now()), COALESCE($14, now())
      )
      RETURNING *
    `;

    const result = await conn.query(query, [
      data.id,
      data.event_id,
      data.instance_type || 0,
      data.parent_id || null,
      data.summary || null,
      data.description || null,
      data.color || null,
      data.locations ? JSON.stringify(data.locations) : null,
      data.is_all_day || false,
      data.original_date,
      data.start_date,
      data.end_date,
      data.created_at,
      data.updated_at
    ]);
    return result.rows[0];
  }

  async updateEventInstance(conn, instanceId, updateData) {
    const { summary, description, color, locations, is_all_day, start_date, end_date } = updateData;
    const query = `
      UPDATE event_instances
      SET summary = COALESCE($1, summary),
          description = COALESCE($2, description),
          color = COALESCE($3, color),
          locations = COALESCE($4, locations),
          is_all_day = COALESCE($5, is_all_day),
          start_date = COALESCE($6, start_date),
          end_date = COALESCE($7, end_date),
          updated_at = now()
      WHERE id = $8 AND deleted_at IS NULL
      RETURNING *
    `;
    const result = await conn.query(query, [summary, description, color, locations ? JSON.stringify(locations) : null, is_all_day, start_date, end_date, instanceId]);
    return result.rows[0];
  }

  // ============================================
  // Event Participant 테이블
  // ============================================

  async addParticipantRaw(conn, instanceId, userId, invitedBy, state, memo) {
    const query = `
      INSERT INTO event_participants (instance_id, user_id, inviter_id, state, memo, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, now(), now())
      ON CONFLICT (instance_id, user_id) DO UPDATE
      SET state = $4, memo = $5, inviter_id = COALESCE($3, event_participants.inviter_id), updated_at = now(), deleted_at = NULL
    `;
    await conn.query(query, [instanceId, userId, invitedBy || null, state, memo ? JSON.stringify(memo) : null]);
  }

  async addParticipant(conn, instanceId, userId, invitedBy) {
    // state=1(invite) — 사후 초대(SC-event H22/액션 G)의 초기 상태. state=0(confirm)은
    // 호스트 전용 상태이며 여기서 부여하지 않는다(createEvent 시 addParticipantRaw로만 명시 지정).
    const query = `
      INSERT INTO event_participants (instance_id, user_id, inviter_id, state, created_at, updated_at)
      VALUES ($1, $2, $3, 1, now(), now())
      ON CONFLICT (instance_id, user_id) DO UPDATE
      SET deleted_at = NULL, state = 1, updated_at = now()
      RETURNING instance_id, user_id, inviter_id, state
    `;
    const result = await conn.query(query, [instanceId, userId, invitedBy || null]);
    return result.rows[0];
  }

  async findParticipant(conn, instanceId, userId) {
    const query = `
      SELECT instance_id, user_id, state, memo, created_at, updated_at, deleted_at
      FROM event_participants
      WHERE instance_id = $1 AND user_id = $2 AND deleted_at IS NULL
    `;
    const result = await conn.query(query, [instanceId, userId]);
    return result.rows[0] || null;
  }

  async updateParticipantState(conn, instanceId, userId, state) {
    const query = `
      UPDATE event_participants
      SET state = $1, updated_at = now()
      WHERE instance_id = $2 AND user_id = $3
    `;
    await conn.query(query, [state, instanceId, userId]);
  }

  async removeParticipant(conn, instanceId, userId) {
    const query = `
      UPDATE event_participants
      SET deleted_at = now(), updated_at = now()
      WHERE instance_id = $1 AND user_id = $2
    `;
    await conn.query(query, [instanceId, userId]);
  }

  // ============================================
  // Event Section 릴레이션 테이블
  // ============================================

  async addSection(conn, eventId, sectionId) {
    const query = `
      INSERT INTO event_sections (event_id, section_id)
      VALUES ($1, $2)
      ON CONFLICT (event_id, section_id) DO NOTHING
    `;
    await conn.query(query, [eventId, sectionId]);
  }

  async removeSection(conn, eventId, sectionId) {
    const query = `
      DELETE FROM event_sections
      WHERE event_id = $1 AND section_id = $2
    `;
    await conn.query(query, [eventId, sectionId]);
  }

  async getSectionByEventId(conn, eventId) {
    const query = `
      SELECT s.id, s.binder_id, s.title, s.access_scope, s.is_default,
             s.created_at, s.updated_at
      FROM event_sections es
      JOIN sections s ON es.section_id = s.id
      WHERE es.event_id = $1 AND s.deleted_at IS NULL
    `;
    const result = await conn.query(query, [eventId]);
    return result.rows;
  }
}

module.exports = {
  EventDAO: new EventDAO()
};
