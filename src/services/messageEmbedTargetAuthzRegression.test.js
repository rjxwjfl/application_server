/**
 * src/services/messageEmbedTargetAuthzRegression.test.js
 * =========================================
 * RLY-20260806-100 — messageService.createMessage가 F7 링크 카드 임베드(target_type·
 * target_id)를 검증 없이 그대로 INSERT하면, 아무 UUID나 넣어 **다른 binder**의 이벤트·
 * 태스크·기념일·캐스트·게시글을 자기 메시지의 카드로 만들 수 있었다(수정 전).
 *
 * SC-messaging.md §20-2 L4 — "같은 binder 멤버는 events·tasks·special_days·casts·posts
 * 자동 노출"(Calendar 도메인 정책, section access_scope와 무관 — standards/domain.md §3-6-B)
 * 이므로, 검증 기준은 "target이 이 메시지가 속한 섹션과 같은 binder에 있는가" 하나다.
 *
 * ⚠️ 차단만 단언하면 실제로는 전부 막아도(과잉 차단) 통과한다 — 5개 target_type 전부에
 * 대해 **같은 binder(허용)·다른 binder(차단)** 대조군을 쌍으로 넣는다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`, require.cache로 config/db를
 * 가짜 connection으로 교체해 실제 서비스 코드(MessageService.createMessage)를 그대로 구동한다
 * (defaultSectionProtectionRegression.test.js·messagePinServiceRegression.test.js와 동일 관행).
 *
 * 실행: node src/services/messageEmbedTargetAuthzRegression.test.js
 */

const assert = require('assert');

const dbPath = require.resolve('../../config/db');
const NOW = new Date('2026-08-07T00:00:00Z').toISOString();

// ── 픽스처 ──────────────────────────────────────────────────────────────
// b1 = 메시지를 보내는 섹션(s1)이 속한 binder. b2 = 전혀 무관한 다른 binder(공격자가
// target_id로 노려보는 대상 소유 binder) — 발신자는 b2 멤버가 아니다.
const sections = { s1: { id: 's1', binder_id: 'b1', title: 'Sec', access_scope: 0, is_default: false, created_at: NOW, updated_at: NOW, deleted_at: null } };
const calendars = {
  cal1: { id: 'cal1', binder_id: 'b1' }, // 정당한 대상들의 캘린더(b1)
  cal2: { id: 'cal2', binder_id: 'b2' }, // 무관한 binder(b2)의 캘린더
};
const events = { e1: { id: 'e1', calendar_id: 'cal1' }, e2: { id: 'e2', calendar_id: 'cal2' } };
const eventInstances = { ei1: { id: 'ei1', event_id: 'e1', deleted_at: null }, ei2: { id: 'ei2', event_id: 'e2', deleted_at: null } };
const tasks = { t1: { id: 't1', calendar_id: 'cal1' }, t2: { id: 't2', calendar_id: 'cal2' } };
const taskInstances = { ti1: { id: 'ti1', task_id: 't1', deleted_at: null }, ti2: { id: 'ti2', task_id: 't2', deleted_at: null } };
const specialDays = { sd1: { id: 'sd1', calendar_id: 'cal1', deleted_at: null }, sd2: { id: 'sd2', calendar_id: 'cal2', deleted_at: null } };
const casts = { ca1: { id: 'ca1', calendar_id: 'cal1', deleted_at: null }, ca2: { id: 'ca2', calendar_id: 'cal2', deleted_at: null } };
const posts = { p1: { id: 'p1', binder_id: 'b1', deleted_at: null }, p2: { id: 'p2', binder_id: 'b2', deleted_at: null } };

let messageSeq = 0;
const savedMessages = {};
const savedEmbeds = [];

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // SectionDAO.findById
  if (s.startsWith('SELECT id, binder_id, title, access_scope, is_default')) {
    const row = sections[params[0]];
    return { rows: row ? [row] : [] };
  }

  // MessageDAO.create
  if (s.startsWith('INSERT INTO section_messages')) {
    const [id, section_id, user_id, parent_id, content, mention_everyone] = params;
    const row = { id, section_id, user_id, parent_id, content, mention_everyone, is_pinned: false, created_at: NOW, updated_at: NOW };
    savedMessages[id] = row;
    return { rows: [row] };
  }

  // ── EMBED_TARGET_VALIDATORS (messageService.js) ──
  if (s.includes('FROM event_instances ei') && s.includes('JOIN events e')) {
    const [targetId, binderId] = params;
    const ei = eventInstances[targetId];
    const ev = ei && events[ei.event_id];
    const cal = ev && calendars[ev.calendar_id];
    const ok = !!(ei && !ei.deleted_at && cal && cal.binder_id === binderId);
    return { rowCount: ok ? 1 : 0, rows: ok ? [{ x: 1 }] : [] };
  }
  if (s.includes('FROM task_instances ti') && s.includes('JOIN tasks t')) {
    const [targetId, binderId] = params;
    const ti = taskInstances[targetId];
    const t = ti && tasks[ti.task_id];
    const cal = t && calendars[t.calendar_id];
    const ok = !!(ti && !ti.deleted_at && cal && cal.binder_id === binderId);
    return { rowCount: ok ? 1 : 0, rows: ok ? [{ x: 1 }] : [] };
  }
  if (s.includes('FROM special_days sd')) {
    const [targetId, binderId] = params;
    const sd = specialDays[targetId];
    const cal = sd && calendars[sd.calendar_id];
    const ok = !!(sd && !sd.deleted_at && cal && cal.binder_id === binderId);
    return { rowCount: ok ? 1 : 0, rows: ok ? [{ x: 1 }] : [] };
  }
  if (s.includes('FROM casts ca')) {
    const [targetId, binderId] = params;
    const ca = casts[targetId];
    const cal = ca && calendars[ca.calendar_id];
    const ok = !!(ca && !ca.deleted_at && cal && cal.binder_id === binderId);
    return { rowCount: ok ? 1 : 0, rows: ok ? [{ x: 1 }] : [] };
  }
  if (s.includes('FROM posts p') && s.includes('p.binder_id = $2')) {
    const [targetId, binderId] = params;
    const p = posts[targetId];
    const ok = !!(p && !p.deleted_at && p.binder_id === binderId);
    return { rowCount: ok ? 1 : 0, rows: ok ? [{ x: 1 }] : [] };
  }

  // MessageDAO.insertEmbeds
  if (s.startsWith('INSERT INTO message_embeds')) {
    const rows = [];
    for (let i = 0; i < params.length; i += 11) {
      const [id, message_id, type, url, title, description, site_name, image_url, target_type, target_id, embed_data] = params.slice(i, i + 11);
      const row = { id, message_id, type, url, title, description, site_name, image_url, target_type, target_id, embed_data: embed_data ? JSON.parse(embed_data) : null };
      savedEmbeds.push(row);
      rows.push(row);
    }
    return { rows };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { MessageService } = require('./messageService');

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond) { if (cond) pass++; else { fail++; failures.push(desc); } }

function ctx() { return { sender_id: 'u1', device_uuid: 'dev1' }; }

async function expectOk(desc, fn) {
  try { await fn(); pass++; } catch (err) { fail++; failures.push(`${desc}: 정상 통과 기대했지만 에러 — ${err.statusCode || ''} ${err.message}`); }
}
async function expectBlocked(desc, fn, expectedCode) {
  try {
    await fn();
    fail++;
    failures.push(`${desc}: 차단을 기대했지만 통과해버림`);
  } catch (err) {
    if (err.statusCode === 403 && (!expectedCode || err.errorCode === expectedCode)) pass++;
    else { fail++; failures.push(`${desc}: 403(${expectedCode || 'SECTION_ACCESS_DENIED'}) 기대, 실제 ${err.statusCode || ''} ${err.code || ''} ${err.message}`); }
  }
}

async function run() {
  let seq = 0;
  const msg = () => `msg-${++seq}`;
  const embed = (targetType, targetId) => [{ id: `emb-${seq}`, type: 'link', url: null, target_type: targetType, target_id: targetId }];

  // ============ 5개 target_type × (같은 binder=허용 / 다른 binder=차단) 대조 쌍 ============
  const cases = [
    ['EVENT_INSTANCE', 'ei1', 'ei2'],
    ['TASK_INSTANCE', 'ti1', 'ti2'],
    ['SPECIAL_DAY', 'sd1', 'sd2'],
    ['CAST', 'ca1', 'ca2'],
    ['POST', 'p1', 'p2'],
  ];

  for (const [targetType, sameId, otherId] of cases) {
    await expectOk(
      `허용 — ${targetType} 같은 binder(${sameId}) 대상은 카드가 만들어진다(대조군)`,
      () => MessageService.createMessage('s1', { id: msg(), content: 'x', embeds: embed(targetType, sameId) }, ctx())
    );
    await expectBlocked(
      `차단 — ${targetType} 다른 binder(${otherId}) 대상은 카드로 만들 수 없다`,
      () => MessageService.createMessage('s1', { id: msg(), content: 'x', embeds: embed(targetType, otherId) }, ctx()),
      'SECTION_ACCESS_DENIED'
    );
  }

  // ============ 저장된 카드에 target_type·target_id가 실제로 실렸는지(대조군의 실질 확인) ============
  {
    const savedForEi1 = savedEmbeds.find((e) => e.target_id === 'ei1');
    check('허용된 카드의 target_type이 그대로 저장됨', savedForEi1 && savedForEi1.target_type === 'EVENT_INSTANCE');
  }

  // ============ 존재하지 않는 target_id — 차단(cross-binder와 같은 취급, IDOR 탐색 신호 없음) ============
  await expectBlocked(
    '차단 — 존재하지 않는 target_id',
    () => MessageService.createMessage('s1', { id: msg(), content: 'x', embeds: embed('EVENT_INSTANCE', 'ei-nonexistent') }, ctx()),
    'SECTION_ACCESS_DENIED'
  );

  // ============ target_type만 있고 target_id 없음 — 400 ============
  try {
    await MessageService.createMessage('s1', { id: msg(), content: 'x', embeds: [{ id: `emb-${++seq}`, type: 'link', target_type: 'EVENT_INSTANCE' }] }, ctx());
    fail++; failures.push('target_id 없이 target_type만 있으면 400을 기대했지만 통과함');
  } catch (err) {
    if (err.statusCode === 400) pass++; else { fail++; failures.push(`target_id 누락 400 기대, 실제 ${err.statusCode} ${err.message}`); }
  }

  // ============ 알 수 없는 target_type — 400(새 카드 종류를 몰래 등록해 검증을 우회 못함) ============
  try {
    await MessageService.createMessage('s1', { id: msg(), content: 'x', embeds: [{ id: `emb-${++seq}`, type: 'link', target_type: 'BINDER', target_id: 'b1' }] }, ctx());
    fail++; failures.push('알 수 없는 target_type이면 400을 기대했지만 통과함');
  } catch (err) {
    if (err.statusCode === 400) pass++; else { fail++; failures.push(`알 수 없는 target_type 400 기대, 실제 ${err.statusCode} ${err.message}`); }
  }

  // ============ 회귀 불변 — 기존 link 임베드(target_type 없음)는 검증을 거치지 않고 그대로 통과 ============
  await expectOk(
    '회귀 불변 — target_type 없는 기존 link 임베드는 검증 없이 통과',
    () => MessageService.createMessage('s1', { id: msg(), content: 'x', embeds: [{ id: `emb-${++seq}`, type: 'link', url: 'https://example.com' }] }, ctx())
  );

  // ============ 회귀 불변 — 임베드 없는 일반 메시지 생성 자체는 그대로 동작 ============
  await expectOk(
    '회귀 불변 — 임베드 없는 메시지 생성',
    () => MessageService.createMessage('s1', { id: msg(), content: '그냥 텍스트' }, ctx())
  );

  console.log(`\n[messageEmbedTargetAuthzRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[messageEmbedTargetAuthzRegression] 실행 실패:', error);
  process.exitCode = 1;
});
