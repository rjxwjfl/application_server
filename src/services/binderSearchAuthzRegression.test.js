/**
 * src/services/binderSearchAuthzRegression.test.js
 * =========================================
 * RLY-20260806-135 — `GET /binders/:binderId/search`(`BinderService.search`, `api.md` 미문서화·
 * 128이 등재)에 special_days·casts 2종을 128이 확정한 경계(calendars.binder_id JOIN,
 * deleted_at IS NULL — EMBED_TARGET_VALIDATORS·getItems와 동일)로 추가하고, messages 분기의
 * 누락(`s.deleted_at IS NULL` 부재 — 소프트 삭제된 섹션의 메시지가 검색에 새어 나옴)을 수리한
 * 회귀.
 *
 * ⚠️ 차단만 단언하면 전부 막아도 통과한다 — 6종(events·tasks·posts·special_days·casts·messages)
 * 전부 같은 binder(보임)·다른 binder(안 보임) 대조 쌍을 넣는다. messages는 추가로 비공개 섹션
 * (본인 접근 가능/불가능)·소프트 삭제된 섹션(이번에 고친 것) 대조도 넣는다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`, config/db를 가짜 connection으로
 * 교체해 실제 서비스 코드(BinderService.search)를 그대로 구동한다.
 *
 * 실행: node src/services/binderSearchAuthzRegression.test.js
 */


const dbPath = require.resolve('../../config/db');
const NOW = new Date('2026-08-07T00:00:00Z').toISOString();

// ── 픽스처 ──────────────────────────────────────────────────────────────
// b1 = 검색 주체 binder. b2 = 무관한 다른 binder.
const binderMembers = {
  'b1:member1': { binder_id: 'b1', user_id: 'member1', role: 3, deleted_at: null },
};
const calendars = { cal1: { id: 'cal1', binder_id: 'b1' }, cal2: { id: 'cal2', binder_id: 'b2' } };

const events = { e1: { id: 'e1', calendar_id: 'cal1' }, e2: { id: 'e2', calendar_id: 'cal2' } };
const eventInstances = [
  { id: 'ei1', event_id: 'e1', summary: '회의록 검토', start_date: '2026-08-10T00:00:00.000Z', end_date: '2026-08-10T01:00:00.000Z', is_all_day: false, deleted_at: null },
  { id: 'ei2', event_id: 'e2', summary: '회의록 검토(남의 바인더)', start_date: '2026-08-10T00:00:00.000Z', end_date: '2026-08-10T01:00:00.000Z', is_all_day: false, deleted_at: null },
];

const tasks = { t1: { id: 't1', calendar_id: 'cal1' }, t2: { id: 't2', calendar_id: 'cal2' } };
const taskInstances = [
  { id: 'ti1', task_id: 't1', summary: '보고서 검토', due_date: '2026-08-12T00:00:00.000Z', priority: 0, deleted_at: null },
  { id: 'ti2', task_id: 't2', summary: '보고서 검토(남의 바인더)', due_date: '2026-08-12T00:00:00.000Z', priority: 0, deleted_at: null },
];

const specialDays = [
  { id: 'sd1', calendar_id: 'cal1', name: '검토 기념일', base_date: '2026-08-15', deleted_at: null },
  { id: 'sd2', calendar_id: 'cal2', name: '검토 기념일(남의 바인더)', base_date: '2026-08-15', deleted_at: null },
];

const casts = [
  { id: 'ca1', calendar_id: 'cal1', title: '검토 공지', summary: null, created_at: '2026-08-10T00:00:00.000Z', deleted_at: null },
  { id: 'ca2', calendar_id: 'cal2', title: '검토 공지(남의 바인더)', summary: null, created_at: '2026-08-10T00:00:00.000Z', deleted_at: null },
];

const posts = {
  p1: { id: 'p1', binder_id: 'b1', body_markdown: '검토 부탁드립니다', created_at: NOW, deleted_at: null },
  p2: { id: 'p2', binder_id: 'b2', body_markdown: '검토 부탁드립니다(남의 바인더)', created_at: NOW, deleted_at: null },
};

// 섹션 4종: 공개(sPub)·비공개(sPriv, member1이 section_members)·비공개(sPrivOther, member1은
// 접근 권한 없음)·소프트 삭제된 공개 섹션(sDeleted, 135가 고친 지점).
const sections = {
  sPub: { id: 'sPub', binder_id: 'b1', access_scope: 0, deleted_at: null },
  sPriv: { id: 'sPriv', binder_id: 'b1', access_scope: 1, deleted_at: null },
  sPrivOther: { id: 'sPrivOther', binder_id: 'b1', access_scope: 1, deleted_at: null },
  sDeleted: { id: 'sDeleted', binder_id: 'b1', access_scope: 0, deleted_at: NOW },
};
const sectionMembers = new Set(['sPriv:member1']); // member1은 sPriv에만 명시 접근 부여

const messages = [
  { id: 'm1', section_id: 'sPub', content: '검토 완료했습니다', created_at: NOW, deleted_at: null },
  { id: 'm2', section_id: 'sPriv', content: '검토 중입니다(비공개, 접근 있음)', created_at: NOW, deleted_at: null },
  { id: 'm3', section_id: 'sPrivOther', content: '검토 극비(비공개, 접근 없음)', created_at: NOW, deleted_at: null },
  { id: 'm4', section_id: 'sDeleted', content: '검토 이력(삭제된 섹션)', created_at: NOW, deleted_at: null },
];

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // BinderDAO.getMember
  if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
    return { rows: binderMembers[`${params[0]}:${params[1]}`] ? [binderMembers[`${params[0]}:${params[1]}`]] : [] };
  }

  // search — events
  if (s.includes('ei.summary ILIKE $2')) {
    const [binderId, pattern, limit] = params;
    const re = new RegExp(pattern.replace(/%/g, ''), 'i');
    const rows = eventInstances.filter((r) => !r.deleted_at && calendars[events[r.event_id].calendar_id]?.binder_id === binderId && re.test(r.summary)).slice(0, limit);
    return { rows };
  }
  // search — tasks
  if (s.includes('ti.summary ILIKE $2')) {
    const [binderId, pattern, limit] = params;
    const re = new RegExp(pattern.replace(/%/g, ''), 'i');
    const rows = taskInstances.filter((r) => !r.deleted_at && calendars[tasks[r.task_id].calendar_id]?.binder_id === binderId && re.test(r.summary)).slice(0, limit);
    return { rows };
  }
  // search — posts
  if (s.includes('p.body_markdown ILIKE $2')) {
    const [binderId, pattern, limit] = params;
    const re = new RegExp(pattern.replace(/%/g, ''), 'i');
    const rows = Object.values(posts).filter((r) => !r.deleted_at && r.binder_id === binderId && re.test(r.body_markdown)).slice(0, limit);
    return { rows };
  }
  // search — special_days(신규)
  if (s.includes('sd.name ILIKE $2')) {
    const [binderId, pattern, limit] = params;
    const re = new RegExp(pattern.replace(/%/g, ''), 'i');
    const rows = specialDays.filter((r) => !r.deleted_at && calendars[r.calendar_id]?.binder_id === binderId && re.test(r.name)).slice(0, limit);
    return { rows };
  }
  // search — casts(신규)
  if (s.includes('ca.title ILIKE $2')) {
    const [binderId, pattern, limit] = params;
    const re = new RegExp(pattern.replace(/%/g, ''), 'i');
    const rows = casts.filter((r) => !r.deleted_at && calendars[r.calendar_id]?.binder_id === binderId && (re.test(r.title) || (r.summary && re.test(r.summary)))).slice(0, limit);
    return { rows };
  }
  // search — messages(135가 s.deleted_at IS NULL을 추가한 분기)
  // ⚠️ 이 필터를 mock이 실제 SQL 텍스트와 무관하게 항상 적용하면, 서버 코드에서 그 조건을
  // 빼도 이 mock은 여전히 걸러내 회귀를 못 잡는다(처음 이 파일을 작성했을 때 실제로 그랬다 —
  // 수정 전 코드로 되돌려 돌렸는데도 통과해버려서 발견). 그래서 `s.deleted_at IS NULL`이
  // **쿼리 문자열에 실제로 있을 때만** 그 필터를 적용하도록 바꿨다 — mock이 SQL 자체를 반영해야
  // "고친 걸 실수로 되돌리면 이 테스트가 잡는다"가 성립한다.
  if (s.includes('m.content ILIKE $2')) {
    const [binderId, pattern, userId, limit] = params;
    const re = new RegExp(pattern.replace(/%/g, ''), 'i');
    const checksSectionSoftDelete = s.includes('s.deleted_at IS NULL');
    const rows = messages.filter((m) => {
      if (m.deleted_at || !re.test(m.content)) return false;
      const section = sections[m.section_id];
      if (!section || section.binder_id !== binderId) return false;
      if (checksSectionSoftDelete && section.deleted_at) return false;
      if (section.access_scope === 0) return true;
      return sectionMembers.has(`${section.id}:${userId}`);
    }).slice(0, limit);
    return { rows };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { BinderService } = require('./binderService');

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond, detail) { if (cond) pass++; else { fail++; failures.push(detail ? `${desc}: ${detail}` : desc); } }

async function expectStatus(desc, fn, expectedStatus) {
  try {
    await fn();
    fail++;
    failures.push(`${desc}: 예상 ${expectedStatus} — 통과해버림(에러 없음)`);
  } catch (err) {
    if (err.statusCode === expectedStatus) pass++;
    else { fail++; failures.push(`${desc}: 예상 ${expectedStatus}, 실제 ${err.statusCode || '(non-AppError) ' + err.message}`); }
  }
}

async function run() {
  // ============ 비멤버 차단(기존 회귀도 있지만 이 파일에서도 대조군으로 확인) ============
  await expectStatus('search 비멤버 차단', () => BinderService.search('b1', { q: '검토' }, 'outsider'), 403);

  // ============ 신규 2종(special_days·casts) — 같은 binder 보임 / 다른 binder 안 보임 ============
  {
    const result = await BinderService.search('b1', { q: '검토', type: 'special_days' }, 'member1');
    const ids = result.special_days.map((r) => r.id);
    check('special_days — 같은 binder(sd1)는 검색됨', ids.includes('sd1'), `실제=${JSON.stringify(ids)}`);
    check('special_days — 다른 binder(sd2)는 검색 안 됨', !ids.includes('sd2'), `실제=${JSON.stringify(ids)}`);
  }
  {
    const result = await BinderService.search('b1', { q: '검토', type: 'casts' }, 'member1');
    const ids = result.casts.map((r) => r.id);
    check('casts — 같은 binder(ca1)는 검색됨', ids.includes('ca1'), `실제=${JSON.stringify(ids)}`);
    check('casts — 다른 binder(ca2)는 검색 안 됨', !ids.includes('ca2'), `실제=${JSON.stringify(ids)}`);
  }

  // ============ type 생략(기본값) — 신규 2종도 기본으로 포함됐다 ============
  {
    const result = await BinderService.search('b1', { q: '검토' }, 'member1');
    check('type 생략 — special_days가 기본 응답에 포함', Array.isArray(result.special_days));
    check('type 생략 — casts가 기본 응답에 포함', Array.isArray(result.casts));
    check('type 생략 — 기존 4종도 여전히 포함(회귀 없음)', Array.isArray(result.events) && Array.isArray(result.tasks) && Array.isArray(result.posts) && Array.isArray(result.messages));
  }

  // ============ 기존 4종 회귀 없음 — events·tasks·posts 대조 ============
  {
    const result = await BinderService.search('b1', { q: '검토', type: 'events' }, 'member1');
    check('events — 같은 binder만', result.events.map((r) => r.id).includes('ei1') && !result.events.map((r) => r.id).includes('ei2'));
  }
  {
    const result = await BinderService.search('b1', { q: '검토', type: 'tasks' }, 'member1');
    check('tasks — 같은 binder만', result.tasks.map((r) => r.id).includes('ti1') && !result.tasks.map((r) => r.id).includes('ti2'));
  }
  {
    const result = await BinderService.search('b1', { q: '검토', type: 'posts' }, 'member1');
    check('posts — 같은 binder만', result.posts.map((r) => r.id).includes('p1') && !result.posts.map((r) => r.id).includes('p2'));
  }

  // ============ messages — 공개 섹션은 보임, 접근 있는 비공개는 보임, 접근 없는 비공개는
  // 안 보임(팀리드가 우려한 access_scope·section_members 경계 — 이미 정확했음을 확인) ============
  {
    const result = await BinderService.search('b1', { q: '검토', type: 'messages' }, 'member1');
    const ids = result.messages.map((r) => r.id);
    check('messages — 공개 섹션(m1)은 보임', ids.includes('m1'), `실제=${JSON.stringify(ids)}`);
    check('messages — 접근 있는 비공개 섹션(m2)은 보임', ids.includes('m2'), `실제=${JSON.stringify(ids)}`);
    check('messages — 접근 없는 비공개 섹션(m3)은 안 보임(내용 유출 없음)', !ids.includes('m3'), `실제=${JSON.stringify(ids)}`);
    // ⚠️ 135가 고친 지점 — 수정 전엔 s.deleted_at 필터가 없어 m4가 검색됐다(아래 "수정 전 재현" 참조).
    check('messages — 소프트 삭제된 섹션(m4)은 안 보임(135 수리)', !ids.includes('m4'), `실제=${JSON.stringify(ids)}`);
  }

  console.log(`\n[binderSearchAuthzRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[binderSearchAuthzRegression] 실행 실패:', error);
  process.exitCode = 1;
});
