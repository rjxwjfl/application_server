/**
 * src/daos/eventTaskDeleteCascadeRegression.test.js
 * =========================================================
 * RLY-20260806-027 회귀 스위트.
 *
 * 배경: `EventDAO.softDeleteEventInstance`가 정의돼 있지 않아 회차 삭제
 * (eventService.deleteEventInstance)가 호출 즉시 TypeError였다(결함 1). 또한
 * `softDeleteEvent`/`softDeleteTask`/`softDeleteTaskInstance`가 자기 행의
 * `deleted_at`만 세우고 하위(인스턴스·참가자·리마인더)로 전파하지 않아
 * 반복 일정(최대 365회차) 삭제 시 고아 행이 남았다(결함 2).
 *
 * 실 DB 없이 EventDAO/TaskDAO를 가짜 conn.query로 직접 호출하고, in-memory
 * store로 실제 UPDATE/DELETE의 WHERE 절 의미(특히 `deleted_at IS NULL` 가드)를
 * 재현한다. recurrenceTimezoneRegression.test.js·sectionCascadeRegression.test.js와
 * 동일 관행(가짜 connection, plain assert, `node <file>.js` 직접 실행)을 따른다.
 *
 * 실행: node src/daos/eventTaskDeleteCascadeRegression.test.js
 */

const assert = require('assert');
const { EventDAO } = require('./eventDAO');
const { TaskDAO } = require('./taskDAO');

function makeStore() {
  return {
    events: new Map(),
    eventInstances: new Map(),
    eventParticipants: new Map(),
    tasks: new Map(),
    taskInstances: new Map(),
    taskParticipants: new Map(),
    reminders: new Map(),
  };
}

function seedEvent(store, eventId, instanceCount, { withParticipant = true, withReminder = true } = {}) {
  store.events.set(eventId, { deleted_at: null });
  const instanceIds = [];
  for (let i = 0; i < instanceCount; i++) {
    const instanceId = `${eventId}-inst-${i}`;
    instanceIds.push(instanceId);
    store.eventInstances.set(instanceId, { event_id: eventId, deleted_at: null });
    if (withParticipant) {
      store.eventParticipants.set(`${instanceId}#user-1`, { instance_id: instanceId, deleted_at: null });
    }
    if (withReminder) {
      store.reminders.set(`rem-${instanceId}`, { target_type: 0, target_id: instanceId });
    }
  }
  return instanceIds;
}

function seedTask(store, taskId, instanceCount, { withParticipant = true, withReminder = true } = {}) {
  store.tasks.set(taskId, { deleted_at: null });
  const instanceIds = [];
  for (let i = 0; i < instanceCount; i++) {
    const instanceId = `${taskId}-inst-${i}`;
    instanceIds.push(instanceId);
    store.taskInstances.set(instanceId, { task_id: taskId, deleted_at: null });
    if (withParticipant) {
      store.taskParticipants.set(`${instanceId}#user-1`, { instance_id: instanceId, deleted_at: null });
    }
    if (withReminder) {
      store.reminders.set(`rem-${instanceId}`, { target_type: 1, target_id: instanceId });
    }
  }
  return instanceIds;
}

// 실 DB의 WHERE ... AND deleted_at IS NULL / RETURNING id 의미를 그대로 흉내낸다 —
// 문자열만 기록하는 게 아니라 store를 실제로 갱신해야 "이미 지워진 행이 덮이지 않는다"를
// 관찰로 검증할 수 있다.
function makeConn(store) {
  const queryLog = [];
  return {
    queryLog,
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      queryLog.push({ sql: s, params });

      if (s.startsWith('UPDATE events SET deleted_at')) {
        const [eventId] = params;
        const row = store.events.get(eventId);
        if (row && !row.deleted_at) row.deleted_at = new Date();
        return { rows: [] };
      }
      if (s.startsWith('UPDATE tasks SET deleted_at')) {
        const [taskId] = params;
        const row = store.tasks.get(taskId);
        if (row && !row.deleted_at) row.deleted_at = new Date();
        return { rows: [] };
      }

      if (s.startsWith('UPDATE event_instances SET deleted_at') && s.includes('WHERE event_id = $1')) {
        const [eventId] = params;
        const rows = [];
        for (const [id, inst] of store.eventInstances) {
          if (inst.event_id === eventId && !inst.deleted_at) {
            inst.deleted_at = new Date();
            rows.push({ id });
          }
        }
        return { rows };
      }
      if (s.startsWith('UPDATE event_instances SET deleted_at') && s.includes('WHERE id = $1')) {
        const [instanceId] = params;
        const inst = store.eventInstances.get(instanceId);
        const rows = [];
        if (inst && !inst.deleted_at) {
          inst.deleted_at = new Date();
          rows.push({ id: instanceId });
        }
        return { rows };
      }

      if (s.startsWith('UPDATE task_instances SET deleted_at') && s.includes('WHERE task_id = $1')) {
        const [taskId] = params;
        const rows = [];
        for (const [id, inst] of store.taskInstances) {
          if (inst.task_id === taskId && !inst.deleted_at) {
            inst.deleted_at = new Date();
            rows.push({ id });
          }
        }
        return { rows };
      }
      if (s.startsWith('UPDATE task_instances SET deleted_at') && s.includes('WHERE id = $1')) {
        const [instanceId] = params;
        const inst = store.taskInstances.get(instanceId);
        const rows = [];
        if (inst && !inst.deleted_at) {
          inst.deleted_at = new Date();
          rows.push({ id: instanceId });
        }
        return { rows };
      }

      if (s.startsWith('UPDATE event_participants SET deleted_at')) {
        const [instanceIds] = params;
        for (const p of store.eventParticipants.values()) {
          if (instanceIds.includes(p.instance_id) && !p.deleted_at) p.deleted_at = new Date();
        }
        return { rows: [] };
      }
      if (s.startsWith('UPDATE task_participants SET deleted_at')) {
        const [instanceIds] = params;
        for (const p of store.taskParticipants.values()) {
          if (instanceIds.includes(p.instance_id) && !p.deleted_at) p.deleted_at = new Date();
        }
        return { rows: [] };
      }

      if (s.startsWith('DELETE FROM reminders')) {
        const [targetType, targetIds] = params;
        for (const [id, r] of [...store.reminders.entries()]) {
          if (r.target_type === targetType && targetIds.includes(r.target_id)) {
            store.reminders.delete(id);
          }
        }
        return { rows: [] };
      }

      throw new Error(`[mock] Unhandled query: ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
    },
  };
}

async function run() {
  // ① 회차 삭제가 성공한다 — softDeleteEventInstance가 없어 TypeError였던 결함 1의 직접 재현.
  {
    const store = makeStore();
    const [instanceId] = seedEvent(store, 'ev-1', 1);
    const conn = makeConn(store);

    await EventDAO.softDeleteEventInstance(conn, instanceId); // 과거: TypeError - EventDAO.softDeleteEventInstance is not a function

    assert(store.eventInstances.get(instanceId).deleted_at, '①인스턴스가 삭제 처리돼야 한다');
  }

  // ② 이벤트 삭제 → 인스턴스·참가자·리마인더 전파
  {
    const store = makeStore();
    const instanceIds = seedEvent(store, 'ev-2', 2);
    const conn = makeConn(store);

    await EventDAO.softDeleteEvent(conn, 'ev-2');

    assert(store.events.get('ev-2').deleted_at, '②이벤트 자신이 삭제돼야 한다');
    for (const instanceId of instanceIds) {
      assert(store.eventInstances.get(instanceId).deleted_at, `②인스턴스 ${instanceId}가 전파돼야 한다`);
      assert(
        store.eventParticipants.get(`${instanceId}#user-1`).deleted_at,
        `②참가자(${instanceId})가 전파돼야 한다`
      );
      assert(!store.reminders.has(`rem-${instanceId}`), `②리마인더(${instanceId})가 삭제돼야 한다`);
    }
  }

  // ③ 태스크도 동일하게 전파된다(대칭)
  {
    const store = makeStore();
    const instanceIds = seedTask(store, 'tk-2', 2);
    const conn = makeConn(store);

    await TaskDAO.softDeleteTask(conn, 'tk-2');

    assert(store.tasks.get('tk-2').deleted_at, '③태스크 자신이 삭제돼야 한다');
    for (const instanceId of instanceIds) {
      assert(store.taskInstances.get(instanceId).deleted_at, `③인스턴스 ${instanceId}가 전파돼야 한다`);
      assert(
        store.taskParticipants.get(`${instanceId}#user-1`).deleted_at,
        `③참가자(${instanceId})가 전파돼야 한다`
      );
      assert(!store.reminders.has(`rem-${instanceId}`), `③리마인더(${instanceId})가 삭제돼야 한다`);
    }
  }

  // ④ 회차 단독 삭제 → 그 회차의 참가자·리마인더만 전파(형제 회차는 건드리지 않는다)
  {
    const store = makeStore();
    const [instanceA, instanceB] = seedEvent(store, 'ev-4', 2);
    const conn = makeConn(store);

    await EventDAO.softDeleteEventInstance(conn, instanceA);

    assert(store.eventInstances.get(instanceA).deleted_at, '④대상 회차는 삭제돼야 한다');
    assert(!store.eventInstances.get(instanceB).deleted_at, '④형제 회차는 건드리면 안 된다');
    assert(store.eventParticipants.get(`${instanceA}#user-1`).deleted_at, '④대상 회차 참가자가 전파돼야 한다');
    assert(!store.eventParticipants.get(`${instanceB}#user-1`).deleted_at, '④형제 회차 참가자는 건드리면 안 된다');
    assert(!store.reminders.has(`rem-${instanceA}`), '④대상 회차 리마인더가 삭제돼야 한다');
    assert(store.reminders.has(`rem-${instanceB}`), '④형제 회차 리마인더는 남아 있어야 한다');
  }

  // ⑤ 이미 지워진 행의 삭제 시각이 덮이지 않는다
  {
    const store = makeStore();
    const [instanceId] = seedEvent(store, 'ev-5', 1, { withReminder: false });
    const staleTimestamp = new Date('2020-01-01T00:00:00Z');
    store.eventParticipants.get(`${instanceId}#user-1`).deleted_at = staleTimestamp;
    const conn = makeConn(store);

    await EventDAO.softDeleteEventInstance(conn, instanceId);

    assert.strictEqual(
      store.eventParticipants.get(`${instanceId}#user-1`).deleted_at,
      staleTimestamp,
      '⑤이미 삭제된 참가자의 deleted_at을 덮으면 안 된다(30일 정리 cron 기준 시각 보존)'
    );

    // 이벤트 인스턴스 자체가 이미 삭제된 상태에서 다시 삭제를 시도해도 재전파(재기록)하지 않는다.
    const store2 = makeStore();
    const [instanceId2] = seedEvent(store2, 'ev-5b', 1);
    const conn2 = makeConn(store2);
    await EventDAO.softDeleteEventInstance(conn2, instanceId2);
    const firstTimestamp = store2.eventInstances.get(instanceId2).deleted_at;
    await EventDAO.softDeleteEventInstance(conn2, instanceId2); // 재호출 — no-op이어야 한다
    assert.strictEqual(
      store2.eventInstances.get(instanceId2).deleted_at,
      firstTimestamp,
      '⑤이미 삭제된 인스턴스를 재삭제해도 시각이 갱신되면 안 된다'
    );
  }

  // ⑥ 365회차 반복 항목이 한 번에(집합 단위 UPDATE로) 처리된다 — 행 단위 루프 금지
  {
    const store = makeStore();
    const instanceIds = seedEvent(store, 'ev-6', 365);
    const conn = makeConn(store);

    await EventDAO.softDeleteEvent(conn, 'ev-6');

    for (const instanceId of instanceIds) {
      assert(store.eventInstances.get(instanceId).deleted_at, `⑥인스턴스 ${instanceId} 누락`);
      assert(!store.reminders.has(`rem-${instanceId}`), `⑥리마인더 ${instanceId} 누락`);
    }

    const instanceBulkCalls = conn.queryLog.filter(
      (q) => q.sql.startsWith('UPDATE event_instances SET deleted_at') && q.sql.includes('WHERE event_id = $1')
    );
    const participantBulkCalls = conn.queryLog.filter((q) => q.sql.startsWith('UPDATE event_participants SET deleted_at'));
    const reminderBulkCalls = conn.queryLog.filter((q) => q.sql.startsWith('DELETE FROM reminders'));

    assert.strictEqual(instanceBulkCalls.length, 1, '⑥인스턴스 365개가 쿼리 1회(집합 UPDATE)로 처리돼야 한다');
    assert.strictEqual(participantBulkCalls.length, 1, '⑥참가자 365개가 쿼리 1회(집합 UPDATE)로 처리돼야 한다');
    assert.strictEqual(reminderBulkCalls.length, 1, '⑥리마인더 365개가 쿼리 1회(집합 DELETE)로 처리돼야 한다');
  }

  // ⑦ EventDAO·TaskDAO 메서드 대칭 단언 — 한쪽에만 있는 이름이 없어야 한다(재발 방지 장치).
  //   normalize: 각 이름에서 "Event"/"Task" 부분 문자열을 제거해 대응 이름으로 정규화한다.
  {
    const methodNames = (daoInstance) =>
      Object.getOwnPropertyNames(Object.getPrototypeOf(daoInstance)).filter(
        (name) => name !== 'constructor' && typeof daoInstance[name] === 'function'
      );

    // 의도적 비대칭 — 명시 예외 목록(근거 주석 포함). 새 비대칭이 필요하면 여기에 추가하고
    // 이유를 적을 것. 몰래 한쪽에만 메서드를 추가하면 이 테스트가 실패한다.
    const EVENT_ONLY_EXCEPTIONS = [];
    const TASK_ONLY_EXCEPTIONS = [
      // completion_rule(individual/anyOne/allRequired) 기반 완료 판정은 task_instances 전용
      // 개념이다 — event_instances에는 완료 상태 자체가 없어 대응 메서드가 없다.
      'reevaluateInstanceCompletion',
    ];

    const normalize = (name) => name.replace(/Event/g, '').replace(/Task/g, '');

    const eventNormalized = methodNames(EventDAO)
      .filter((n) => !EVENT_ONLY_EXCEPTIONS.includes(n))
      .map(normalize)
      .sort();
    const taskNormalized = methodNames(TaskDAO)
      .filter((n) => !TASK_ONLY_EXCEPTIONS.includes(n))
      .map(normalize)
      .sort();

    assert.deepStrictEqual(
      eventNormalized,
      taskNormalized,
      `⑦EventDAO·TaskDAO 메서드가 비대칭이다.\nEvent(정규화): ${JSON.stringify(eventNormalized)}\nTask(정규화): ${JSON.stringify(taskNormalized)}`
    );

    // softDeleteEventInstance가 실제로 존재하는지 직접 단언(결함 1 재발 방지 — 가장 직접적인 신호)
    assert.strictEqual(typeof EventDAO.softDeleteEventInstance, 'function', '⑦softDeleteEventInstance가 정의돼 있어야 한다');
  }

  console.log('eventTaskDeleteCascadeRegression: 7/7 assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
