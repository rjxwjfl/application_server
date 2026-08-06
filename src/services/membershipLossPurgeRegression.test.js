/**
 * src/services/membershipLossPurgeRegression.test.js
 * =========================================
 * RLY-20260806-039 멤버십 상실(삭제·강퇴·자진탈퇴) 정리 목록(purge_binder_ids) 회귀 스위트.
 *
 * 025가 남긴 구조적 발견: 바인더 삭제·강퇴·자진탈퇴로 접근을 잃으면 그 바인더가 currDIds에서
 * 빠지고 → oldDIds(델타 스코프)에서도 함께 빠져, 그 바인더 자식들의 tombstone이 델타 경로로
 * 원리적으로 전달되지 않는다. section 쪽엔 이를 위한 purge_section_ids reconciliation이 이미
 * 있었다 — 이 스위트는 그 기제를 바인더 레벨로 확장한 purge_binder_ids와, 그 확장이 실제로
 * 딛고 서는 s_ids 토큰 round-trip 수리를 검증한다.
 *
 * 이 저장소에는 테스트 프레임워크가 없다(`npm test`는 실패하는 placeholder). 기존 관행(plain
 * assert + `node <file>.js` 직접 실행, 가짜 DB connection으로 실제 서비스/DAO 코드를 구동)을
 * 그대로 따른다(emitBinderIdRegression.test.js와 동일하게 config/db.js를 require.cache로 교체).
 *
 * purge_binder_ids 자체는 syncService.js 안에서 `diff(prevToken.d_ids, currDIds)`로 계산되는데,
 * 그 currDIds가 진짜 바뀌는지를 손으로 흉내내지 않고 실제 BinderDAO.cascadeSoftDelete(삭제
 * 경로)·BinderDAO.removeMember(강퇴·자진탈퇴 경로, 두 서비스 메서드가 공유하는 같은 DAO)를 이
 * 스위트의 가짜 pool 위에서 그대로 실행해 검증한다 — "실제로 그 코드가 도는가"를 재현한다
 * (025 보고서의 교훈: JS로 하드코딩된 판정은 가짜 커버리지가 된다).
 *
 * 실행: node src/services/membershipLossPurgeRegression.test.js
 */

const assert = require('assert');

// src/configs/db.js가 모듈 로드 시점에 PGHOST 등을 eager 검증한다(syncService.js가 logger를
// require → configs/index.js → configs/db.js 체인을 태운다). pendingApplicantFilterCoverage
// Regression.test.js와 동일 관행 — 실제 접속은 아래 config/db.js 목(mock)이 가로채므로 더미 값이면 충분.
process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test';
process.env.PGDATABASE = process.env.PGDATABASE || 'test';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test';

// ── config/db.js를 가짜 커넥션으로 교체(require.cache 주입) ───────────────────
const dbPath = require.resolve('../../config/db');

// binder_members만 in-memory로 추적한다 — currDIds(getBinderIdsByUserId)가 유일하게 읽는
// 테이블이고, 이 스위트가 검증하는 것도 오직 그 currDIds 변화가 purge_binder_ids로 이어지는가다.
// Track A/B/C(콘텐츠 조회)는 025/029가 이미 커버한 관심사라 여기선 항상 빈 결과로 흉내낸다.
let binderMembers; // key: `${binderId}:${userId}` -> { binder_id, user_id, role, deleted_at }

function resetDb() {
  binderMembers = {};
}

function setMember(binderId, userId, role) {
  binderMembers[`${binderId}:${userId}`] = { binder_id: binderId, user_id: userId, role, deleted_at: null };
}

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();

  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // SyncDAO.getBinderIdsByUserId — currDIds의 유일한 출처, 이 스위트의 검증 대상 그 자체.
  if (s.startsWith('SELECT bm.binder_id FROM binder_members')) {
    const uid = params[0];
    const rows = Object.values(binderMembers)
      .filter((m) => m.user_id === uid && !m.deleted_at && m.role >= 0)
      .map((m) => ({ binder_id: m.binder_id }));
    return { rows };
  }
  // SyncDAO.getSubscribedCalIdsByUserId — 이 스위트는 구독 캘린더를 다루지 않는다.
  if (s.startsWith('SELECT calendar_id FROM calendar_subscriptions')) return { rows: [] };
  // SyncDAO.getAccessibleSectionIds — 섹션 콘텐츠는 이 스위트의 관심사 밖(접근가능 섹션 없음으로 고정).
  if (s.startsWith('SELECT s.id FROM sections s')) return { rows: [] };

  // BinderDAO.removeMember 1단계(강퇴·자진탈퇴 — 두 서비스 메서드가 공유) — 특정 유저 한 명만 제거.
  if (s.startsWith('UPDATE binder_members') && s.includes('user_id = $2')) {
    const key = `${params[0]}:${params[1]}`;
    if (binderMembers[key]) binderMembers[key].deleted_at = 'X';
    return { rows: [] };
  }
  // BinderDAO.cascadeSoftDelete 1단계(바인더 삭제) — 그 바인더 전 멤버 제거.
  if (s.startsWith('UPDATE binder_members SET deleted_at') && !s.includes('user_id')) {
    Object.values(binderMembers)
      .filter((m) => m.binder_id === params[0] && !m.deleted_at)
      .forEach((m) => { m.deleted_at = 'X'; });
    return { rows: [] };
  }

  // 그 외 전부(Track A/B/C 콘텐츠 조회·cascadeSoftDelete의 calendars/sections/binders 단계 등) —
  // 이 회귀의 단언 대상이 아니다. 빈 결과로 흉내낸다.
  return { rows: [] };
}

const mockDb = {
  query: mockQuery,
  connect: async () => ({ query: mockQuery, release() {} }),
};

require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

// ── 실제 서비스/DAO 로드(가짜 DB가 주입된 뒤) ─────────────────────────────────
const syncService = require('./syncService');
const { BinderDAO } = require('../daos/binderDAO');
const SyncToken = require('../utils/syncToken');

let pass = 0;
let fail = 0;
const failures = [];

function check(desc, cond) {
  if (cond) pass++;
  else { fail++; failures.push(desc); }
}

async function run() {
  // ============ ① 바인더 삭제 → 옛 멤버의 pull에 purge_binder_ids ============
  {
    resetDb();
    setMember('b1', 'user-1', 3);
    setMember('b2', 'user-1', 3); // user-1의 다른 바인더 — 잔류 확인용(같은 응답 안에서)
    const prevToken = SyncToken.encode({ ts: 100, d_ids: ['b1', 'b2'], c_ids: [], s_ids: [] });
    await BinderDAO.cascadeSoftDelete(mockDb, 'b1'); // 실제 삭제 cascade DAO 실행
    const result = await syncService.pullChanges('user-1', prevToken);
    const purge = result.data.access_reconciliation.purge_binder_ids;
    check('① 바인더 삭제 → 옛 멤버 pull에 purge_binder_ids에 b1 포함', purge.includes('b1'));
    check('① 잔류 바인더 b2는 purge_binder_ids에 없음', !purge.includes('b2'));
  }

  // ============ ② 강퇴(kick) → 강퇴당한 유저의 pull에 동일 ============
  // b2는 ①과 마찬가지로 user-1이 계속 접근 가능한 다른 바인더 — currDIds를 비우지 않아
  // _buildEmptyResponse(⑧이 이미 별도로 검증) 조기 반환이 아니라 일반 경로의 diff 계산을 태운다.
  {
    resetDb();
    setMember('b1', 'user-1', 3); // 강퇴당하는 멤버
    setMember('b1', 'user-2', 0); // 마스터(강퇴 주체, 잔류)
    setMember('b2', 'user-1', 3); // user-1의 다른 바인더 — 잔류 확인용
    const prevToken = SyncToken.encode({ ts: 100, d_ids: ['b1', 'b2'], c_ids: [], s_ids: [] });
    await BinderDAO.removeMember(mockDb, 'b1', 'user-1'); // binderService.kickBinderMember가 호출하는 실제 DAO
    const result = await syncService.pullChanges('user-1', prevToken);
    const purge = result.data.access_reconciliation.purge_binder_ids;
    check('② 강퇴 → 강퇴당한 유저 pull에 purge_binder_ids에 b1 포함', purge.includes('b1'));
    check('② 잔류 바인더 b2는 purge_binder_ids에 없음', !purge.includes('b2'));
  }

  // ============ ③ 자진탈퇴(leave) → 탈퇴한 유저의 pull에 동일 ============
  {
    resetDb();
    setMember('b1', 'user-1', 3);
    setMember('b1', 'user-2', 0);
    setMember('b2', 'user-1', 3); // user-1의 다른 바인더 — 잔류 확인용
    const prevToken = SyncToken.encode({ ts: 100, d_ids: ['b1', 'b2'], c_ids: [], s_ids: [] });
    await BinderDAO.removeMember(mockDb, 'b1', 'user-1'); // binderService.leaveBinder가 호출하는 실제 DAO(강퇴와 동일 DAO)
    const result = await syncService.pullChanges('user-1', prevToken);
    const purge = result.data.access_reconciliation.purge_binder_ids;
    check('③ 자진탈퇴 → 탈퇴한 유저 pull에 purge_binder_ids에 b1 포함', purge.includes('b1'));
    check('③ 잔류 바인더 b2는 purge_binder_ids에 없음', !purge.includes('b2'));
  }

  // ============ ④ 잔류 멤버(같은 바인더에서 강퇴당한 유저가 있어도)에게는 실리지 않음 — 핵심 안전장치 ============
  {
    resetDb();
    setMember('b1', 'user-1', 3); // 강퇴당함
    setMember('b1', 'user-2', 0); // 마스터, 잔류
    const prevToken = SyncToken.encode({ ts: 100, d_ids: ['b1'], c_ids: [], s_ids: [] });
    await BinderDAO.removeMember(mockDb, 'b1', 'user-1');
    const resultRemainingMember = await syncService.pullChanges('user-2', prevToken);
    check(
      '④ 같은 바인더에서 다른 멤버가 강퇴당해도 잔류 멤버(user-2) pull엔 purge_binder_ids 없음',
      resultRemainingMember.data.access_reconciliation.purge_binder_ids.length === 0
    );
  }

  // ============ ⑤ 토큰 없는 최초 동기화 — purge_binder_ids 빈 배열, 오작동 없음 ============
  {
    resetDb();
    setMember('b1', 'user-1', 3);
    const result = await syncService.pullChanges('user-1', null);
    check('⑤ 최초 동기화(토큰 없음) — purge_binder_ids 빈 배열', result.data.access_reconciliation.purge_binder_ids.length === 0);
  }

  // ============ ⑥ s_ids round-trip — encode → decode가 그대로 돌려준다 ============
  {
    const token = SyncToken.encode({ ts: 200, d_ids: ['d1'], c_ids: ['c1'], s_ids: ['s1', 's2'] });
    const decoded = SyncToken.decode(token);
    check('⑥ s_ids round-trip', JSON.stringify(decoded.s_ids) === JSON.stringify(['s1', 's2']));
  }

  // ============ ⑦ 기존 토큰 호환 — s_ids 없는 옛 포맷 토큰을 안전하게 [] 로 디코딩 ============
  {
    const legacyPayload = { ts: 200, d_ids: ['d1'], c_ids: ['c1'] }; // s_ids 필드 자체가 없음
    const legacyToken = Buffer.from(JSON.stringify(legacyPayload)).toString('base64');
    const decoded = SyncToken.decode(legacyToken);
    check('⑦ 기존 토큰(s_ids 없음) 디코딩 시 크래시 없이 s_ids=[]', Array.isArray(decoded.s_ids) && decoded.s_ids.length === 0);
  }

  // ============ ⑧ 마지막 바인더 상실(currDIds/currCIds 모두 0) 경로에서도 purge 실림 ============
  // _buildEmptyResponse 조기 반환 경로 — 고치기 전엔 access_reconciliation 자체가 응답에 없어
  // "잃은 마지막 하나"가 정리 목록에서 영원히 빠지는 사각지대였다.
  {
    resetDb();
    setMember('b1', 'user-1', 3);
    const prevToken = SyncToken.encode({ ts: 100, d_ids: ['b1'], c_ids: [], s_ids: ['s1'] });
    await BinderDAO.removeMember(mockDb, 'b1', 'user-1'); // 마지막 하나뿐이던 바인더에서 탈퇴/강퇴/삭제
    const result = await syncService.pullChanges('user-1', prevToken);
    check('⑧ 마지막 바인더 상실 — purge_binder_ids에 b1 포함', result.data.access_reconciliation.purge_binder_ids.includes('b1'));
    check('⑧ 마지막 바인더 상실 — purge_section_ids에 이전 섹션(s1) 포함', result.data.access_reconciliation.purge_section_ids.includes('s1'));
  }

  console.log(`\n[membershipLossPurgeRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[membershipLossPurgeRegression] 실행 실패:', error);
  process.exitCode = 1;
});
