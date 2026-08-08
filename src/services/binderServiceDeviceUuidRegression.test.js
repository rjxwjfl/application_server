/**
 * src/services/binderServiceDeviceUuidRegression.test.js
 * =========================================
 * RLY-20260806-179 — binderService.js의 6개 지점이 device_uuid를 아예 안 받았다
 * (issueBinderInvitation·updateBinderMemberRole·updateBinder·transferBinderMaster·
 * deleteBinder·decideJoinRequest — 나머지 메서드(createBinder·joinBinderByInvitation·
 * requestBinderJoin·kickBinderMember·leaveBinder)는 전부 받는데 이 6곳만 빠져 있었다).
 * authMiddleware가 모든 인증 요청에 예외 없이 req.device_uuid를 채우므로(x-device-id 헤더)
 * 못 받을 구조적 이유가 없었다 — sync/member:joined 이벤트의 device_uuid가 항상 undefined가
 * 돼, 그 액션을 실행한 바로 그 기기도 자기 기기 에코 억제(156 확인)가 안 돼 자기 액션에 대한
 * sync push를 스스로 받았다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`. eventBus.on으로 실제 emit을
 * 스파이한다(emitBinderIdRegression.test.js와 동일한 captureEmits 패턴).
 *
 * 실행: node src/services/binderServiceDeviceUuidRegression.test.js
 */

const assert = require('assert');

const dbPath = require.resolve('../../config/db');
const NOW = new Date('2026-08-08T00:00:00Z').toISOString();

const binderMembers = {
  'b1:master1': { binder_id: 'b1', user_id: 'master1', role: 0, notification_level: 1, nickname_in_binder: null, joined_at: NOW, deleted_at: null },
  'b1:manager1': { binder_id: 'b1', user_id: 'manager1', role: 1, notification_level: 1, nickname_in_binder: null, joined_at: NOW, deleted_at: null },
  'b1:member1': { binder_id: 'b1', user_id: 'member1', role: 3, notification_level: 1, nickname_in_binder: null, joined_at: NOW, deleted_at: null },
};
const joinRequests = {
  jr1: { id: 'jr1', binder_id: 'b1', requester_id: 'newbie1', status: 'PENDING', expires_at: NOW },
};

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // BinderDAO.getMember / requireBinderMember
  if (s.startsWith('SELECT binder_id, user_id, role, notification_level') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
    const row = binderMembers[`${params[0]}:${params[1]}`];
    return { rows: row ? [row] : [] };
  }
  // BinderDAO.getMembersForUpdate
  if (s.startsWith('SELECT binder_id, user_id, role, deleted_at') && s.includes('FOR UPDATE')) {
    const [binderId, userIds] = params;
    const rows = userIds.map((uid) => binderMembers[`${binderId}:${uid}`]).filter(Boolean);
    return { rows };
  }
  // BinderDAO.createInvitation
  if (s.startsWith('INSERT INTO binder_invitations')) {
    const [id, binder_id] = params;
    return { rows: [{ id, binder_id, invitation_code: 'tok', max_uses: 1, expires_at: NOW }] };
  }
  // BinderDAO.updateMemberRole
  if (s.startsWith('UPDATE binder_members') && s.includes('SET role =')) {
    const [role, binderId, userId] = params;
    if (binderMembers[`${binderId}:${userId}`]) binderMembers[`${binderId}:${userId}`].role = role;
    return { rows: [{ binder_id: binderId, user_id: userId, role }] };
  }
  // BinderDAO.update (binders 본문)
  if (s.startsWith('UPDATE binders') && s.includes('SET name')) {
    return { rows: [{ id: params[4], name: params[0], description: params[1], image_url: params[2], thumbnail_url: params[3] }] };
  }
  // BinderDAO.updateSettings
  if (s.startsWith('UPDATE binder_settings')) {
    return { rows: [{ binder_id: params[3], is_public: params[0], is_searchable: params[1], require_approval: params[2] }] };
  }
  // BinderDAO.cascadeSoftDelete — binder_members UPDATE
  if (s.startsWith('UPDATE binder_members') && s.includes('SET deleted_at')) return { rows: [] };
  // BinderDAO.cascadeSoftDelete — calendars SELECT
  if (s.startsWith('SELECT id FROM calendars')) return { rows: [] };
  // BinderDAO.cascadeSoftDelete — sections UPDATE, binders soft delete UPDATE
  if (s.startsWith('UPDATE sections') || (s.startsWith('UPDATE binders') && s.includes('deleted_at = now()'))) return { rows: [] };
  // BinderDAO.getJoinRequestForUpdate
  if (s.startsWith('SELECT id, binder_id, requester_id, status, expires_at')) {
    const row = joinRequests[params[0]];
    return { rows: row ? [row] : [] };
  }
  // BinderDAO.decideJoinRequest
  if (s.startsWith('UPDATE binder_join_requests')) {
    const [status, deciderId, requestId] = params;
    const jr = joinRequests[requestId];
    return { rows: [{ ...jr, status, decided_by: deciderId, decided_at: NOW }] };
  }
  // BinderDAO.addMember (approve 경로)
  if (s.startsWith('INSERT INTO binder_members')) {
    return { rows: [{ binder_id: params[0], user_id: params[1], role: params[2] }] };
  }
  // BinderDAO.incrementMemberCount
  if (s.startsWith('UPDATE binders') && s.includes('member_count')) return { rows: [] };

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { BinderService } = require('./binderService');
const eventBus = require('../events/eventBus');

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond, detail) { if (cond) pass++; else { fail++; failures.push(detail ? `${desc}: ${detail}` : desc); } }

async function captureEmits(fn) {
  const captured = [];
  const onSync = (payload) => captured.push({ event: 'sync', payload });
  const onMemberJoined = (payload) => captured.push({ event: 'member:joined', payload });
  eventBus.on('sync', onSync);
  eventBus.on('member:joined', onMemberJoined);
  try { await fn(); } finally { eventBus.off('sync', onSync); eventBus.off('member:joined', onMemberJoined); }
  return captured;
}

async function run() {
  // ============ ① issueBinderInvitation ============
  {
    const captured = await captureEmits(() => BinderService.issueBinderInvitation('b1', 'master1', 'dev-A'));
    check('① issueBinderInvitation — sync.device_uuid', captured[0]?.payload.device_uuid === 'dev-A', `실제=${JSON.stringify(captured[0]?.payload)}`);
  }

  // ============ ② updateBinderMemberRole ============
  {
    const captured = await captureEmits(() => BinderService.updateBinderMemberRole('b1', 'member1', 2, 'master1', 'dev-B'));
    check('② updateBinderMemberRole — sync.device_uuid', captured[0]?.payload.device_uuid === 'dev-B', `실제=${JSON.stringify(captured[0]?.payload)}`);
  }

  // ============ ③ updateBinder ============
  {
    const captured = await captureEmits(() => BinderService.updateBinder('b1', { name: 'new name' }, 'master1', 'dev-C'));
    check('③ updateBinder — sync.device_uuid', captured[0]?.payload.device_uuid === 'dev-C', `실제=${JSON.stringify(captured[0]?.payload)}`);
  }

  // ============ ④ transferBinderMaster ============
  {
    const captured = await captureEmits(() => BinderService.transferBinderMaster('b1', 'manager1', 'master1', 'dev-D'));
    check('④ transferBinderMaster — sync.device_uuid', captured[0]?.payload.device_uuid === 'dev-D', `실제=${JSON.stringify(captured[0]?.payload)}`);
    // 원상 복구(다음 케이스에 영향 없게) — role을 되돌린다.
    binderMembers['b1:master1'].role = 0;
    binderMembers['b1:manager1'].role = 1;
  }

  // ============ ⑤ deleteBinder ============
  {
    const captured = await captureEmits(() => BinderService.deleteBinder('b1', 'master1', 'dev-E'));
    check('⑤ deleteBinder — sync.device_uuid', captured[0]?.payload.device_uuid === 'dev-E', `실제=${JSON.stringify(captured[0]?.payload)}`);
  }

  // ============ ⑥ decideJoinRequest(approve) — member:joined에도 device_uuid가 실린다 ============
  {
    const captured = await captureEmits(() => BinderService.decideJoinRequest('b1', 'jr1', 'approve', 'master1', 'dev-F'));
    const memberJoined = captured.find((c) => c.event === 'member:joined');
    check('⑥ decideJoinRequest(approve) — member:joined 이벤트가 나간다', !!memberJoined);
    check('⑥ member:joined.device_uuid — "승인을 실행한 관리자"의 기기(가입 당사자가 아니다)',
      memberJoined?.payload.device_uuid === 'dev-F', `실제=${JSON.stringify(memberJoined?.payload)}`);
    check('⑥ member:joined.user_id — 가입 당사자(승인자와 다른 사람)', memberJoined?.payload.user_id === 'newbie1');
  }

  console.log(`\n[binderServiceDeviceUuidRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[binderServiceDeviceUuidRegression] 실행 실패:', error);
  process.exitCode = 1;
});
