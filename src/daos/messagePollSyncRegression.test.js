/**
 * src/daos/messagePollSyncRegression.test.js
 * =========================================
 * RLY-20260806-094 — message_polls·message_poll_options·message_poll_votes 3테이블이
 * 델타 동기화 대상에서 통째로 빠져 있었다(투표를 만든 사람의 기기 말고는 존재를 알 수
 * 없었다, 088이 발견). 079(message_reactions)와 같은 부류인지 조사한 결과 셋으로 갈렸다:
 *
 *  - message_polls — reactions와 같다. closePoll이 부모(메시지) 불변인 채 독립적으로
 *    updated_at을 바꾼다. 079와 동일한 OR 스코프로 배선.
 *  - message_poll_options — embeds·mentions와 같다. updated_at 컬럼조차 없고(schema.sql)
 *    생성 후 개별 옵션을 고치는 경로가 없다. messageIds 스코프만.
 *  - message_poll_votes — ⚠️ 겉보기엔 reactions와 같아 보이지만 다르다. id도 deleted_at도
 *    없다(복합 PK). 재투표는 hard delete + 재삽입이라 "제거" 신호가 어떤 시간 필터로도
 *    안 남는다. 클라(sections_dao.dart:1085)는 poll 단위로 기존 투표를 지우고 서버가 보낸
 *    것만 재삽입하므로, 서버가 새 투표 행만 보내면 그 poll의 **다른 사용자 기존 투표까지
 *    지워진다**. 그래서 "새 투표가 있었던 poll_id"만 판정하고 그 poll의 현재 투표 **전량**을
 *    싣는다 — 이 스위트의 ③이 그 전량 재전송을 직접 검증한다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`, 가짜 pool로 실제 DAO 코드
 * (SyncDAO.getMessagePolls/getMessagePollOptions/getMessagePollVotes)를 그대로 구동한다
 * (messageReactionSyncRegression.test.js와 동일 — SQL 텍스트 매칭 mock).
 *
 * 실행: node src/daos/messagePollSyncRegression.test.js
 */


process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test';
process.env.PGDATABASE = process.env.PGDATABASE || 'test';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test';

const { SyncDAO } = require('../daos/syncDAO');

const OLD_TS = new Date('2026-08-01T00:00:00Z');
const HOUR = 60 * 60 * 1000;
const NEW = new Date(OLD_TS.getTime() + HOUR); // oldTs 이후(신규)
const OLDER = new Date(OLD_TS.getTime() - HOUR); // oldTs 이전(과거 — 전량 재전송 시에도 함께 실려야 함)

// ── 픽스처 ──────────────────────────────────────────────────────────────
const sections = {
  s1: { id: 's1', binder_id: 'b1', access_scope: 0 }, // 공개
  s2: { id: 's2', binder_id: 'b1', access_scope: 1 }, // 비공개 — other-user만 멤버
  s3: { id: 's3', binder_id: 'b2', access_scope: 0 }, // 공개지만 유저가 b2 멤버 아님
};
const sectionMembers = { 's2:other-user': { section_id: 's2', user_id: 'other-user', deleted_at: null } };
const messages = {
  m1: { id: 'm1', section_id: 's1' }, // 이미 동기화된 메시지 — 이번 델타 messageIds에 없음
  m2: { id: 'm2', section_id: 's2' }, // 비공개 섹션(비접근)
  m3: { id: 'm3', section_id: 's1' }, // 이번 델타에 새로 포함된 메시지
  m4: { id: 'm4', section_id: 's3' }, // 비접근 바인더
};
const polls = {
  // p1 — m1(불변 메시지)에 달린 투표. closePoll로 나중에 updated_at만 바뀜(핵심 재현 대상).
  p1: { id: 'p1', message_id: 'm1', question: 'Q1', allow_multiple: false, is_anonymous: false, closes_at: null, closed_at: NEW, created_at: OLDER, updated_at: NEW },
  // p2 — m2(비공개, 비접근)의 투표. updated_at은 새것이지만 인가로 막혀야 한다.
  p2: { id: 'p2', message_id: 'm2', question: 'Q2', allow_multiple: false, is_anonymous: false, closes_at: null, closed_at: null, created_at: OLDER, updated_at: NEW },
  // p3 — m3(이번 델타 포함 메시지)의 투표. 기존 messageIds 경로로 실려야 한다.
  p3: { id: 'p3', message_id: 'm3', question: 'Q3', allow_multiple: true, is_anonymous: false, closes_at: null, closed_at: null, created_at: NEW, updated_at: NEW },
};
const pollOptions = {
  o1a: { id: 'o1a', poll_id: 'p1', option_text: 'A', display_order: 0, created_at: OLDER },
  o1b: { id: 'o1b', poll_id: 'p1', option_text: 'B', display_order: 1, created_at: OLDER },
  o3a: { id: 'o3a', poll_id: 'p3', option_text: 'X', display_order: 0, created_at: NEW },
};
const pollVotes = {
  // p1에 대한 표 — 하나는 과거(v_old, oldTs 이전), 하나는 방금(v_new, oldTs 이후).
  // ③가 "v_new만 실린 게 있었다"는 신호로 p1을 골라내되, 실제로는 v_old까지 함께(poll
  // 전량) 실려야 한다는 것을 검증한다 — v_old만 빠지면 클라가 그 표를 지워버린다.
  v_old: { poll_id: 'p1', option_id: 'o1a', user_id: 'voter-old', voted_at: OLDER },
  v_new: { poll_id: 'p1', option_id: 'o1b', user_id: 'voter-new', voted_at: NEW },
  // p2(비접근)의 표 — 인가로 막혀야 한다.
  v_p2: { poll_id: 'p2', option_id: 'opt-x', user_id: 'other-user', voted_at: NEW },
  // p3(이번 델타에 새로 포함된 메시지의 투표) — hydrate/레거시 경로(oldTs 없음) 검증용.
  v_p3: { poll_id: 'p3', option_id: 'o3a', user_id: 'voter-p3', voted_at: NEW },
};

function makePool() {
  return {
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim();

      // ── getMessagePolls: 독립 분기(인가 포함) ──
      if (s.includes('FROM message_polls p') && s.includes('JOIN section_messages m')) {
        const [messageIds, oldTs, currDIds, userId] = params;
        const rows = Object.values(polls).filter((p) => {
          const m = messages[p.message_id];
          if (!m) return false;
          const sec = sections[m.section_id];
          if (!sec) return false;
          const inMessageIds = messageIds.includes(p.message_id) && p.updated_at > oldTs;
          const hasAccess = sec.access_scope === 0 ? currDIds.includes(sec.binder_id) : !!sectionMembers[`${sec.id}:${userId}`];
          const independentBranch = p.updated_at > oldTs && currDIds.includes(sec.binder_id) && hasAccess;
          return inMessageIds || independentBranch;
        });
        return { rows };
      }
      // ── getMessagePolls: 레거시(messageIds 전용) ──
      if (s.startsWith('SELECT * FROM message_polls')) {
        const [messageIds, oldTs] = params;
        const rows = Object.values(polls).filter((p) => messageIds.includes(p.message_id) && (!oldTs || p.updated_at > oldTs));
        return { rows };
      }

      // ── getMessagePollOptions ──
      if (s.startsWith('SELECT po.* FROM message_poll_options')) {
        const [messageIds] = params;
        const pollIdsInScope = new Set(Object.values(polls).filter((p) => messageIds.includes(p.message_id)).map((p) => p.id));
        const rows = Object.values(pollOptions).filter((o) => pollIdsInScope.has(o.poll_id));
        return { rows };
      }

      // ── getMessagePollVotes: 독립 분기(인가 포함, poll 단위 전량 재전송) ──
      if (s.includes('v.poll_id IN (')) {
        const [messageIds, oldTs, currDIds, userId] = params;
        // 1) "새 투표가 있었던 poll_id" 판정(079와 동일 OR 스코프)
        const affectedPollIds = new Set(
          Object.values(pollVotes).filter((v) => {
            const poll = polls[v.poll_id];
            if (!poll) return false;
            const m = messages[poll.message_id];
            const sec = sections[m.section_id];
            const inMessageIds = messageIds.includes(poll.message_id) && v.voted_at > oldTs;
            const hasAccess = sec.access_scope === 0 ? currDIds.includes(sec.binder_id) : !!sectionMembers[`${sec.id}:${userId}`];
            const independentBranch = v.voted_at > oldTs && currDIds.includes(sec.binder_id) && hasAccess;
            return inMessageIds || independentBranch;
          }).map((v) => v.poll_id)
        );
        // 2) 그 poll_id들의 현재 투표 전량(시간 필터 없음 — 전량 재전송)
        const rows = Object.values(pollVotes).filter((v) => affectedPollIds.has(v.poll_id));
        return { rows };
      }
      // ── getMessagePollVotes: 레거시(messageIds 전용, 전량) ──
      if (s.startsWith('SELECT v.* FROM message_poll_votes v JOIN message_polls p')) {
        const [messageIds] = params;
        const pollIdsInScope = new Set(Object.values(polls).filter((p) => messageIds.includes(p.message_id)).map((p) => p.id));
        const rows = Object.values(pollVotes).filter((v) => pollIdsInScope.has(v.poll_id));
        return { rows };
      }

      throw new Error(`[mock] Unhandled query: ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
    },
  };
}

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond) { if (cond) pass++; else { fail++; failures.push(desc); } }

async function run() {
  const pool = makePool();

  // ============ message_polls — 079(reactions)와 동일 모양 ============
  {
    const rows = await SyncDAO.getMessagePolls(pool, ['m3'], OLD_TS, 'u1', ['b1']);
    const ids = rows.map((p) => p.id);
    check('polls ① 부모(m1) 불변 + closePoll로 독립 변경된 p1이 실린다', ids.includes('p1'));
    check('polls ② 비접근(p2, s2 비멤버)은 안 실린다', !ids.includes('p2'));
    check('polls ③ 기존 messageIds 스코프(p3, m3 포함)는 여전히 실린다', ids.includes('p3'));
  }
  {
    // 대조군 — s2 실제 멤버(other-user)라면 p2가 실려야 한다(인가 로직 자체는 안 틀렸음을 확인)
    const rows = await SyncDAO.getMessagePolls(pool, [], OLD_TS, 'other-user', ['b1']);
    check('polls 대조군 — s2 실제 멤버에게는 p2가 실린다', rows.some((p) => p.id === 'p2'));
  }

  // ============ message_poll_options — embeds·mentions와 동일 모양(messageIds 스코프만) ============
  {
    const rows = await SyncDAO.getMessagePollOptions(pool, ['m3']);
    const ids = rows.map((o) => o.id);
    check('options — m3(p3)의 옵션(o3a)만 실린다', ids.includes('o3a') && !ids.includes('o1a'));
  }

  // ============ message_poll_votes — ⚠️ 다른 성질: poll 단위 전량 재전송 ============
  {
    const rows = await SyncDAO.getMessagePollVotes(pool, ['m3'], OLD_TS, 'u1', ['b1']);
    const keys = rows.map((v) => `${v.poll_id}:${v.option_id}:${v.user_id}`);
    check('votes ① p1에 새 투표(v_new)가 있었으므로 p1이 대상으로 잡힌다', keys.includes('p1:o1b:voter-new'));
    check('votes ② ⚠️ 핵심 — 같은 p1의 과거 투표(v_old, oldTs 이전)도 함께 실린다(부분만 보내면 클라가 지운다)', keys.includes('p1:o1a:voter-old'));
    check('votes ③ 비접근(p2)의 투표는 안 실린다', !keys.includes('p2:opt-x:other-user'));
  }
  {
    // 대조군
    const rows = await SyncDAO.getMessagePollVotes(pool, [], OLD_TS, 'other-user', ['b1']);
    check('votes 대조군 — s2 실제 멤버에게는 p2의 투표가 실린다', rows.some((v) => v.poll_id === 'p2'));
  }
  {
    // hydrate/레거시 경로 — oldTs 없이 messageIds만으로 호출(신규 섹션 접근 등). 시간 필터 없이 전량.
    const rows = await SyncDAO.getMessagePollVotes(pool, ['m3'], null);
    const keys = rows.map((v) => `${v.poll_id}:${v.option_id}:${v.user_id}`);
    check('votes hydrate — messageIds(m3)의 poll(p3) 투표가 시간 필터 없이 전량 실린다', keys.includes('p3:o3a:voter-p3'));
  }

  console.log(`\n[messagePollSyncRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[messagePollSyncRegression] 실행 실패:', error);
  process.exitCode = 1;
});
