const { cascadeDeleteInstanceChildren, cascadeDeleteItemSections, REMINDER_TARGET_TYPE } = require('./deleteCascadeHelpers');

class TaskDAO {
  // ============================================
  // Task 마스터 테이블
  // ============================================

  async findById(conn, taskId) {
    const query = `
      SELECT id, calendar_id, author_id, task_type,
             summary, description, priority, locations,
             r_rule, recurrence_timezone, reminder_offsets, forked_from,
             created_at, updated_at, deleted_at
      FROM tasks
      WHERE id = $1 AND deleted_at IS NULL
    `;
    const result = await conn.query(query, [taskId]);
    return result.rows[0] || null;
  }

  // 회차 목록(id·due_date)만 필요한 호출부용 — EventDAO.findInstancesByEventId와 동형
  // (RLY-20260806-026 컬럼 배선).
  async findInstancesByTaskId(conn, taskId) {
    const result = await conn.query(
      `SELECT id, due_date FROM task_instances WHERE task_id = $1 AND deleted_at IS NULL`,
      [taskId]
    );
    return result.rows;
  }

  // RLY-20260806-128 — EventDAO.findInstancesByBinder와 동형(SC-messaging.md §20-4 picker).
  // due_date가 NOT NULL(schema.sql)이라 start_date와 달리 NULLS LAST가 필요 없다.
  async findInstancesByBinder(conn, binderId, { cursor_at, limit = 20 } = {}) {
    const params = [binderId, limit];
    let where = 'c.binder_id = $1 AND ti.deleted_at IS NULL';
    if (cursor_at) {
      where += ' AND ti.due_date < $3';
      params.push(cursor_at);
    }
    const result = await conn.query(
      `SELECT ti.id, ti.task_id, ti.summary, ti.description, ti.priority, ti.is_all_day,
              ti.start_date, ti.due_date, ti.completed_at
       FROM task_instances ti
       JOIN tasks t ON t.id = ti.task_id
       JOIN calendars c ON c.id = t.calendar_id
       WHERE ${where}
       ORDER BY ti.due_date DESC LIMIT $2`,
      params
    );
    return result.rows;
  }

  async createTask(conn, data) {
    const taskQuery = `
      INSERT INTO tasks (
        id, calendar_id, author_id, task_type,
        summary, description, priority, locations,
        r_rule, forked_from, recurrence_timezone, reminder_offsets, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now()
      )
      RETURNING *
    `;
    const taskResult = await conn.query(taskQuery, [
      data.id,
      data.calendar_id,
      data.author_id,
      data.task_type || 0,
      data.summary,
      data.description || null,
      data.priority || 0,
      data.locations ? JSON.stringify(data.locations) : null,
      data.r_rule || null,
      data.forked_from || null,
      data.recurrence_timezone || null,
      // RLY-20260806-026 — Event와 동일 계약(SC-reminder §7-1).
      data.reminder_offsets ?? null,
    ]);

    if (data.instances && data.instances.length > 0) {
      for (const instance of data.instances) {
        await this.createTaskInstance(conn, {
          ...instance,
          task_id: data.id
        });

        if (instance.participants && instance.participants.length > 0) {
          for (const participant of instance.participants) {
            // RLY-20260806-031 — inviter_id는 task_participants에 없다(eventDAO.js와
            // 동일 사유·동일 2026-07-20 결정, schema.md changelog 참조).
            await this.addParticipantRaw(conn, instance.id, participant.user_id, participant.state);
          }
        }
      }
    }

    return taskResult.rows[0];
  }

  async updateTask(conn, taskId, updateData) {
    const { summary, description, priority, locations, r_rule, recurrence_timezone, reminder_offsets } = updateData;
    // recurrence_timezone은 COALESCE가 아니라 hasOwnProperty 기반 CASE WHEN을 쓴다 —
    // eventDAO.updateEvent와 동일 사유·동일 관례(postDAO.js/groupDAO.js). 다른 컬럼은
    // COALESCE 유지 — 통일하지 말 것(RLY-20260806-019, eventDAO.js 주석 참조).
    // reminder_offsets는 COALESCE로 충분하다 — eventDAO.updateEvent와 동일 사유(SC-reminder §7-1).
    const hasRecurrenceTimezone = Object.prototype.hasOwnProperty.call(updateData, 'recurrence_timezone');
    const query = `
      UPDATE tasks
      SET summary = COALESCE($1, summary),
          description = COALESCE($2, description),
          priority = COALESCE($3, priority),
          locations = COALESCE($4, locations),
          r_rule = COALESCE($5, r_rule),
          recurrence_timezone = CASE WHEN $6 THEN $7 ELSE recurrence_timezone END,
          reminder_offsets = COALESCE($8, reminder_offsets),
          updated_at = now()
      WHERE id = $9 AND deleted_at IS NULL
      RETURNING *
    `;
    const result = await conn.query(query, [
      summary, description, priority,
      locations ? JSON.stringify(locations) : null,
      r_rule,
      hasRecurrenceTimezone, recurrence_timezone,
      reminder_offsets ?? null,
      taskId
    ]);
    return result.rows[0];
  }

  // 항목 삭제 → 인스턴스·참가자·리마인더 전파 (RLY-20260806-027). EventDAO.softDeleteEvent와
  // 대칭 — 한쪽만 고치면 반복 일정(최대 365회차)에서 고아 행이 쌓인다.
  async softDeleteTask(conn, taskId) {
    const query = `
      UPDATE tasks
      SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
    `;
    await conn.query(query, [taskId]);

    const instancesResult = await conn.query(
      `UPDATE task_instances
       SET deleted_at = now(), updated_at = now()
       WHERE task_id = $1 AND deleted_at IS NULL
       RETURNING id`,
      [taskId]
    );
    const instanceIds = instancesResult.rows.map((row) => row.id);

    await cascadeDeleteInstanceChildren(conn, {
      participantTable: 'task_participants',
      reminderTargetType: REMINDER_TARGET_TYPE.TASK_INSTANCE,
      instanceIds,
    });

    // task_sections는 owner-키 자원 — 항목 삭제에서만 전파한다(EventDAO.softDeleteEvent와
    // 대칭, RLY-20260806-029). softDeleteTaskInstance에서는 부르지 않는다.
    await cascadeDeleteItemSections(conn, {
      sectionTable: 'task_sections',
      itemColumn: 'task_id',
      itemId: taskId,
    });
  }

  // ============================================================================================
  // 범위 편집(fork) — RLY-20260806-034. EventDAO의 대칭 5개 메서드와 동일 패턴 —
  // TaskService.applyRecurrenceScope 하나가 이들을 조합해 PATCH scope와 split alias를 처리한다.
  // ============================================================================================

  // RLY-20260806-041 — eventDao.js의 findByIdForUpdate와 동일 사유(reminder_offsets를
  // SELECT에 추가, 026 후속 배선이 끝나 옛 경계 사유가 사라졌다).
  async findByIdForUpdate(conn, taskId) {
    const query = `
      SELECT id, calendar_id, author_id, task_type,
             summary, description, priority, locations,
             r_rule, recurrence_timezone, reminder_offsets, forked_from,
             created_at, updated_at, deleted_at
      FROM tasks
      WHERE id = $1 AND deleted_at IS NULL
      FOR UPDATE
    `;
    const result = await conn.query(query, [taskId]);
    return result.rows[0] || null;
  }

  async deleteInstancesFromBoundary(conn, taskId, boundaryDate) {
    const result = await conn.query(
      `UPDATE task_instances
       SET deleted_at = now(), updated_at = now()
       WHERE task_id = $1 AND original_date >= $2 AND deleted_at IS NULL
       RETURNING id`,
      [taskId, boundaryDate]
    );
    return result.rows.map((row) => row.id);
  }

  async countActiveInstances(conn, taskId) {
    const result = await conn.query(
      `SELECT COUNT(*)::int AS count FROM task_instances WHERE task_id = $1 AND deleted_at IS NULL`,
      [taskId]
    );
    return result.rows[0].count;
  }

  // RLY-20260806-037 — eventDao.js의 findEarliestActiveInstance와 동일 사유·동일 계약(all_upcoming
  // r_rule 독립 전개의 DTSTART). deleteInstancesFromBoundary 호출 전에 불러야 한다.
  async findEarliestActiveInstance(conn, taskId) {
    const result = await conn.query(
      `SELECT id, original_date, is_all_day
       FROM task_instances
       WHERE task_id = $1 AND deleted_at IS NULL
       ORDER BY original_date ASC
       LIMIT 1`,
      [taskId]
    );
    return result.rows[0] || null;
  }

  // RLY-20260806-041 — eventDao.js의 createForkEvent와 동일 사유(reminder_offsets를 INSERT
  // 목록에 추가, 026 후속 배선이 끝나 옛 경계 사유가 사라졌다).
  async createForkTask(conn, data) {
    const query = `
      INSERT INTO tasks (
        id, calendar_id, author_id, task_type, summary,
        description, priority, locations, r_rule, forked_from,
        recurrence_timezone, reminder_offsets, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now()
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING *
    `;
    const result = await conn.query(query, [
      data.id,
      data.calendar_id,
      data.author_id,
      data.task_type,
      data.summary,
      data.description || null,
      data.priority,
      data.locations ? JSON.stringify(data.locations) : null,
      data.r_rule || null,
      data.forked_from,
      data.recurrence_timezone || null,
      data.reminder_offsets || null,
    ]);
    if (result.rows[0]) return result.rows[0];
    return this.findById(conn, data.id);
  }

  // 참가자는 절대 넣지 않는다(명단 초기화 — 결정 64). completion_rule은 클라가 각 instance에
  // 실어 보낸 값을 그대로 쓴다 — tasks(owner)에 default_completion_rule 컬럼이 없다(schema.sql에
  // 없음, domain.md §3-13 표가 언급하는 컬럼이 아직 이식 안 됨 — 구현 보고서에 명시). 이 컬럼
  // 부재는 createTask의 기존 동작(인스턴스별 값 사용)과도 일치해 새 문제를 만들지 않는다.
  async insertInstancesBulk(conn, taskId, instances) {
    if (!instances || instances.length === 0) return [];

    const values = [];
    const params = [];
    let idx = 1;
    for (const instance of instances) {
      values.push(
        `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, now(), now())`
      );
      params.push(
        instance.id,
        taskId,
        instance.instance_type || 0,
        instance.parent_id || null,
        instance.summary || null,
        instance.description || null,
        instance.priority || 0,
        instance.locations ? JSON.stringify(instance.locations) : null,
        instance.is_all_day || false,
        instance.completion_rule || 0,
        instance.original_date,
        instance.start_date || null,
        instance.due_date,
      );
    }

    const query = `
      INSERT INTO task_instances (
        id, task_id, instance_type, parent_id,
        summary, description, priority, locations,
        is_all_day, completion_rule, original_date,
        start_date, due_date,
        created_at, updated_at
      ) VALUES ${values.join(', ')}
      ON CONFLICT (id) DO NOTHING
      RETURNING *
    `;
    const result = await conn.query(query, params);
    return result.rows;
  }

  // ============================================
  // Task Instance 테이블
  // ============================================

  async findInstanceById(conn, instanceId) {
    const query = `
      SELECT id, task_id, instance_type, parent_id,
             summary, description, priority, locations,
             is_all_day, completion_rule, original_date,
             start_date, due_date, completed_at,
             created_at, updated_at, deleted_at
      FROM task_instances
      WHERE id = $1 AND deleted_at IS NULL
    `;
    const result = await conn.query(query, [instanceId]);
    return result.rows[0] || null;
  }

  async createTaskInstance(conn, data) {
    const query = `
      INSERT INTO task_instances (
        id, task_id, instance_type, parent_id,
        summary, description, priority, locations,
        is_all_day, completion_rule, original_date,
        start_date, due_date,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), now()
      )
      RETURNING *
    `;
    const result = await conn.query(query, [
      data.id,
      data.task_id,
      data.instance_type || 0,
      data.parent_id || null,
      data.summary || null,
      data.description || null,
      data.priority || 0,
      data.locations ? JSON.stringify(data.locations) : null,
      data.is_all_day || false,
      data.completion_rule || 0,
      data.original_date,
      data.start_date || null,
      data.due_date
    ]);
    return result.rows[0];
  }

  async updateTaskInstance(conn, instanceId, updateData) {
    const { summary, description, priority, locations, is_all_day, completion_rule, start_date, due_date } = updateData;
    const query = `
      UPDATE task_instances
      SET summary = COALESCE($1, summary),
          description = COALESCE($2, description),
          priority = COALESCE($3, priority),
          locations = COALESCE($4, locations),
          is_all_day = COALESCE($5, is_all_day),
          completion_rule = COALESCE($6, completion_rule),
          start_date = COALESCE($7, start_date),
          due_date = COALESCE($8, due_date),
          updated_at = now()
      WHERE id = $9 AND deleted_at IS NULL
      RETURNING *
    `;
    const result = await conn.query(query, [
      summary,
      description,
      priority,
      locations ? JSON.stringify(locations) : undefined,
      is_all_day,
      completion_rule,
      start_date,
      due_date,
      instanceId
    ]);
    return result.rows[0];
  }

  // 회차 삭제 → 그 회차의 참가자·리마인더로 전파 (RLY-20260806-027 결함 2).
  // EventDAO.softDeleteEventInstance와 대칭.
  async softDeleteTaskInstance(conn, instanceId) {
    const result = await conn.query(
      `UPDATE task_instances
       SET deleted_at = now(), updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id`,
      [instanceId]
    );
    const instanceIds = result.rows.map((row) => row.id);

    await cascadeDeleteInstanceChildren(conn, {
      participantTable: 'task_participants',
      reminderTargetType: REMINDER_TARGET_TYPE.TASK_INSTANCE,
      instanceIds,
    });
  }

  // ============================================
  // Task Instance Participants 테이블
  // ============================================

  // t.reminder_offsets도 함께 실어 온다 — RLY-20260806-026: 회차 마감일만 바뀌는 갱신에서
  // 리마인더를 재파생할 때 이 값이 유일한 오프셋 출처다(역산 경로 없음, eventDao.js와 동일).
  async findInstanceContext(conn, taskId, instanceId) {
    const result = await conn.query(`
      SELECT ti.id, ti.completion_rule, ti.deleted_at, t.calendar_id, t.author_id, c.binder_id, t.reminder_offsets
      FROM task_instances ti
      JOIN tasks t ON t.id = ti.task_id
      JOIN calendars c ON c.id = t.calendar_id
      WHERE ti.id = $1 AND ti.task_id = $2 AND ti.deleted_at IS NULL
        AND t.deleted_at IS NULL AND c.deleted_at IS NULL
    `, [instanceId, taskId]);
    return result.rows[0] || null;
  }

  async findParticipant(conn, instanceId, userId) {
    const result = await conn.query(`
      SELECT instance_id, user_id, state, memo, completed_at, deleted_at
      FROM task_participants
      WHERE instance_id = $1 AND user_id = $2
    `, [instanceId, userId]);
    return result.rows[0] || null;
  }

  // RLY-20260806-031 — task_participants에 inviter_id 컬럼이 없다(eventDAO.js와 동일 사유·
  // 동일 2026-07-20 결정).
  async addParticipantRaw(conn, instanceId, userId, state) {
    const query = `
      INSERT INTO task_participants (instance_id, user_id, state, created_at, updated_at)
      VALUES ($1, $2, $3, now(), now())
      ON CONFLICT (instance_id, user_id) DO UPDATE
      SET state = $3, updated_at = now(), deleted_at = NULL
    `;
    await conn.query(query, [instanceId, userId, state || 0]);
  }

  async addParticipant(conn, instanceId, userId) {
    const query = `
    INSERT INTO task_participants (instance_id, user_id, state, created_at, updated_at)
    VALUES ($1, $2, 0, now(), now())
    ON CONFLICT (instance_id, user_id) DO UPDATE
    SET
      deleted_at = NULL,
      state = 0,
      memo = NULL,
      completed_at = NULL,
      updated_at = now()
    RETURNING instance_id, user_id, state, memo, completed_at, deleted_at
  `;
    const result = await conn.query(query, [instanceId, userId]);
    return result.rows[0];
  }

  async removeParticipant(conn, instanceId, userId) {
    const query = `
      UPDATE task_participants
      SET deleted_at = now(),
          updated_at = now()
      WHERE instance_id = $1
        AND user_id = $2
        AND deleted_at IS NULL
      RETURNING instance_id, user_id, state, memo, completed_at, deleted_at
    `;
    const result = await conn.query(query, [instanceId, userId]);
    return result.rows[0] || null;
  }

  async updateParticipantState(conn, instanceId, userId, state, memo) {
    const result = await conn.query(`
      UPDATE task_participants
      SET state = $3::smallint,
          memo = $4,
          completed_at = CASE WHEN $3::smallint = 3 THEN now() ELSE NULL END,
          updated_at = now()
      WHERE instance_id = $1 AND user_id = $2 AND deleted_at IS NULL
      RETURNING instance_id, user_id, state, memo, completed_at, deleted_at
    `, [instanceId, userId, state, memo === null ? null : JSON.stringify(memo)]);
    return result.rows[0] || null;
  }

  async reevaluateInstanceCompletion(conn, instanceId) {
    const result = await conn.query(`
      WITH counts AS (
        SELECT COUNT(*)::int AS active_count,
               COUNT(*) FILTER (WHERE state = 3)::int AS done_count
        FROM task_participants
        WHERE instance_id = $1 AND deleted_at IS NULL
      )
      UPDATE task_instances ti
      SET completed_at = CASE
            WHEN ti.completion_rule = 0 OR counts.active_count = 0 THEN NULL
            WHEN ti.completion_rule = 1 AND counts.done_count >= 1
              THEN COALESCE(ti.completed_at, now())
            WHEN ti.completion_rule = 2 AND counts.done_count = counts.active_count
              THEN COALESCE(ti.completed_at, now())
            ELSE NULL
          END,
          updated_at = now()
      FROM counts
      WHERE ti.id = $1
      RETURNING ti.completed_at
    `, [instanceId]);
    return result.rows[0] || null;
  }

  // ============================================
  // Task Section 릴레이션 테이블
  // ============================================

  async addSection(conn, taskId, sectionId) {
    const query = `
      INSERT INTO task_sections (task_id, section_id, created_at, updated_at)
      VALUES ($1, $2, now(), now())
      ON CONFLICT (task_id, section_id) DO UPDATE
      SET deleted_at = NULL, updated_at = now()
    `;
    await conn.query(query, [taskId, sectionId]);
  }

  async removeSection(conn, taskId, sectionId) {
    const query = `
      UPDATE task_sections
      SET deleted_at = now(), updated_at = now()
      WHERE task_id = $1 AND section_id = $2 AND deleted_at IS NULL
    `;
    await conn.query(query, [taskId, sectionId]);
  }

  async getSectionByTaskId(conn, taskId) {
    const query = `
      SELECT s.id, s.binder_id, s.title, s.access_scope, s.is_default,
             s.created_at, s.updated_at
      FROM task_sections ts
      JOIN sections s ON ts.section_id = s.id
      WHERE ts.task_id = $1 AND ts.deleted_at IS NULL AND s.deleted_at IS NULL
    `;
    const result = await conn.query(query, [taskId]);
    return result.rows;
  }
}

module.exports = {
  TaskDAO: new TaskDAO()
};
