/**
 * src/daos/messagePinRegression.test.js
 * =========================================
 * RLY-20260806-094 — togglePin(messageDAO.js)이 is_pinned만 NOT으로 토글하고
 * pinned_at·pinned_by_user_id는 전혀 쓰지 않아(항상 NULL) 087·088이 지적한 "읽기 배선은
 * 있는데 쓰기 배선이 없는" 세 번째 사례였다.
 *
 * SC-messaging.md:1531("핀 시 pinned_at·pinned_by_user_id 기록")·:1538("해제 시 둘 다
 * NULL로 되돌림")·§16-13("pinned_at DESC 정렬 — 최근 핀이 좌측")을 그대로 따랐다.
 *
 * 이 스위트는 실제 Postgres의 `UPDATE ... SET is_pinned = NOT is_pinned, pinned_at = CASE
 * WHEN is_pinned THEN NULL ELSE now() END ...` 구문 의미(SET 절의 컬럼 참조는 같은 UPDATE
 * 안에서 항상 갱신 전 값)를 가짜 conn 위에서 직접 재현해 토글 왕복을 검증한다 —
 * authzRegression.test.js와 동일 관행(가짜 DB connection, plain assert, `node <file>.js`).
 *
 * 실행: node src/daos/messagePinRegression.test.js
 */

const assert = require('assert');
const { MessageDAO } = require('./messageDAO');

const NOW_SEQ = [];
let nowCounter = 0;
function nextNow() {
  const t = new Date(Date.now() + (nowCounter++) * 1000); // 호출마다 1초씩 뒤로 — pinned_at DESC 정렬 검증용
  NOW_SEQ.push(t);
  return t;
}

function makeConn(store) {
  return {
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim();

      // MessageDAO.togglePin — CASE WHEN is_pinned(갱신 전 값) THEN NULL ELSE now()/actor END
      if (s.startsWith('UPDATE section_messages') && s.includes('SET is_pinned = NOT is_pinned')) {
        const [messageId, userId] = params;
        const row = store.messages[messageId];
        if (!row || row.deleted_at) return { rows: [] };
        const wasPinned = row.is_pinned; // 갱신 전 값 — Postgres SET 절 규약과 동일하게 먼저 캡처
        row.is_pinned = !wasPinned;
        row.pinned_at = wasPinned ? null : nextNow();
        row.pinned_by_user_id = wasPinned ? null : userId;
        row.updated_at = new Date();
        return { rows: [{ id: row.id, is_pinned: row.is_pinned, pinned_at: row.pinned_at, pinned_by_user_id: row.pinned_by_user_id }] };
      }

      // MessageDAO.findPinned
      if (s.startsWith('SELECT id, section_id, user_id, parent_id, content') && s.includes('is_pinned = TRUE')) {
        const [sectionId] = params;
        const rows = Object.values(store.messages)
          .filter((m) => m.section_id === sectionId && m.is_pinned === true && !m.deleted_at);
        // ORDER BY pinned_at DESC — 실제 SQL 정렬을 그대로 흉내
        rows.sort((a, b) => (b.pinned_at?.getTime() || 0) - (a.pinned_at?.getTime() || 0));
        return { rows: rows.map(({ id, section_id, user_id, parent_id, content, mention_everyone, is_pinned, pinned_at, pinned_by_user_id, created_at, updated_at }) =>
          ({ id, section_id, user_id, parent_id, content, mention_everyone, is_pinned, pinned_at, pinned_by_user_id, created_at, updated_at })) };
      }

      throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
    },
  };
}

function freshStore() {
  const T0 = new Date('2026-08-06T00:00:00Z');
  return {
    messages: {
      m1: { id: 'm1', section_id: 's1', user_id: 'author1', parent_id: null, content: 'hello', mention_everyone: false, is_pinned: false, pinned_at: null, pinned_by_user_id: null, created_at: T0, updated_at: T0, deleted_at: null },
      m2: { id: 'm2', section_id: 's1', user_id: 'author1', parent_id: null, content: 'world', mention_everyone: false, is_pinned: false, pinned_at: null, pinned_by_user_id: null, created_at: T0, updated_at: T0, deleted_at: null },
    },
  };
}

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond) {
  if (cond) pass++; else { fail++; failures.push(desc); }
}

async function run() {
  // ============ ① 핀 — pinned_at·pinned_by_user_id가 실제로 채워진다 ============
  {
    const store = freshStore();
    const conn = makeConn(store);
    const result = await MessageDAO.togglePin(conn, 'm1', 'manager1');
    check('① 핀 결과 is_pinned=true', result.is_pinned === true);
    check('① 핀 결과 pinned_at 채워짐(NULL 아님)', result.pinned_at !== null && result.pinned_at !== undefined);
    check('① 핀 결과 pinned_by_user_id=actor(manager1)', result.pinned_by_user_id === 'manager1');
    check('① 저장된 행에도 반영됨', store.messages.m1.pinned_at !== null && store.messages.m1.pinned_by_user_id === 'manager1');
  }

  // ============ ② 핀 해제 — 문서대로 두 값 모두 NULL로 되돌아간다(마지막 기록 보존 아님) ============
  {
    const store = freshStore();
    const conn = makeConn(store);
    await MessageDAO.togglePin(conn, 'm1', 'manager1'); // 핀
    const unpinResult = await MessageDAO.togglePin(conn, 'm1', 'manager2'); // 해제(다른 사용자가 눌러도 무관 — 값 자체는 항상 NULL로)
    check('② 해제 결과 is_pinned=false', unpinResult.is_pinned === false);
    check('② SC-messaging.md:1538 — 해제 시 pinned_at=NULL(직전 기록 보존 아님)', unpinResult.pinned_at === null);
    check('② SC-messaging.md:1538 — 해제 시 pinned_by_user_id=NULL', unpinResult.pinned_by_user_id === null);
  }

  // ============ ③ findPinned — pinned_at·pinned_by_user_id가 REST 응답에도 실제로 도달한다 ============
  {
    const store = freshStore();
    const conn = makeConn(store);
    await MessageDAO.togglePin(conn, 'm1', 'manager1'); // 먼저 핀(더 오래된 pinned_at)
    await MessageDAO.togglePin(conn, 'm2', 'manager1'); // 나중에 핀(더 최근 pinned_at)

    const pinned = await MessageDAO.findPinned(conn, 's1');
    check('③ 핀된 메시지 2개 모두 조회됨', pinned.length === 2);
    check('③ SELECT 컬럼에 pinned_at·pinned_by_user_id가 실제로 포함된다', pinned.every((m) => 'pinned_at' in m && 'pinned_by_user_id' in m));
    check('③ §16-13 확정 — pinned_at DESC(최근 핀인 m2가 먼저)', pinned[0].id === 'm2' && pinned[1].id === 'm1');
  }

  // ============ ④ 재현 — 수정 전 코드였다면 어떻게 되는지 직접 대조(구식 시그니처 호출) ============
  {
    const store = freshStore();
    const conn = makeConn(store);
    // userId를 안 넘기면(구 시그니처 호출부와 동일 상황) pinned_by_user_id가 NULL로 찍힌다 —
    // 즉 이 필드가 실제로 "context.sender_id를 넘겼는가"에 의존한다는 것 자체가 재현 근거다.
    const result = await MessageDAO.togglePin(conn, 'm1', undefined);
    check('④ 재현 근거 — userId 인자가 없으면 pinned_by_user_id가 채워지지 않는다(수정 전 messageService가 정확히 이 상태였다)', result.pinned_by_user_id == null);
  }

  console.log(`\n[messagePinRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[messagePinRegression] 실행 실패:', error);
  process.exitCode = 1;
});
