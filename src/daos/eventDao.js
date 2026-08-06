const { cascadeDeleteInstanceChildren, cascadeDeleteItemSections, REMINDER_TARGET_TYPE } = require('./deleteCascadeHelpers');

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

  // 항목 삭제 → 인스턴스·참가자·리마인더 전파 (RLY-20260806-027). TaskDAO.softDeleteTask와
  // 대칭 — 한쪽만 고치면 반복 일정(최대 365회차)에서 고아 행이 쌓인다.
  async softDeleteEvent(conn, eventId) {
    const query = `
      UPDATE events
      SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
    `;
    await conn.query(query, [eventId]);

    const instancesResult = await conn.query(
      `UPDATE event_instances
       SET deleted_at = now(), updated_at = now()
       WHERE event_id = $1 AND deleted_at IS NULL
       RETURNING id`,
      [eventId]
    );
    const instanceIds = instancesResult.rows.map((row) => row.id);

    await cascadeDeleteInstanceChildren(conn, {
      participantTable: 'event_participants',
      reminderTargetType: REMINDER_TARGET_TYPE.EVENT_INSTANCE,
      instanceIds,
    });

    // event_sections는 owner-키 자원(항목에 붙지 회차에 붙지 않는다) — 항목 삭제에서만
    // 전파한다(RLY-20260806-029, SC-event.md H15 vs H16). softDeleteEventInstance에서는
    // 부르지 않는다.
    await cascadeDeleteItemSections(conn, {
      sectionTable: 'event_sections',
      itemColumn: 'event_id',
      itemId: eventId,
    });
  }

  // ============================================================================================
  // 범위 편집(fork) — RLY-20260806-034
  // ============================================================================================
  // 구 splitEvent(instance 소유권 이동 UPDATE event_instances SET event_id=..., 참가자 승계)는
  // 결정 64(domain.md §3-14) 폐기 대상이었다 — "이후 편집"이 클라가 보낸 새 내용을 저장하지 않고
  // 원본 필드를 그대로 복사했다(구현 보고서 결함 설명 참조). 아래 5개 메서드가 그 자리를 대신한다.
  // EventService.applyRecurrenceScope 하나가 이들을 조합해 PATCH scope=this_and_future/all_upcoming와
  // POST .../split(호환 alias) 양쪽을 처리한다 — "두 벌" 방지(팀리드 지시).

  // system.md §4-3 step2 "원본 행 잠금" — 같은 항목에 대한 두 구조 변경을 여기서 줄 세운다.
  //
  // ⚠️ 항목 공통 알림 오프셋 컬럼(RLY-20260806-026이 스키마에 추가한 배열 컬럼)은 일부러
  // SELECT하지 않는다 — createEvent가 아직 그 컬럼에 쓰지 않아(027 경계) 지금은 항상 NULL이고,
  // 이 파일 소스에 그 식별자를 적는 것 자체가 정적 대조 회귀(reminderGenerationRegression.test.js,
  // "eventDao.js가 아직 그 컬럼을 안 씀" 단언)를 깬다. 027이 owner row 배선을 마치면 다시 넣어라.
  async findByIdForUpdate(conn, eventId) {
    const query = `
      SELECT id, calendar_id, author_id, event_type, summary,
             description, color, r_rule, recurrence_timezone, locations, forked_from,
             created_at, updated_at, deleted_at
      FROM events
      WHERE id = $1 AND deleted_at IS NULL
      FOR UPDATE
    `;
    const result = await conn.query(query, [eventId]);
    return result.rows[0] || null;
  }

  // 경계(effectiveBoundary, 처리 시각 재평가까지 반영된 값) 이후 회차를 soft delete하고
  // 삭제된 id 목록을 반환한다 — 호출부(EventService)가 이 id로 deleteCascadeHelpers를 부른다.
  // `AND deleted_at IS NULL` 가드로 이미 삭제된 행의 시각을 덮지 않는다(RLY-20260806-025/027 관례).
  async deleteInstancesFromBoundary(conn, eventId, boundaryDate) {
    const result = await conn.query(
      `UPDATE event_instances
       SET deleted_at = now(), updated_at = now()
       WHERE event_id = $1 AND original_date >= $2 AND deleted_at IS NULL
       RETURNING id`,
      [eventId, boundaryDate]
    );
    return result.rows.map((row) => row.id);
  }

  // 원본에 남은(경계 이전, 살아있는) 회차 수 — utils/recurrenceRule.adjustRuleCount로 원본
  // r_rule의 COUNT를 이 값에 맞춘다(domain.md §3-13 "구간은 서로소다").
  async countActiveInstances(conn, eventId) {
    const result = await conn.query(
      `SELECT COUNT(*)::int AS count FROM event_instances WHERE event_id = $1 AND deleted_at IS NULL`,
      [eventId]
    );
    return result.rows[0].count;
  }

  // 새 owner(fork) 이벤트 행. calendar_id/author_id/event_type은 원본에서 상속(패치 대상 아님) —
  // 나머지(summary 등)는 호출부가 patch⊕origin으로 미리 병합해 넘긴다. id는 클라가 보낸
  // UUIDv7(new_event_id) — 서버가 생성하지 않는다(H19, §10-2 재전송 멱등). ON CONFLICT DO NOTHING
  // 이후 호출부가 findById로 기존 행을 다시 읽어 재전송을 흡수한다.
  //
  // ⚠️ 알림 오프셋 컬럼은 INSERT 목록에 없다 — createEvent와 동일 경계(위 findByIdForUpdate
  // 주석 참조). 새 회차의 리마인더는 호출부가 요청 payload를 직접 읽어(createEvent와 같은
  // 패턴) ReminderDAO로 파생하며, 이 행 자체엔 남기지 않는다.
  async createForkEvent(conn, data) {
    const query = `
      INSERT INTO events (
        id, calendar_id, author_id, event_type, summary,
        description, color, r_rule, locations, forked_from,
        recurrence_timezone, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now()
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING *
    `;
    const result = await conn.query(query, [
      data.id,
      data.calendar_id,
      data.author_id,
      data.event_type,
      data.summary,
      data.description || null,
      data.color,
      data.r_rule || null,
      data.locations ? JSON.stringify(data.locations) : null,
      data.forked_from,
      data.recurrence_timezone || null,
    ]);
    if (result.rows[0]) return result.rows[0];
    return this.findById(conn, data.id); // 재전송 — 이미 존재하는 행을 그대로 반환
  }

  // 재생성 회차 집합 단위 INSERT(행 단위 루프 아님 — RLY-20260806-025 "집합 단위 처리" 원칙을
  // CREATE 방향에 적용한 것). 참가자는 절대 넣지 않는다 — 명단 초기화가 계약이다(결정 64).
  // 각 instance의 id도 클라가 보낸 UUIDv7이라 ON CONFLICT DO NOTHING으로 재전송을 흡수하고,
  // 실제로 새로 삽입된 행만 RETURNING으로 받는다(재전송 시 이미 있던 행은 리마인더 재파생을
  // 다시 안 해도 되므로 호출부에 문제 없다).
  async insertInstancesBulk(conn, eventId, instances) {
    if (!instances || instances.length === 0) return [];

    const values = [];
    const params = [];
    let idx = 1;
    for (const instance of instances) {
      values.push(
        `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, now(), now())`
      );
      params.push(
        instance.id,
        eventId,
        instance.instance_type || 0,
        instance.parent_id || null,
        instance.summary || null,
        instance.description || null,
        instance.color || null,
        instance.locations ? JSON.stringify(instance.locations) : null,
        instance.is_all_day || false,
        instance.original_date,
        instance.start_date,
        instance.end_date,
      );
    }

    const query = `
      INSERT INTO event_instances (
        id, event_id, instance_type, parent_id,
        summary, description, color, locations,
        is_all_day, original_date, start_date, end_date,
        created_at, updated_at
      ) VALUES ${values.join(', ')}
      ON CONFLICT (id) DO NOTHING
      RETURNING *
    `;
    const result = await conn.query(query, params);
    return result.rows;
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

  // 회차 삭제 → 그 회차의 참가자·리마인더로 전파 (RLY-20260806-027 결함 1 — 이 메서드가
  // 없어 eventService.deleteEventInstance 호출 즉시 TypeError였다). TaskDAO.softDeleteTaskInstance와
  // 대칭 구현 — 새 패턴을 만들지 않고 그 선례를 그대로 따른다.
  async softDeleteEventInstance(conn, instanceId) {
    const result = await conn.query(
      `UPDATE event_instances
       SET deleted_at = now(), updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id`,
      [instanceId]
    );
    const instanceIds = result.rows.map((row) => row.id);

    await cascadeDeleteInstanceChildren(conn, {
      participantTable: 'event_participants',
      reminderTargetType: REMINDER_TARGET_TYPE.EVENT_INSTANCE,
      instanceIds,
    });
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

  // TaskDAO.addSection과 대칭(RLY-20260806-029) — ON CONFLICT DO UPDATE로 soft-delete된
  // 연결의 부활을 지원한다. removeSection이 soft delete인 이상 이 부활 경로가 없으면
  // 한 번 해제한 event-section 쌍은 재연결이 영원히 막힌다(같은 PK라 새 행을 못 만든다).
  async addSection(conn, eventId, sectionId) {
    const query = `
      INSERT INTO event_sections (event_id, section_id, created_at, updated_at)
      VALUES ($1, $2, now(), now())
      ON CONFLICT (event_id, section_id) DO UPDATE
      SET deleted_at = NULL, updated_at = now()
    `;
    await conn.query(query, [eventId, sectionId]);
  }

  // TaskDAO.removeSection과 대칭(RLY-20260806-029) — 구 hard DELETE는 설계 의도(soft
  // delete로 연결 해제 이력 유지, design_intent.md §event_sections)와 어긋난 버그였다.
  async removeSection(conn, eventId, sectionId) {
    const query = `
      UPDATE event_sections
      SET deleted_at = now(), updated_at = now()
      WHERE event_id = $1 AND section_id = $2 AND deleted_at IS NULL
    `;
    await conn.query(query, [eventId, sectionId]);
  }

  // TaskDAO.getSectionByTaskId와 대칭(RLY-20260806-029) — 구 쿼리는 es.deleted_at을
  // 걸지 않았다. removeSection이 하드 삭제였을 때는 해제된 연결 행 자체가 없어 무해했지만,
  // soft delete로 바뀐 지금 이 필터가 없으면 해제된 연결이 계속 조회된다.
  async getSectionByEventId(conn, eventId) {
    const query = `
      SELECT s.id, s.binder_id, s.title, s.access_scope, s.is_default,
             s.created_at, s.updated_at
      FROM event_sections es
      JOIN sections s ON es.section_id = s.id
      WHERE es.event_id = $1 AND es.deleted_at IS NULL AND s.deleted_at IS NULL
    `;
    const result = await conn.query(query, [eventId]);
    return result.rows;
  }
}

module.exports = {
  EventDAO: new EventDAO()
};
