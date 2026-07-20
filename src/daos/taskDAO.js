class TaskDAO {
  // ============================================
  // Task 마스터 테이블
  // ============================================

  async findById(conn, taskId) {
    const query = `
      SELECT id, cal_id, author_id, task_type,
             summary, description, priority, locations,
             r_rule, forked_from,
             created_at, updated_at, deleted_at
      FROM tasks
      WHERE id = $1 AND deleted_at IS NULL
    `;
    const result = await conn.query(query, [taskId]);
    return result.rows[0] || null;
  }

  async createTask(conn, data) {
    const taskQuery = `
      INSERT INTO tasks (
        id, cal_id, author_id, task_type,
        summary, description, priority, locations,
        r_rule, forked_from, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now()
      )
      RETURNING *
    `;
    const taskResult = await conn.query(taskQuery, [
      data.id,
      data.cal_id,
      data.author_id,
      data.task_type || 0,
      data.summary,
      data.description || null,
      data.priority || 0,
      data.locations ? JSON.stringify(data.locations) : null,
      data.r_rule || null,
      data.forked_from || null
    ]);

    if (data.instances && data.instances.length > 0) {
      for (const instance of data.instances) {
        await this.createTaskInstance(conn, {
          ...instance,
          task_id: data.id
        });

        if (instance.participants && instance.participants.length > 0) {
          for (const participant of instance.participants) {
            await this.addParticipantRaw(conn, instance.id, participant.user_id, participant.state);
          }
        }
      }
    }

    return taskResult.rows[0];
  }

  async updateTask(conn, taskId, updateData) {
    const { summary, description, priority, locations, r_rule } = updateData;
    const query = `
      UPDATE tasks
      SET summary = COALESCE($1, summary),
          description = COALESCE($2, description),
          priority = COALESCE($3, priority),
          locations = COALESCE($4, locations),
          r_rule = COALESCE($5, r_rule),
          updated_at = now()
      WHERE id = $6 AND deleted_at IS NULL
      RETURNING *
    `;
    const result = await conn.query(query, [
      summary, description, priority,
      locations ? JSON.stringify(locations) : null,
      r_rule, taskId
    ]);
    return result.rows[0];
  }

  async softDeleteTask(conn, taskId) {
    const query = `
      UPDATE tasks
      SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
    `;
    await conn.query(query, [taskId]);
  }

  async splitTask(conn, originalTaskId, instanceId, newTaskId) {
    const instance = await this.findInstanceById(conn, instanceId);
    if (!instance) {
      const error = new Error("인스턴스를 찾을 수 없습니다");
      error.status = 404;
      throw error;
    }

    const originalTask = await this.findById(conn, originalTaskId);
    if (!originalTask) {
      const error = new Error("할 일을 찾을 수 없습니다");
      error.status = 404;
      throw error;
    }

    const newTaskQuery = `
      INSERT INTO tasks (
        id, cal_id, author_id, task_type,
        summary, description, priority, locations,
        r_rule, forked_from, created_at, updated_at
      )
      SELECT $1, cal_id, author_id, task_type,
             summary, description, priority, locations,
             r_rule, id, now(), now()
      FROM tasks WHERE id = $2
      RETURNING *
    `;
    const newTask = await conn.query(newTaskQuery, [newTaskId, originalTaskId]);

    const moveQuery = `
      UPDATE task_instances
      SET task_id = $1, updated_at = now()
      WHERE task_id = $2 AND original_date >= $3
    `;
    await conn.query(moveQuery, [newTaskId, originalTaskId, instance.original_date]);

    return {
      original_task_id: originalTaskId,
      new_task_id: newTaskId,
      new_task: newTask.rows[0]
    };
  }

  // ============================================
  // Task Instance 테이블
  // ============================================

  async findInstanceById(conn, instanceId) {
    const query = `
      SELECT id, task_id, instance_type, parent_id,
             summary, description, priority, locations,
             is_all_day, completion_rule, original_date,
             available_from, due_date, completed_at,
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
        available_from, due_date,
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
      data.available_from || null,
      data.due_date
    ]);
    return result.rows[0];
  }

  async updateTaskInstance(conn, instanceId, updateData) {
    const { summary, description, priority, locations, is_all_day, completion_rule, available_from, due_date } = updateData;
    const query = `
      UPDATE task_instances
      SET summary = COALESCE($1, summary),
          description = COALESCE($2, description),
          priority = COALESCE($3, priority),
          locations = COALESCE($4, locations),
          is_all_day = COALESCE($5, is_all_day),
          completion_rule = COALESCE($6, completion_rule),
          available_from = COALESCE($7, available_from),
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
      available_from,
      due_date,
      instanceId
    ]);
    return result.rows[0];
  }

  async softDeleteTaskInstance(conn, instanceId) {
    const query = `
      UPDATE task_instances
      SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
    `;
    await conn.query(query, [instanceId]);
  }

  // ============================================
  // Task Instance Participants 테이블
  // ============================================

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
    RETURNING instance_id, user_id, state
  `;
    const result = await conn.query(query, [instanceId, userId]);
    return result.rows[0];
  }

  async addParticipantsBatch(conn, instanceId, userIds) {
    if (!userIds.length) return [];
    const values = userIds.map((_, i) => `($1, $${i + 2}, 0, now(), now())`).join(', ');
    const query = `
      INSERT INTO task_participants (instance_id, user_id, state, created_at, updated_at)
      VALUES ${values}
      ON CONFLICT (instance_id, user_id) DO UPDATE
      SET
        deleted_at = NULL,
        state = 0,
        memo = NULL,
        completed_at = NULL,
        updated_at = now()
      RETURNING instance_id, user_id, state
    `;
    const result = await conn.query(query, [instanceId, ...userIds]);
    return result.rows;
  }

  async removeParticipant(conn, instanceId, userId) {
    const query = `
      UPDATE task_participants
      SET deleted_at = now(),
          updated_at = now()
      WHERE instance_id = $1
        AND user_id = $2
    `;
    await conn.query(query, [instanceId, userId]);
  }

  async removeParticipantsBatch(conn, instanceId, userIds) {
    if (!userIds.length) return;
    const placeholders = userIds.map((_, i) => `$${i + 2}`).join(', ');
    const query = `
      UPDATE task_participants
      SET deleted_at = now(),
          updated_at = now()
      WHERE instance_id = $1
        AND user_id IN (${placeholders})
    `;
    await conn.query(query, [instanceId, ...userIds]);
  }

  async updateParticipantState(conn, instanceId, userId, updates) {
    const fields = [];
    const values = [];
    let argIndex = 1;

    const mapping = {
      state: "state",
      memo: "memo",
      completed_at: "completed_at"
    };

    for (const [key, columnName] of Object.entries(mapping)) {
      if (updates[key] !== undefined) {
        fields.push(`${columnName} = $${argIndex++}`);

        if (key === "memo" && updates[key] !== null) {
          values.push(JSON.stringify(updates[key]));
        } else {
          values.push(updates[key]);
        }
      }
    }

    if (fields.length === 0) return;

    fields.push(`updated_at = now()`);
    values.push(instanceId, userId);

    const query = `
    UPDATE task_participants
    SET ${fields.join(", ")}
    WHERE instance_id = $${argIndex++}
      AND user_id = $${argIndex++}
  `;

    await conn.query(query, values);
  }

  // ============================================
  // Task Series 릴레이션 테이블
  // ============================================

  async addSeries(conn, taskId, seriesId) {
    const query = `
      INSERT INTO task_series (task_id, series_id, created_at, updated_at)
      VALUES ($1, $2, now(), now())
      ON CONFLICT (task_id, series_id) DO UPDATE
      SET deleted_at = NULL, updated_at = now()
    `;
    await conn.query(query, [taskId, seriesId]);
  }

  async removeSeries(conn, taskId, seriesId) {
    const query = `
      UPDATE task_series
      SET deleted_at = now(), updated_at = now()
      WHERE task_id = $1 AND series_id = $2 AND deleted_at IS NULL
    `;
    await conn.query(query, [taskId, seriesId]);
  }

  async getSeriesByTaskId(conn, taskId) {
    const query = `
      SELECT s.id, s.drawer_id, s.title, s.access_scope, s.required_grade, s.is_default,
             s.created_at, s.updated_at
      FROM task_series ts
      JOIN series s ON ts.series_id = s.id
      WHERE ts.task_id = $1 AND ts.deleted_at IS NULL AND s.deleted_at IS NULL
    `;
    const result = await conn.query(query, [taskId]);
    return result.rows;
  }
}

module.exports = {
  TaskDAO: new TaskDAO()
};
