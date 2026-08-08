/**
 * src/daos/messageReactionSyncRegression.test.js
 * =========================================
 * RLY-20260806-079 — 078(첨부)과 같은 부류인지 조사한 결과, message_reactions는 정확히
 * 같은 성질이었다: react/unreact(messageDAO.addReaction·removeReaction)가 메시지 생성과
 * 완전히 독립된 시점에 일어나고, syncDAO.getMessageReactions(수리 전)는 오직 messageIds
 * (이번 델타에 포함된 메시지)로만 스코프됐다 — 부모 메시지가 안 바뀌면 그 메시지의 반응
 * 추가·취소가 영원히 델타에서 빠졌다. 078과 동일한 OR 조건(messageIds 스코프 + 독자
 * updated_at·인가 재사용)으로 닫았다.
 *
 * ⚠️ 반응 취소(removeReaction)는 하드 delete가 아니라 소프트 delete(deleted_at + updated_at
 * 갱신)다. 이 함수는 원래도 deleted_at IS NULL을 필터하지 않는다(SELECT *) — 취소된 행도
 * updated_at 조건에 걸리면 그대로 응답에 실려 클라가 tombstone으로 받는다. 이 스위트의 ⑤가
 * 이걸 직접 확인한다.
 *
 * message_embeds·message_mentions는 조사 결과 다른 성질이라(createMessage 트랜잭션
 * 안에서만 생성되고 그 뒤 독립적으로 바뀌는 경로가 없음) 이 Task에서 손대지 않았다 —
 * 이 스위트는 message_reactions만 다룬다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js` 직접 실행, 가짜 pool로 실제
 * DAO 코드(SyncDAO.getMessageReactions)를 그대로 구동한다(messageAttachmentSyncRegression.
 * test.js와 동일 — SQL 텍스트 매칭 mock).
 *
 * 실행: node src/daos/messageReactionSyncRegression.test.js
 */


process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test';
process.env.PGDATABASE = process.env.PGDATABASE || 'test';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test';

const { SyncDAO } = require('../daos/syncDAO');

const OLD_TS = new Date('2026-08-01T00:00:00Z'); // 이전 동기화 시각
const HOUR = 60 * 60 * 1000;

// ── 픽스처 (messageAttachmentSyncRegression.test.js와 동일한 구조) ──────────────
const sections = {
  s1: { id: 's1', binder_id: 'b1', access_scope: 0 }, // 공개 — 바인더 멤버 전원 접근
  s2: { id: 's2', binder_id: 'b1', access_scope: 1 }, // 비공개 — section_members만
  s3: { id: 's3', binder_id: 'b2', access_scope: 0 }, // 공개지만 유저가 b2 멤버가 아님
};
const sectionMembers = {
  's2:other-user': { section_id: 's2', user_id: 'other-user', deleted_at: null },
};
const messages = {
  m1: { id: 'm1', section_id: 's1' }, // 이미 동기화된 메시지(이번 델타의 messageIds에 없음)
  m2: { id: 'm2', section_id: 's2' }, // 비공개 섹션(비접근)의 메시지
  m3: { id: 'm3', section_id: 's1' }, // 이번 델타에 새로 포함된 메시지(messageIds에 있음)
  m4: { id: 'm4', section_id: 's3' }, // 비접근 바인더(b2)의 메시지
};
const reactions = {
  // r1 — m1(이미 동기화된 메시지)에 나중에 추가된 반응. 이 Task의 핵심 재현 대상.
  r1: { id: 'r1', message_id: 'm1', user_id: 'u1', emoji: '👍', updated_at: new Date(OLD_TS.getTime() + HOUR), deleted_at: null },
  // r2 — m2(비공개 섹션, 유저 비접근)의 반응. updated_at은 새것이지만 인가로 막혀야 한다.
  r2: { id: 'r2', message_id: 'm2', user_id: 'other-user', emoji: '❤️', updated_at: new Date(OLD_TS.getTime() + HOUR), deleted_at: null },
  // r3 — m3(이번 델타에 포함된 메시지)의 반응. 기존 messageIds 경로로 실려야 한다(회귀 불변).
  r3: { id: 'r3', message_id: 'm3', user_id: 'u1', emoji: '😀', updated_at: new Date(OLD_TS.getTime() + HOUR), deleted_at: null },
  // r4 — m1에 달렸다가 취소된 반응(소프트 delete). ⚠️ "반응 취소가 클라에 도달하는가"의 직접 대상.
  r4: { id: 'r4', message_id: 'm1', user_id: 'u2', emoji: '🎉', updated_at: new Date(OLD_TS.getTime() + HOUR), deleted_at: new Date(OLD_TS.getTime() + HOUR).toISOString() },
  // r5 — m4(비접근 바인더 b2)의 반응. access_scope=0(공개)이라도 currDIds에 b2가 없어 제외돼야 한다.
  r5: { id: 'r5', message_id: 'm4', user_id: 'other-user', emoji: '👍', updated_at: new Date(OLD_TS.getTime() + HOUR), deleted_at: null },
};

function makePool() {
  return {
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim();

      // 신규(인가 경계 포함) 쿼리
      if (s.includes('JOIN section_messages m') && s.includes('JOIN sections s')) {
        const [messageIds, oldTs, currDIds, userId] = params;
        const rows = Object.values(reactions).filter((r) => {
          const m = messages[r.message_id];
          if (!m) return false;
          const sec = sections[m.section_id];
          if (!sec) return false;

          const inMessageIds = messageIds.includes(r.message_id) && r.updated_at > oldTs;
          const hasAccess = sec.access_scope === 0
            ? currDIds.includes(sec.binder_id)
            : !!sectionMembers[`${sec.id}:${userId}`];
          const independentBranch = r.updated_at > oldTs && currDIds.includes(sec.binder_id) && hasAccess;

          return inMessageIds || independentBranch;
        });
        return { rows };
      }

      // 레거시(messageIds 전용) 쿼리
      if (s.startsWith('SELECT * FROM message_reactions')) {
        const [messageIds, oldTs] = params;
        const rows = Object.values(reactions).filter((r) => {
          if (!messageIds.includes(r.message_id)) return false;
          if (oldTs && !(r.updated_at > oldTs)) return false;
          return true;
        });
        return { rows };
      }

      throw new Error(`[mock] Unhandled query: ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
    },
  };
}

let pass = 0;
let fail = 0;
const failures = [];

function check(desc, cond) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(desc);
  }
}

async function run() {
  const pool = makePool();

  // ============ ① 재현(수리 전 동작 그대로) — 레거시 경로는 부모 불변 메시지의 반응 변화를 놓친다 ============
  {
    const rows = await SyncDAO.getMessageReactions(pool, ['m3'], OLD_TS); // userId·currDIds 없이 호출(레거시 시그니처)
    const ids = rows.map((r) => r.id);
    check('① 재현 — messageIds=[m3](m1은 없음)만으로는 r1(m1에 나중에 달린 반응)이 실리지 않는다', !ids.includes('r1'));
    check('① 재현 — r3(m3의 반응, messageIds에 있음)는 정상적으로 실린다', ids.includes('r3'));
  }

  // ============ ②③④ 수리 — userId·currDIds를 주면 부모 불변+반응만 변경도 실리고, 인가 경계는 유지된다 ============
  {
    const rows = await SyncDAO.getMessageReactions(pool, ['m3'], OLD_TS, 'u1', ['b1']);
    const ids = rows.map((r) => r.id);

    check('② AC — 메시지(m1) 불변 + 반응(r1) 추가 → 다음 델타에 실린다', ids.includes('r1'));
    check('③ AC — 권한 없는 유저(u1은 s2 멤버 아님)에게는 r2(비공개 섹션)가 실리지 않는다', !ids.includes('r2'));
    check('AC — 비접근 바인더(b2, currDIds에 없음)의 r5는 access_scope=0이어도 실리지 않는다', !ids.includes('r5'));
    check('⑥ AC — 기존 메시지 스코프 경로 불변 — r3(m3, messageIds에 포함)은 여전히 실린다', ids.includes('r3'));
    check('⑤ ⚠️ 반응 취소가 클라에 도달한다 — r4(m1에 달렸다가 취소된 반응, deleted_at 있음)가 tombstone으로 실린다', ids.includes('r4'));
    const r4Row = rows.find((r) => r.id === 'r4');
    check('⑤ tombstone 내용 확인 — deleted_at이 그대로 실려 클라가 취소임을 판단할 수 있다', !!(r4Row && r4Row.deleted_at));
  }

  // ============ ④ 대조군 — s2 실제 멤버(other-user)라면 r2가 실려야 한다 ============
  {
    const rows = await SyncDAO.getMessageReactions(pool, [], OLD_TS, 'other-user', ['b1']);
    const ids = rows.map((r) => r.id);
    check('④ 대조군 — s2 실제 멤버(other-user)에게는 r2가 실린다(인가 로직 자체가 틀리지 않았음을 확인)', ids.includes('r2'));
  }

  console.log(`\n[messageReactionSyncRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[messageReactionSyncRegression] 실행 실패:', error);
  process.exitCode = 1;
});
