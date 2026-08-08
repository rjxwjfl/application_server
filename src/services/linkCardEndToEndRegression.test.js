/**
 * src/services/linkCardEndToEndRegression.test.js
 * =========================================
 * RLY-20260806-130 — F7 링크 카드가 여러 Task(087 쓰기 공백 판정 · 100 쓰기 경로+대상 검증 ·
 * 105 클라 요청 필드 · 128 대상 목록)로 나뉘어 들어갔다. 각 조각은 자기 회귀를 통과했지만
 * 전체가 실제로 이어지는지는 아무도 보지 않았다 — 이 스위트가 그 종단 확인이다.
 *
 * 확인하는 것 셋:
 *   ① picker(BinderService.getItems·PostService.getPosts)가 "보여주는" 것과
 *     EMBED_TARGET_VALIDATORS(messageService.js)가 "허용하는" 것이 정확히 같은 경계인가
 *     (같은 binder=보임+허용 / 다른 binder=안 보임+차단 / soft-delete=안 보임+차단).
 *   ② 목록에서 고른 대상으로 실제 메시지를 만들면 저장→응답까지 값이 그대로 실리는가, 다른
 *     binder 대상을 억지로 넣으면 거부되는가(그리고 그 거부의 트랜잭션 원자성 한계 — 아래
 *     "미검증" 참조).
 *   ③ 클라가 실제로 보낼 수 있는 요청 형태(EmbedRequest.toJson() — id 필드 없음)로 보내도
 *     되는가. 이 축이 실제 Blocker(message_embeds.id NOT NULL인데 클라 DTO에 id가 없음)를
 *     찾았다 — messageService.js에서 함께 수리했다(이 파일이 그 회귀다).
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`, config/db를 가짜 connection으로
 * 교체해 실제 서비스 코드(BinderService.getItems·PostService.getPosts·MessageService.createMessage·
 * SyncDAO.getMessageEmbeds)를 그대로 구동한다.
 *
 * 실행: node src/services/linkCardEndToEndRegression.test.js
 */


const dbPath = require.resolve('../../config/db');
const NOW = new Date('2026-08-07T00:00:00Z').toISOString();

// ── 픽스처 ──────────────────────────────────────────────────────────────
// b1 = 발신자가 속한 binder(메시지를 보내는 섹션 s1도 b1). b2 = 무관한 다른 binder.
const binderMembers = { 'b1:member1': { binder_id: 'b1', user_id: 'member1', role: 3, deleted_at: null } };
const sections = { s1: { id: 's1', binder_id: 'b1', title: 'Sec', access_scope: 0, is_default: false, created_at: NOW, updated_at: NOW, deleted_at: null } };
const calendars = { cal1: { id: 'cal1', binder_id: 'b1' }, cal2: { id: 'cal2', binder_id: 'b2' } };

const events = { e1: { id: 'e1', calendar_id: 'cal1' }, e2: { id: 'e2', calendar_id: 'cal2' } };
const eventInstances = [
  { id: 'ei1', event_id: 'e1', summary: '이번 주 회의', description: null, color: 0, is_all_day: false, start_date: '2026-08-10T05:00:00.000Z', end_date: '2026-08-10T06:00:00.000Z', deleted_at: null },
  { id: 'ei1-deleted', event_id: 'e1', summary: '삭제된 회차', description: null, color: 0, is_all_day: false, start_date: '2026-08-09T05:00:00.000Z', end_date: '2026-08-09T06:00:00.000Z', deleted_at: NOW },
  { id: 'ei2', event_id: 'e2', summary: '남의 바인더 이벤트', description: null, color: 0, is_all_day: false, start_date: '2026-08-10T05:00:00.000Z', end_date: '2026-08-10T06:00:00.000Z', deleted_at: null },
];

const tasks = { t1: { id: 't1', calendar_id: 'cal1' }, t2: { id: 't2', calendar_id: 'cal2' } };
const taskInstances = [
  { id: 'ti1', task_id: 't1', summary: '보고서 제출', description: null, priority: 0, is_all_day: false, start_date: null, due_date: '2026-08-12T00:00:00.000Z', completed_at: null, deleted_at: null },
  { id: 'ti2', task_id: 't2', summary: '남의 바인더 태스크', description: null, priority: 0, is_all_day: false, start_date: null, due_date: '2026-08-12T00:00:00.000Z', completed_at: null, deleted_at: null },
];

const specialDays = [
  { id: 'sd1', calendar_id: 'cal1', name: '생일', base_date: '2026-08-15', deleted_at: null },
  { id: 'sd2', calendar_id: 'cal2', name: '남의 바인더 기념일', base_date: '2026-08-15', deleted_at: null },
];

const casts = [
  { id: 'ca1', calendar_id: 'cal1', title: '공지', deleted_at: null, created_at: '2026-08-10T00:00:00.000Z' },
  { id: 'ca2', calendar_id: 'cal2', title: '남의 바인더 캐스트', deleted_at: null, created_at: '2026-08-10T00:00:00.000Z' },
];

const posts = {
  p1: { id: 'p1', binder_id: 'b1', author_id: 'u1', body_markdown: '본문', title: null, created_at: NOW, deleted_at: null },
  p2: { id: 'p2', binder_id: 'b2', author_id: 'u1', body_markdown: '남의 바인더 게시물', title: null, created_at: NOW, deleted_at: null },
};

function calIdOf(row) {
  if (row.event_id) return events[row.event_id]?.calendar_id;
  if (row.task_id) return tasks[row.task_id]?.calendar_id;
  return row.calendar_id;
}
function scopedRows(rows, binderId, cursorField, cursorAt) {
  return rows
    .filter((r) => !r.deleted_at)
    .filter((r) => calendars[calIdOf(r)]?.binder_id === binderId)
    .filter((r) => !cursorAt || r[cursorField] < cursorAt)
    .sort((a, b) => (a[cursorField] < b[cursorField] ? 1 : -1));
}

// EMBED_TARGET_VALIDATORS와 정확히 같은 존재+스코프 판정(대상이 있고, 안 지워졌고, 그 binder
// 소속인가) — picker(scopedRows)가 쓰는 판정 로직과 반드시 같은 결과를 내야 ①이 성립한다.
function validatorOk(kind, targetId, binderId) {
  if (kind === 'EVENT_INSTANCE') { const r = eventInstances.find((x) => x.id === targetId); return !!(r && !r.deleted_at && calendars[calIdOf(r)]?.binder_id === binderId); }
  if (kind === 'TASK_INSTANCE') { const r = taskInstances.find((x) => x.id === targetId); return !!(r && !r.deleted_at && calendars[calIdOf(r)]?.binder_id === binderId); }
  if (kind === 'SPECIAL_DAY') { const r = specialDays.find((x) => x.id === targetId); return !!(r && !r.deleted_at && calendars[r.calendar_id]?.binder_id === binderId); }
  if (kind === 'CAST') { const r = casts.find((x) => x.id === targetId); return !!(r && !r.deleted_at && calendars[r.calendar_id]?.binder_id === binderId); }
  if (kind === 'POST') { const r = posts[targetId]; return !!(r && !r.deleted_at && r.binder_id === binderId); }
  return false;
}

let messageSeq = 0;
const savedMessages = {};
const savedEmbeds = [];

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // BinderDAO.getMember
  if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
    return { rows: binderMembers[`${params[0]}:${params[1]}`] ? [binderMembers[`${params[0]}:${params[1]}`]] : [] };
  }
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

  // ── picker(128) — BinderService.getItems가 호출하는 4개 DAO ──
  // ⚠️ 검증기(EMBED_TARGET_VALIDATORS, 아래)와 FROM/JOIN 절이 같아서(둘 다 100이 128과
  // 같은 JOIN을 쓰게 했다 — 그게 이 Task의 핵심 확인 대상) WHERE 절 선두로만 구분해야 한다
  // (picker=`WHERE c.binder_id = $1...`, 검증기=`WHERE ei.id = $1...`).
  if (s.includes('FROM event_instances ei') && s.includes('WHERE c.binder_id = $1')) {
    const [binderId, limit, cursorAt] = params;
    return { rows: scopedRows(eventInstances, binderId, 'start_date', cursorAt).slice(0, limit) };
  }
  if (s.includes('FROM task_instances ti') && s.includes('WHERE c.binder_id = $1')) {
    const [binderId, limit, cursorAt] = params;
    return { rows: scopedRows(taskInstances, binderId, 'due_date', cursorAt).slice(0, limit) };
  }
  if (s.includes('FROM special_days sd') && s.includes('WHERE c.binder_id = $1')) {
    const [binderId, limit, cursorAt] = params;
    return { rows: scopedRows(specialDays, binderId, 'base_date', cursorAt).slice(0, limit) };
  }
  if (s.includes('FROM casts ca') && s.includes('WHERE c.binder_id = $1')) {
    const [binderId, limit, cursorAt] = params;
    return { rows: scopedRows(casts, binderId, 'created_at', cursorAt).slice(0, limit) };
  }
  // PostDAO.findByBinderId(picker의 POST 경로 — 기존 endpoint 재사용)
  if (s.includes('FROM posts p') && s.includes('LEFT JOIN user_infos')) {
    const [binderId] = params;
    const rows = Object.values(posts).filter((p) => !p.deleted_at && p.binder_id === binderId)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return { rows };
  }
  // AttachmentDAO.findByContext(PostService.withAttachments — 응답 조립용, 인가와 무관)
  if (s.includes('FROM attachments') && s.includes('context_type')) return { rows: [] };

  // ── EMBED_TARGET_VALIDATORS(100) — messageService.js가 쓰기 시점에 쓰는 EXISTS류 쿼리 ──
  if (s.includes('FROM event_instances ei') && s.includes('WHERE ei.id = $1')) {
    const [targetId, binderId] = params;
    const ok = validatorOk('EVENT_INSTANCE', targetId, binderId);
    return { rowCount: ok ? 1 : 0, rows: ok ? [{ x: 1 }] : [] };
  }
  if (s.includes('FROM task_instances ti') && s.includes('WHERE ti.id = $1')) {
    const [targetId, binderId] = params;
    const ok = validatorOk('TASK_INSTANCE', targetId, binderId);
    return { rowCount: ok ? 1 : 0, rows: ok ? [{ x: 1 }] : [] };
  }
  if (s.includes('FROM special_days sd') && s.includes('WHERE sd.id = $1')) {
    const [targetId, binderId] = params;
    const ok = validatorOk('SPECIAL_DAY', targetId, binderId);
    return { rowCount: ok ? 1 : 0, rows: ok ? [{ x: 1 }] : [] };
  }
  if (s.includes('FROM casts ca') && s.includes('WHERE ca.id = $1')) {
    const [targetId, binderId] = params;
    const ok = validatorOk('CAST', targetId, binderId);
    return { rowCount: ok ? 1 : 0, rows: ok ? [{ x: 1 }] : [] };
  }
  if (s.includes('FROM posts p') && s.includes('WHERE p.id = $1')) {
    const [targetId, binderId] = params;
    const ok = validatorOk('POST', targetId, binderId);
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

  // SyncDAO.getMessageEmbeds(델타 동기화 — ③ 확인용)
  if (s.startsWith('SELECT * FROM message_embeds')) {
    const [messageIds] = params;
    return { rows: savedEmbeds.filter((e) => messageIds.includes(e.message_id)) };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { BinderService } = require('./binderService');
const { PostService } = require('./postService');
const { MessageService } = require('./messageService');
const { SyncDAO } = require('../daos/syncDAO');

const ctx = () => ({ sender_id: 'member1', device_uuid: 'dev1' });
const msg = () => `msg-${++messageSeq}`;

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond, detail) { if (cond) pass++; else { fail++; failures.push(detail ? `${desc}: ${detail}` : desc); } }

// RLY-20260806-199 — lint(no-unreachable)로 발견: `return await fn(); pass++;` 순서라
// pass++가 항상 죽은 코드였다(정상 통과해도 카운터가 안 올라갔다) — 실패는 그대로
// fail++·failures로 잡히니 이 파일의 빨강/초록 판정 자체는 안 틀렸지만, 화면에 찍히는
// PASS 총량이 실제보다 적게 나왔다. 카운트가 먼저 되도록 순서를 바꿨다.
async function expectOk(desc, fn) {
  try { const result = await fn(); pass++; return result; } catch (err) { fail++; failures.push(`${desc}: 정상 통과 기대했지만 에러 — ${err.statusCode || ''} ${err.message}`); return undefined; }
}
async function expectBlocked(desc, fn, expectedStatus = 403) {
  try {
    await fn();
    fail++;
    failures.push(`${desc}: 차단(${expectedStatus})을 기대했지만 통과해버림`);
  } catch (err) {
    if (err.statusCode === expectedStatus) pass++;
    else { fail++; failures.push(`${desc}: ${expectedStatus} 기대, 실제 ${err.statusCode || ''} ${err.message}`); }
  }
}

// picker 목록에서 실제로 id가 나오는지
async function pickerIds(type) {
  if (type === 'POST') {
    const rows = await PostService.getPosts('b1', {}, 'member1');
    return rows.map((r) => r.id);
  }
  const rows = await BinderService.getItems('b1', { type }, 'member1');
  return rows.map((r) => r.id);
}

async function run() {
  const cases = [
    ['EVENT_INSTANCE', 'ei1', 'ei2', 'ei1-deleted'],
    ['TASK_INSTANCE', 'ti1', 'ti2', null],
    ['SPECIAL_DAY', 'sd1', 'sd2', null],
    ['CAST', 'ca1', 'ca2', null],
    ['POST', 'p1', 'p2', null],
  ];

  for (const [type, sameId, otherId, deletedId] of cases) {
    // ① 목록 ↔ 검증 경계 — 같은 binder는 보이고, 다른 binder는 안 보인다
    const ids = await pickerIds(type);
    check(`① ${type} picker — 같은 binder 항목(${sameId})이 목록에 있다`, ids.includes(sameId), `목록=${JSON.stringify(ids)}`);
    check(`① ${type} picker — 다른 binder 항목(${otherId})은 목록에 없다`, !ids.includes(otherId), `목록=${JSON.stringify(ids)}`);
    check(`① ${type} 검증기 — 같은 binder(${sameId})는 허용`, validatorOk(type, sameId, 'b1'));
    check(`① ${type} 검증기 — 다른 binder(${otherId})는 차단`, !validatorOk(type, otherId, 'b1'));

    if (deletedId) {
      check(`① ${type} picker — soft-delete 항목(${deletedId})은 목록에 없다`, !ids.includes(deletedId), `목록=${JSON.stringify(ids)}`);
      check(`① ${type} 검증기 — soft-delete 항목(${deletedId})도 차단(목록과 같은 결론)`, !validatorOk(type, deletedId, 'b1'));
    }

    // ② 목록에서 고른 대상으로 실제 카드 생성 — 클라 EmbedRequest.toJson() 형태(id 없음!)를
    // 그대로 흉내낸다 — ③ 필드명·id 부재 문제를 이 경로로 함께 확인한다.
    const clientShapedEmbed = { type: 'link', url: null, target_type: type, target_id: sameId }; // id 없음
    const created = await expectOk(
      `② ${type} — picker가 보여준 대상으로 카드 생성(클라 DTO 형태, id 없음)`,
      () => MessageService.createMessage('s1', { id: msg(), content: 'x', embeds: [clientShapedEmbed] }, ctx())
    );
    if (created) {
      const embed = created.embeds[0];
      check(`② ${type} — 저장된 카드의 target_type·target_id가 그대로 실렸다`,
        embed && embed.target_type === type && embed.target_id === sameId,
        `실제=${JSON.stringify(embed)}`);
      check(`③ ${type} — 서버가 id를 채워 UUID 형태로 저장했다(클라가 안 보냈는데도)`,
        embed && typeof embed.id === 'string' && embed.id.length >= 32,
        `실제 id=${embed && embed.id}`);

      // 델타 동기화에 실제로 실리는지
      const delta = await SyncDAO.getMessageEmbeds(mockDb, [created.id], null);
      check(`③ ${type} — 델타 동기화 조회에도 같은 target_type·target_id가 나온다`,
        delta.length === 1 && delta[0].target_type === type && delta[0].target_id === sameId,
        `실제=${JSON.stringify(delta)}`);
    }

    // 목록에 없던 대상(다른 binder)을 억지로 넣으면 거부되는가 — ①의 반대 방향 확인.
    await expectBlocked(
      `① ${type} — picker에 없던 다른 binder 대상(${otherId})은 카드 생성도 거부된다`,
      () => MessageService.createMessage('s1', { id: msg(), content: 'x', embeds: [{ type: 'link', target_type: type, target_id: otherId }] }, ctx())
    );
  }

  console.log(`\n[linkCardEndToEndRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[linkCardEndToEndRegression] 실행 실패:', error);
  process.exitCode = 1;
});
