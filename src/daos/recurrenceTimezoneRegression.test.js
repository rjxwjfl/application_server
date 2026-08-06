/**
 * src/daos/recurrenceTimezoneRegression.test.js
 * =============================================
 * RLY-20260806-019 recurrence_timezone 서버 저장·왕복 회귀 스위트.
 *
 * 배경(.outbox/diagnosis-drift-and-sync-20260806.md §B): `events`/`tasks`에
 * `recurrence_timezone` 컬럼 자체가 없어 sync pull마다 값이 리셋되던 결함. 컬럼을
 * 이식하면서 null 처리는 COALESCE가 아니라 이 저장소의 기존 관례
 * (postDAO.js update()·groupDAO.js updateGroup()의 hasOwnProperty 기반 CASE WHEN)를
 * 그대로 따랐다 — "필드 부재(변경 없음)"와 "필드가 명시적으로 null(지우기)"을 구분해야
 * 지우기가 영원히 봉인되지 않는다.
 *
 * 이 스위트는 실제 DB 없이 EventDAO/TaskDAO를 가짜 conn.query로 직접 호출해 SQL의
 * CASE WHEN·COALESCE 의미를 in-memory 저장소로 흉내내고, findById로 다시 읽어
 * "저장이 실제로 유지/삭제/보존되는가"를 단언한다. authzRegression.test.js·
 * sectionCascadeRegression.test.js와 동일 관행(가짜 connection, plain assert,
 * `node <file>.js` 직접 실행)을 따른다.
 *
 * 실행: node src/daos/recurrenceTimezoneRegression.test.js
 */

const assert = require('assert');
const { EventDAO } = require('./eventDAO');
const { TaskDAO } = require('./taskDAO');

const NOW = new Date().toISOString();

function makeStore(seedRow) {
  return { row: { ...seedRow } };
}

// events/tasks findById·updateEvent/updateTask 두 쿼리만 이해하면 되는 최소 mock.
// UPDATE의 CASE WHEN/COALESCE 의미를 DAO의 실제 파라미터 순서 그대로 재현한다.
function makeEventConn(store) {
  return {
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();

      if (s.startsWith('SELECT id, calendar_id, author_id, event_type')) {
        return { rows: store.row.deleted_at ? [] : [{ ...store.row }] };
      }
      if (s.startsWith('UPDATE events SET summary')) {
        // RLY-20260806-026 — reminder_offsets 컬럼 이식으로 eventId가 $8→$9로 밀렸다.
        const [summary, description, color, r_rule, locations, hasTz, tzValue, reminderOffsets, eventId] = params;
        assert.strictEqual(eventId, store.row.id, '이벤트 id가 WHERE 절 마지막 파라미터와 일치해야 한다');
        store.row.summary = summary ?? store.row.summary;
        store.row.description = description ?? store.row.description;
        store.row.color = color ?? store.row.color;
        store.row.r_rule = r_rule ?? store.row.r_rule;
        store.row.locations = locations ?? store.row.locations;
        // CASE WHEN $6 THEN $7 ELSE recurrence_timezone END
        store.row.recurrence_timezone = hasTz ? (tzValue ?? null) : store.row.recurrence_timezone;
        store.row.reminder_offsets = reminderOffsets ?? store.row.reminder_offsets;
        store.row.updated_at = new Date().toISOString();
        return { rows: [{ ...store.row }] };
      }
      throw new Error(`[mock] Unhandled event query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
    },
  };
}

function makeTaskConn(store) {
  return {
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();

      if (s.startsWith('SELECT id, calendar_id, author_id, task_type')) {
        return { rows: store.row.deleted_at ? [] : [{ ...store.row }] };
      }
      if (s.startsWith('UPDATE tasks SET summary')) {
        // RLY-20260806-026 — reminder_offsets 컬럼 이식으로 taskId가 $8→$9로 밀렸다.
        const [summary, description, priority, locations, r_rule, hasTz, tzValue, reminderOffsets, taskId] = params;
        assert.strictEqual(taskId, store.row.id, '태스크 id가 WHERE 절 마지막 파라미터와 일치해야 한다');
        store.row.summary = summary ?? store.row.summary;
        store.row.description = description ?? store.row.description;
        store.row.priority = priority ?? store.row.priority;
        store.row.locations = locations ?? store.row.locations;
        store.row.r_rule = r_rule ?? store.row.r_rule;
        store.row.recurrence_timezone = hasTz ? (tzValue ?? null) : store.row.recurrence_timezone;
        store.row.reminder_offsets = reminderOffsets ?? store.row.reminder_offsets;
        store.row.updated_at = new Date().toISOString();
        return { rows: [{ ...store.row }] };
      }
      throw new Error(`[mock] Unhandled task query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
    },
  };
}

async function run() {
  // ① set 후 조회에서 유지된다(events) — PATCH로 timezone을 실으면 findById가 그 값을 돌려줘야 한다.
  {
    const store = makeStore({
      id: 'ev-1', calendar_id: 'cal-1', author_id: 'u-1', event_type: 0,
      summary: '회의', description: null, color: 0, r_rule: 'FREQ=WEEKLY',
      recurrence_timezone: null, locations: null, forked_from: null,
      created_at: NOW, updated_at: NOW, deleted_at: null,
    });
    const conn = makeEventConn(store);
    const updated = await EventDAO.updateEvent(conn, 'ev-1', { recurrence_timezone: 'Asia/Seoul' });
    assert.strictEqual(updated.recurrence_timezone, 'Asia/Seoul', '①set 직후 응답에 반영돼야 한다');
    const refetched = await EventDAO.findById(conn, 'ev-1');
    assert.strictEqual(refetched.recurrence_timezone, 'Asia/Seoul', '①set 후 findById(=sync pull 경로)로 재조회해도 유지돼야 한다');
  }

  // ② 명시적 clear(null)가 실제로 반영된다(events) — 값이 있던 행에 explicit null을 보내면 지워진다.
  {
    const store = makeStore({
      id: 'ev-2', calendar_id: 'cal-1', author_id: 'u-1', event_type: 0,
      summary: '회의', description: null, color: 0, r_rule: 'FREQ=WEEKLY',
      recurrence_timezone: 'America/New_York', locations: null, forked_from: null,
      created_at: NOW, updated_at: NOW, deleted_at: null,
    });
    const conn = makeEventConn(store);
    const updated = await EventDAO.updateEvent(conn, 'ev-2', { recurrence_timezone: null });
    assert.strictEqual(updated.recurrence_timezone, null, '②명시적 null PATCH는 즉시 지워야 한다');
    const refetched = await EventDAO.findById(conn, 'ev-2');
    assert.strictEqual(refetched.recurrence_timezone, null, '②지운 뒤 재조회해도 되살아나면 안 된다');
  }

  // ③ 필드 미포함 PATCH는 기존 값을 보존한다(events) — 구버전 클라가 이 키를 아예 안 보내는 경우.
  //    이 계약의 핵심 단언: COALESCE였다면 통과했겠지만, hasOwnProperty가 false일 때도
  //    ELSE 분기로 기존 값을 지키는지가 진짜 검증 대상이다.
  {
    const store = makeStore({
      id: 'ev-3', calendar_id: 'cal-1', author_id: 'u-1', event_type: 0,
      summary: '회의', description: null, color: 0, r_rule: 'FREQ=WEEKLY',
      recurrence_timezone: 'Asia/Seoul', locations: null, forked_from: null,
      created_at: NOW, updated_at: NOW, deleted_at: null,
    });
    const conn = makeEventConn(store);
    const updateData = { summary: '팀 회의' }; // recurrence_timezone 키 자체가 없음
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(updateData, 'recurrence_timezone'), false,
      '③테스트 전제: updateData에 recurrence_timezone 키가 없어야 한다'
    );
    const updated = await EventDAO.updateEvent(conn, 'ev-3', updateData);
    assert.strictEqual(updated.recurrence_timezone, 'Asia/Seoul', '③필드 미포함 PATCH는 기존 값을 보존해야 한다(구버전 클라 방어)');
    assert.strictEqual(updated.summary, '팀 회의', '③다른 필드는 정상 반영돼야 한다');
  }

  // ④ tasks도 events와 동형으로 set/clear/보존이 성립한다.
  {
    const store = makeStore({
      id: 'tk-1', calendar_id: 'cal-1', author_id: 'u-1', task_type: 0,
      summary: '보고서 작성', description: null, priority: 0, r_rule: 'FREQ=DAILY',
      recurrence_timezone: null, locations: null, forked_from: null,
      created_at: NOW, updated_at: NOW, deleted_at: null,
    });
    const conn = makeTaskConn(store);

    const setResult = await TaskDAO.updateTask(conn, 'tk-1', { recurrence_timezone: 'Europe/London' });
    assert.strictEqual(setResult.recurrence_timezone, 'Europe/London', '④(tasks)set이 반영돼야 한다');
    assert.strictEqual(
      (await TaskDAO.findById(conn, 'tk-1')).recurrence_timezone, 'Europe/London',
      '④(tasks)set 후 재조회에도 유지돼야 한다'
    );

    const clearResult = await TaskDAO.updateTask(conn, 'tk-1', { recurrence_timezone: null });
    assert.strictEqual(clearResult.recurrence_timezone, null, '④(tasks)명시적 clear가 반영돼야 한다');
    assert.strictEqual(
      (await TaskDAO.findById(conn, 'tk-1')).recurrence_timezone, null,
      '④(tasks)clear 후 재조회에도 되살아나면 안 된다'
    );

    const preserveResult = await TaskDAO.updateTask(conn, 'tk-1', { priority: 2 });
    assert.strictEqual(preserveResult.recurrence_timezone, null, '④(tasks)필드 미포함 PATCH는 기존 값(이미 null)을 보존해야 한다');
  }

  // ⑤ 다른 필드만 바꾸는 PATCH가 이미 설정된 timezone을 건드리지 않는다(events) — ③의 반대 극단:
  //    "값이 있는 상태에서 무관한 필드만 바꿔도 안 지워지는가"를 별도로 확인한다.
  {
    const store = makeStore({
      id: 'ev-5', calendar_id: 'cal-1', author_id: 'u-1', event_type: 0,
      summary: '회의', description: null, color: 0, r_rule: 'FREQ=WEEKLY',
      recurrence_timezone: 'Asia/Tokyo', locations: null, forked_from: null,
      created_at: NOW, updated_at: NOW, deleted_at: null,
    });
    const conn = makeEventConn(store);
    const updated = await EventDAO.updateEvent(conn, 'ev-5', { color: 3 });
    assert.strictEqual(updated.color, 3, '⑤color는 반영돼야 한다');
    assert.strictEqual(updated.recurrence_timezone, 'Asia/Tokyo', '⑤무관한 필드만 바꾸는 PATCH는 timezone을 건드리면 안 된다');
  }

  console.log('recurrenceTimezoneRegression: 5/5 assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
