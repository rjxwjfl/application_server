/**
 * src/daos/eventTaskDeleteCascadeRegression.test.js
 * =========================================================
 * RLY-20260806-027 회귀 스위트 (①~⑦) + RLY-20260806-029 확장 (⑧~⑫).
 *
 * RLY-20260806-027 배경: `EventDAO.softDeleteEventInstance`가 정의돼 있지 않아
 * 회차 삭제(eventService.deleteEventInstance)가 호출 즉시 TypeError였다(결함 1).
 * 또한 `softDeleteEvent`/`softDeleteTask`/`softDeleteTaskInstance`가 자기 행의
 * `deleted_at`만 세우고 하위(인스턴스·참가자·리마인더)로 전파하지 않아
 * 반복 일정(최대 365회차) 삭제 시 고아 행이 남았다(결함 2).
 *
 * RLY-20260806-029 배경: 027의 대칭 회귀(⑦)는 **이름**만 대조해 `EventDAO.removeSection`이
 * hard DELETE, `TaskDAO.removeSection`이 soft UPDATE로 **거동**이 갈라져 있던 것을 못 잡았다.
 * ⑧~⑪은 항목 삭제 → 섹션 연결(`event_sections`/`task_sections`) 전파를, ⑫는 그 거동
 * 비대칭 자체를 재발 방지 장치로 고정한다. 판정 근거(왜 soft인가)는
 * `deleteCascadeHelpers.cascadeDeleteItemSections`의 주석·구현 보고서 참조.
 *
 * 실 DB 없이 EventDAO/TaskDAO를 가짜 conn.query로 직접 호출하고, in-memory
 * store로 실제 UPDATE/DELETE의 WHERE 절 의미(특히 `deleted_at IS NULL` 가드)를
 * 재현한다. recurrenceTimezoneRegression.test.js·sectionCascadeRegression.test.js와
 * 동일 관행(가짜 connection, plain assert, `node <file>.js` 직접 실행)을 따른다.
 *
 * 실행: node src/daos/eventTaskDeleteCascadeRegression.test.js
 */

const assert = require('assert');
const { EventDAO } = require('./eventDao');
const { TaskDAO } = require('./taskDAO');

function makeStore() {
  return {
    events: new Map(),
    eventInstances: new Map(),
    eventParticipants: new Map(),
    eventSections: new Map(), // key: `${event_id}#${section_id}`
    tasks: new Map(),
    taskInstances: new Map(),
    taskParticipants: new Map(),
    taskSections: new Map(), // key: `${task_id}#${section_id}`
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

      // --- RLY-20260806-029: event_sections/task_sections ---

      // removeSection(itemId, sectionId) — 특정 쌍 하나만 대상. 항목-단위 캐스케이드보다
      // 조건절이 더 좁으므로(section_id까지 포함) 먼저 매칭해야 한다.
      if (s.startsWith('UPDATE event_sections SET deleted_at') && s.includes('AND section_id = $2')) {
        const [eventId, sectionId] = params;
        const link = store.eventSections.get(`${eventId}#${sectionId}`);
        if (link && !link.deleted_at) link.deleted_at = new Date();
        return { rows: [] };
      }
      if (s.startsWith('UPDATE task_sections SET deleted_at') && s.includes('AND section_id = $2')) {
        const [taskId, sectionId] = params;
        const link = store.taskSections.get(`${taskId}#${sectionId}`);
        if (link && !link.deleted_at) link.deleted_at = new Date();
        return { rows: [] };
      }

      // 항목 삭제 캐스케이드(cascadeDeleteItemSections) — 그 항목의 모든 섹션 링크.
      if (s.startsWith('UPDATE event_sections SET deleted_at')) {
        const [eventId] = params;
        for (const link of store.eventSections.values()) {
          if (link.event_id === eventId && !link.deleted_at) link.deleted_at = new Date();
        }
        return { rows: [] };
      }
      if (s.startsWith('UPDATE task_sections SET deleted_at')) {
        const [taskId] = params;
        for (const link of store.taskSections.values()) {
          if (link.task_id === taskId && !link.deleted_at) link.deleted_at = new Date();
        }
        return { rows: [] };
      }

      // addSection(itemId, sectionId) — INSERT ... ON CONFLICT ... . 실제 SQL의 conflict
      // 절을 그대로 해석한다(무조건 부활시키지 않는다) — 그래야 이 mock이 `DO NOTHING`으로
      // 되돌아가는 회귀를 실제로 잡는다. `DO UPDATE ... SET DELETED_AT = NULL`일 때만 부활,
      // 그 외(`DO NOTHING` 포함)는 기존 행을 그대로 둔다(= 부활 안 됨).
      if (s.startsWith('INSERT INTO event_sections')) {
        const [eventId, sectionId] = params;
        const key = `${eventId}#${sectionId}`;
        const existing = store.eventSections.get(key);
        const revivesOnConflict = s.toUpperCase().includes('DO UPDATE') && s.toUpperCase().includes('DELETED_AT = NULL');
        if (existing) {
          if (revivesOnConflict) existing.deleted_at = null;
        } else {
          store.eventSections.set(key, { event_id: eventId, section_id: sectionId, deleted_at: null });
        }
        return { rows: [] };
      }
      if (s.startsWith('INSERT INTO task_sections')) {
        const [taskId, sectionId] = params;
        const key = `${taskId}#${sectionId}`;
        const existing = store.taskSections.get(key);
        const revivesOnConflict = s.toUpperCase().includes('DO UPDATE') && s.toUpperCase().includes('DELETED_AT = NULL');
        if (existing) {
          if (revivesOnConflict) existing.deleted_at = null;
        } else {
          store.taskSections.set(key, { task_id: taskId, section_id: sectionId, deleted_at: null });
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

  // ======================= RLY-20260806-029 =======================

  // ⑧ 항목 삭제 → 섹션 연결이 정리된다(event_sections/task_sections)
  {
    const store = makeStore();
    seedEvent(store, 'ev-8', 1, { withParticipant: false, withReminder: false });
    store.eventSections.set('ev-8#sec-1', { event_id: 'ev-8', section_id: 'sec-1', deleted_at: null });
    const conn = makeConn(store);

    await EventDAO.softDeleteEvent(conn, 'ev-8');

    assert(store.eventSections.get('ev-8#sec-1').deleted_at, '⑧이벤트 삭제 시 섹션 연결이 정리돼야 한다');
  }
  {
    const store = makeStore();
    seedTask(store, 'tk-8', 1, { withParticipant: false, withReminder: false });
    store.taskSections.set('tk-8#sec-1', { task_id: 'tk-8', section_id: 'sec-1', deleted_at: null });
    const conn = makeConn(store);

    await TaskDAO.softDeleteTask(conn, 'tk-8');

    assert(store.taskSections.get('tk-8#sec-1').deleted_at, '⑧태스크 삭제 시 섹션 연결이 정리돼야 한다');
  }

  // ⑨ 회차 삭제는 항목의 섹션 연결과 무관하다 — owner-키 자원(SC-event.md H15 vs H16,
  //   design_intent.md §426). softDeleteEventInstance/softDeleteTaskInstance가 이걸 건드리면
  //   회귀다.
  {
    const store = makeStore();
    const [instanceId] = seedEvent(store, 'ev-9', 1, { withParticipant: false, withReminder: false });
    store.eventSections.set('ev-9#sec-1', { event_id: 'ev-9', section_id: 'sec-1', deleted_at: null });
    const conn = makeConn(store);

    await EventDAO.softDeleteEventInstance(conn, instanceId);

    assert(
      !store.eventSections.get('ev-9#sec-1').deleted_at,
      '⑨회차 삭제가 항목의 섹션 연결을 건드리면 안 된다(owner-키 자원)'
    );
  }

  // ⑩ removeSection·addSection이 두 DAO에서 동일하게 동작한다 — soft delete + 부활 왕복.
  {
    const store = makeStore();
    store.eventSections.set('ev-10#sec-1', { event_id: 'ev-10', section_id: 'sec-1', deleted_at: null });
    store.taskSections.set('tk-10#sec-1', { task_id: 'tk-10', section_id: 'sec-1', deleted_at: null });
    const conn = makeConn(store);

    await EventDAO.removeSection(conn, 'ev-10', 'sec-1');
    await TaskDAO.removeSection(conn, 'tk-10', 'sec-1');

    assert(store.eventSections.get('ev-10#sec-1').deleted_at, '⑩EventDAO.removeSection이 soft delete여야 한다');
    assert(store.taskSections.get('tk-10#sec-1').deleted_at, '⑩TaskDAO.removeSection이 soft delete여야 한다(기준선)');

    // 부활 — 같은 (item_id, section_id) 쌍은 PK라 새 행을 만들 수 없다. addSection이
    // deleted_at을 되살리지 못하면 한 번 해제한 쌍은 영원히 재연결이 막힌다.
    await EventDAO.addSection(conn, 'ev-10', 'sec-1');
    await TaskDAO.addSection(conn, 'tk-10', 'sec-1');

    assert.strictEqual(
      store.eventSections.get('ev-10#sec-1').deleted_at, null,
      '⑩EventDAO.addSection이 해제된 연결을 되살려야 한다(구 ON CONFLICT DO NOTHING 버그 재발 방지)'
    );
    assert.strictEqual(
      store.taskSections.get('tk-10#sec-1').deleted_at, null,
      '⑩TaskDAO.addSection이 해제된 연결을 되살려야 한다'
    );
  }

  // ⑪ 이미 정리된 섹션 연결의 삭제 시각이 덮이지 않는다.
  {
    const store = makeStore();
    const staleTimestamp = new Date('2020-01-01T00:00:00Z');
    seedEvent(store, 'ev-11', 0, { withParticipant: false, withReminder: false });
    store.eventSections.set('ev-11#sec-1', { event_id: 'ev-11', section_id: 'sec-1', deleted_at: staleTimestamp });
    const conn = makeConn(store);

    await EventDAO.softDeleteEvent(conn, 'ev-11');

    assert.strictEqual(
      store.eventSections.get('ev-11#sec-1').deleted_at,
      staleTimestamp,
      '⑪이미 해제된 섹션 연결의 삭제 시각을 덮으면 안 된다'
    );
  }

  // ⑫ 거동 대칭 회귀 — 027의 ⑦(이름 대조)은 이 결함(같은 이름·다른 SQL 종류)을 못 잡았다.
  //   같은 이름의 메서드 쌍이 같은 종류(soft UPDATE vs hard DELETE)의 SQL을 쓰는지 직접 비교한다.
  {
    function sqlKind(sql) {
      const s = sql.replace(/\s+/g, ' ').trim().toUpperCase();
      if (s.startsWith('DELETE FROM')) return 'hard-delete';
      if (s.startsWith('UPDATE') && s.includes('DELETED_AT = NOW()')) return 'soft-delete';
      return 'other';
    }

    const store = makeStore();
    store.eventSections.set('ev-12#sec-1', { event_id: 'ev-12', section_id: 'sec-1', deleted_at: null });
    store.taskSections.set('tk-12#sec-1', { task_id: 'tk-12', section_id: 'sec-1', deleted_at: null });
    const conn = makeConn(store);

    await EventDAO.removeSection(conn, 'ev-12', 'sec-1');
    await TaskDAO.removeSection(conn, 'tk-12', 'sec-1');

    const eventRemoveSql = conn.queryLog.find((q) => q.sql.includes('event_sections') && q.sql.includes('section_id = $2'))?.sql;
    const taskRemoveSql = conn.queryLog.find((q) => q.sql.includes('task_sections') && q.sql.includes('section_id = $2'))?.sql;
    assert(eventRemoveSql && taskRemoveSql, '⑫removeSection 호출이 기록돼야 한다');

    assert.strictEqual(
      sqlKind(eventRemoveSql),
      sqlKind(taskRemoveSql),
      `⑫EventDAO.removeSection과 TaskDAO.removeSection의 삭제 종류(soft/hard)가 같아야 한다.\nEvent: ${eventRemoveSql}\nTask: ${taskRemoveSql}`
    );
    assert.strictEqual(
      sqlKind(eventRemoveSql), 'soft-delete',
      '⑫removeSection은 soft delete여야 한다(판정 근거: cleanupJobs STEPS·SectionDAO.softDelete 선례·design_intent.md §event_sections "soft delete로 연결 해제 이력 유지")'
    );
  }

  // ⑬ 거동 대칭 회귀(addSection) — ⑫와 같은 문제가 addSection에도 있었다: 이름도 같고
  //   (`addSection`) SQL 종류도 둘 다 `INSERT ... ON CONFLICT`라 ⑫의 soft/hard 분류로는 안
  //   걸린다. 차이는 conflict 절뿐이었다(`DO NOTHING` — 구 EventDAO — vs `DO UPDATE SET
  //   deleted_at = NULL` — TaskDAO). 그 conflict 절 자체를 분류해 직접 비교한다.
  //   ⚠️ 대칭 장치의 한계: ⑫(soft/hard)와 ⑬(부활 가능 여부)은 각각 그 축 하나만 잡는
  //   전용 비교이지, "임의의 두 메서드가 같은 일을 하는가"를 범용으로 검증하는 장치가
  //   아니다. 세 번째 축(예: CASCADE 옵션 차이, 컬럼 목록 차이)이 갈라지면 이 두 테스트로는
  //   안 잡힌다 — 그런 축이 또 발견되면 그때 같은 패턴으로 전용 비교를 하나 더 추가한다.
  {
    function conflictKind(sql) {
      const s = sql.replace(/\s+/g, ' ').trim().toUpperCase();
      if (s.includes('DO NOTHING')) return 'no-revival';
      if (s.includes('DO UPDATE') && s.includes('DELETED_AT = NULL')) return 'revival';
      return 'other';
    }

    const store = makeStore();
    // 이미 해제된 연결 위에 addSection을 걸어야 conflict 절이 실제로 exercise된다.
    store.eventSections.set('ev-13#sec-1', { event_id: 'ev-13', section_id: 'sec-1', deleted_at: new Date() });
    store.taskSections.set('tk-13#sec-1', { task_id: 'tk-13', section_id: 'sec-1', deleted_at: new Date() });
    const conn = makeConn(store);

    await EventDAO.addSection(conn, 'ev-13', 'sec-1');
    await TaskDAO.addSection(conn, 'tk-13', 'sec-1');

    const eventAddSql = conn.queryLog.find((q) => q.sql.startsWith('INSERT INTO event_sections'))?.sql;
    const taskAddSql = conn.queryLog.find((q) => q.sql.startsWith('INSERT INTO task_sections'))?.sql;
    assert(eventAddSql && taskAddSql, '⑬addSection 호출이 기록돼야 한다');

    assert.strictEqual(
      conflictKind(eventAddSql),
      conflictKind(taskAddSql),
      `⑬EventDAO.addSection과 TaskDAO.addSection의 conflict 처리(부활 가능 여부)가 같아야 한다.\nEvent: ${eventAddSql}\nTask: ${taskAddSql}`
    );
    assert.strictEqual(
      conflictKind(eventAddSql), 'revival',
      '⑬addSection은 soft-delete된 연결을 되살려야 한다(DO NOTHING이면 해제 후 재연결이 영원히 막힌다)'
    );

    // 구조 단언(⑬)에 더해 실제 부활이 store에 반영됐는지도 확인 — mock이 conflict 절을
    // 실제로 해석해 반영하므로(맹목적 부활이 아님), 이 단언은 SQL 문구가 아니라 관찰된
    // 행동을 검증한다.
    assert.strictEqual(store.eventSections.get('ev-13#sec-1').deleted_at, null, '⑬EventDAO.addSection 호출 후 실제로 부활해야 한다');
    assert.strictEqual(store.taskSections.get('tk-13#sec-1').deleted_at, null, '⑬TaskDAO.addSection 호출 후 실제로 부활해야 한다');
  }

  console.log('eventTaskDeleteCascadeRegression: 13/13 assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
