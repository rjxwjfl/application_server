/**
 * src/daos/messageAttachmentSyncRegression.test.js
 * =========================================
 * RLY-20260806-078 — 첨부 상태 변화가 클라에 영원히 도달하지 않던 결함(Blocker)의 재현·회귀.
 *
 * 재현(수리 전 사실 — syncDAO.js:413-424, 073의 클라 쪽 조사 확인):
 *   syncDAO.getMessageAttachments(pool, messageIds, oldTs)는 attachments를 오직
 *   `context_id = ANY(messageIds)`로만 스코프했다. messageIds는 "이번 델타에 포함된 메시지"
 *   (syncService._fetchTrackCMessaging: `messages.map(m => m.id)`)뿐이다.
 *
 *   그런데 메시지는 생성 직후 거의 즉시 동기화되고, Worker의 비동기 confirm→ready/rejected
 *   전환은 1분 폴링이라 메시지 동기화보다 항상 늦게 끝난다 — "메시지가 이미 동기화된 뒤 첨부
 *   상태가 바뀌는" 것이 예외가 아니라 일반적인 순서다. 이 경우 메시지 자신은 그 뒤로 안 바뀌므로
 *   messageIds에 다시는 들지 않고, 첨부의 상태 변화(예: rejected 전환)는 그 메시지가 다시
 *   바뀌지 않는 한 영원히 델타에서 빠진다. media.md:848("delta sync가 updated_at 수렴으로
 *   상태를 획득한다")이 규정하는 동작과 코드가 어긋나는 지점이었다.
 *
 * 이 스위트는 두 가지를 증명한다:
 *   A. 위 재현 — messageIds 스코프만으로는(레거시 폴백 경로) 부모가 안 바뀐 메시지의 첨부
 *      변화가 실리지 않는다(①).
 *   B. 수리 — userId·currDIds가 주어지면(정상 sync 경로) 그 변화가 실리되(②), 인가 경계
 *      (비접근 섹션·비접근 바인더는 제외 — ③④)가 유지되고, 기존 messageIds 경로(⑤)·삭제된
 *      첨부 배제(⑥)는 그대로 불변이다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js` 직접 실행, 가짜 pool로 실제
 * DAO 코드(SyncDAO.getMessageAttachments)를 그대로 구동한다(pendingApplicantFilterCoverageRegression.
 * test.js와 동일 — SQL 텍스트 매칭 mock, 실제 Postgres 문법 자체는 검증하지 않는다).
 *
 * 실행: node src/daos/messageAttachmentSyncRegression.test.js
 */


process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test';
process.env.PGDATABASE = process.env.PGDATABASE || 'test';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test';

const { SyncDAO } = require('../daos/syncDAO');

const NOW = new Date('2026-08-07T00:00:00Z');
const OLD_TS = new Date('2026-08-01T00:00:00Z'); // 이전 동기화 시각
const HOUR = 60 * 60 * 1000;

// ── 픽스처 ──────────────────────────────────────────────────────────────
// b1: 유저가 지금 속한 바인더. s1(공개 섹션)·s2(비공개 섹션, 유저는 section_members 아님).
// b2: 유저가 지금 속하지 않은 바인더(currDIds에 없음) — 공개 섹션이라도 제외돼야 한다.
const sections = {
  s1: { id: 's1', binder_id: 'b1', access_scope: 0 }, // 공개 — 바인더 멤버 전원 접근
  s2: { id: 's2', binder_id: 'b1', access_scope: 1 }, // 비공개 — section_members만
  s3: { id: 's3', binder_id: 'b2', access_scope: 0 }, // 공개지만 유저가 b2 멤버가 아님
};
const sectionMembers = {
  // s2엔 'other-user'만 있다 — 이 테스트의 userId('u1')는 s2 멤버가 아니다.
  's2:other-user': { section_id: 's2', user_id: 'other-user', deleted_at: null },
};
const messages = {
  m1: { id: 'm1', section_id: 's1' }, // 이미 동기화된 메시지(이번 델타의 messageIds에 없음)
  m2: { id: 'm2', section_id: 's2' }, // 비공개 섹션의(비접근) 메시지
  m3: { id: 'm3', section_id: 's1' }, // 이번 델타에 새로 포함된 메시지(messageIds에 있음)
  m4: { id: 'm4', section_id: 's3' }, // 비접근 바인더(b2)의 메시지
};
const attachments = {
  // att1 — m1(이미 동기화된 메시지)의 첨부. 상태가 나중에 바뀜(updated_at > OLD_TS).
  //        이게 이 Task의 핵심 재현 대상이다.
  att1: { id: 'att1', context_type: 'SECTION_MESSAGE', context_id: 'm1', status: 'rejected', updated_at: new Date(OLD_TS.getTime() + HOUR), deleted_at: null },
  // att2 — m2(비공개 섹션, 유저 비접근)의 첨부. updated_at은 새것이지만 인가로 막혀야 한다.
  att2: { id: 'att2', context_type: 'SECTION_MESSAGE', context_id: 'm2', status: 'rejected', updated_at: new Date(OLD_TS.getTime() + HOUR), deleted_at: null },
  // att3 — m3(이번 델타에 포함된 메시지)의 첨부. 기존 messageIds 경로로 실려야 한다(회귀 불변).
  att3: { id: 'att3', context_type: 'SECTION_MESSAGE', context_id: 'm3', status: 'ready', updated_at: new Date(OLD_TS.getTime() + HOUR), deleted_at: null },
  // att4 — att1과 동일 조건이지만 소프트 삭제됨 — 어떤 경로로도 실리면 안 된다.
  att4: { id: 'att4', context_type: 'SECTION_MESSAGE', context_id: 'm1', status: 'rejected', updated_at: new Date(OLD_TS.getTime() + HOUR), deleted_at: NOW.toISOString() },
  // att5 — m4(비접근 바인더 b2)의 첨부. access_scope=0(공개)이라도 currDIds에 b2가 없어 제외돼야 한다.
  att5: { id: 'att5', context_type: 'SECTION_MESSAGE', context_id: 'm4', status: 'rejected', updated_at: new Date(OLD_TS.getTime() + HOUR), deleted_at: null },
};

function makePool() {
  return {
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim();

      // 신규(인가 경계 포함) 쿼리 — JOIN section_messages/sections가 있는 버전
      if (s.includes('JOIN section_messages m') && s.includes('JOIN sections s')) {
        const [messageIds, oldTs, currDIds, userId] = params;
        const rows = Object.values(attachments).filter((a) => {
          if (a.context_type !== 'SECTION_MESSAGE' || a.deleted_at) return false;
          const m = messages[a.context_id];
          if (!m) return false;
          const sec = sections[m.section_id];
          if (!sec) return false;

          const inMessageIds = messageIds.includes(a.context_id) && a.updated_at > oldTs;
          const hasAccess = sec.access_scope === 0
            ? currDIds.includes(sec.binder_id)
            : !!sectionMembers[`${sec.id}:${userId}`];
          const independentBranch = a.updated_at > oldTs && currDIds.includes(sec.binder_id) && hasAccess;

          return inMessageIds || independentBranch;
        });
        return { rows };
      }

      // 레거시(messageIds 전용) 쿼리 — userId·currDIds 없이 호출될 때
      if (s.startsWith('SELECT id, context_id AS message_id') && s.includes('FROM attachments')) {
        const [messageIds, oldTs] = params;
        const rows = Object.values(attachments).filter((a) => {
          if (a.context_type !== 'SECTION_MESSAGE' || a.deleted_at) return false;
          if (!messageIds.includes(a.context_id)) return false;
          if (oldTs && !(a.updated_at > oldTs)) return false;
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

  // ============ ① 재현(수리 전 동작 그대로) — 레거시 경로는 부모가 안 바뀐 메시지의 첨부 변화를 놓친다 ============
  {
    const rows = await SyncDAO.getMessageAttachments(pool, ['m3'], OLD_TS); // userId·currDIds 없이 호출(레거시 시그니처)
    const ids = rows.map((r) => r.id);
    check('① 재현 — messageIds=[m3](m1은 없음)만으로는 att1(m1의 첨부, 나중에 상태 변경)이 실리지 않는다', !ids.includes('att1'));
    check('① 재현 — att3(m3의 첨부, messageIds에 있음)는 정상적으로 실린다', ids.includes('att3'));
  }

  // ============ ②③④ 수리 — userId·currDIds를 주면 부모 불변+첨부만 변경도 실리고, 인가 경계는 유지된다 ============
  {
    const rows = await SyncDAO.getMessageAttachments(pool, ['m3'], OLD_TS, 'u1', ['b1']);
    const ids = rows.map((r) => r.id);

    check('② AC — 메시지(m1) 불변 + 첨부(att1) 상태만 변경 → 다음 델타에 실린다', ids.includes('att1'));
    check('③ AC — 권한 없는 유저(u1은 s2 멤버 아님)에게는 att2(비공개 섹션)가 실리지 않는다', !ids.includes('att2'));
    check('④ AC — 비접근 바인더(b2, currDIds에 없음)의 att5는 access_scope=0이어도 실리지 않는다', !ids.includes('att5'));
    check('⑤ AC — 기존 메시지 스코프 경로 불변 — att3(m3, messageIds에 포함)은 여전히 실린다', ids.includes('att3'));
    check('⑥ AC — 삭제된 첨부(att4, att1과 동일 조건+deleted_at) 처리 — 어떤 경로로도 실리지 않는다', !ids.includes('att4'));
  }

  // ============ 인가 경계 재확인 — s2 멤버(other-user)라면 att2가 실려야 한다(대조군) ============
  {
    const rows = await SyncDAO.getMessageAttachments(pool, [], OLD_TS, 'other-user', ['b1']);
    const ids = rows.map((r) => r.id);
    check('대조군 — s2 실제 멤버(other-user)에게는 att2가 실린다(인가 로직 자체가 틀리지 않았음을 확인)', ids.includes('att2'));
  }

  console.log(`\n[messageAttachmentSyncRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[messageAttachmentSyncRegression] 실행 실패:', error);
  process.exitCode = 1;
});
