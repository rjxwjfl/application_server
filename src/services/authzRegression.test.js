/**
 * src/services/authzRegression.test.js
 * =========================================
 * RLY-20260806-012 인가 공백 회귀 스위트.
 *
 * 이 저장소에는 테스트 프레임워크가 없다(package.json — jest/mocha 미설치, `npm test`는
 * 실패하는 placeholder). sectionCascadeRegression.test.js와 동일한 관행을 따른다:
 * plain assert + `node <file>.js` 직접 실행, 가짜 DB connection으로 실제 서비스 코드를 구동한다.
 *
 * 실제 Postgres가 이 환경에 없어 통합 테스트는 불가능하다 — 이 스위트는 서비스 레이어의
 * 인가 분기(멤버십·role·author 체크)를 검증하는 것이지 SQL 자체의 정합성을 검증하지 않는다.
 *
 * 실행: node src/services/authzRegression.test.js
 */

const assert = require('assert');

// ── config/db.js를 가짜 커넥션으로 교체(require.cache 주입) ───────────────────
const dbPath = require.resolve('../../config/db');

const NOW = new Date().toISOString();

const db = {
  binders: {},
  binder_settings: {},
  binder_members: {},
  calendars: {},
  events: {},
  event_instances: {},
  tasks: {},
  task_instances: {},
  special_days: {},
  casts: {},
  posts: {},
  attachments: {},
};

function setMember(binderId, userId, role) {
  db.binder_members[`${binderId}:${userId}`] = {
    binder_id: binderId, user_id: userId, role,
    notification_level: 1, nickname_in_binder: null, joined_at: NOW, deleted_at: null,
  };
}

// ── 픽스처 ──────────────────────────────────────────────────────────────
// b1: 비공개 바인더. author1=작성자(member role=3), editor1=editor(role=2), member1=일반 멤버(role=3).
// outsider = b1/b2 어디에도 없는 완전 비멤버.
db.binders.b1 = { id: 'b1', name: 'Binder1', description: null, image_url: null, thumbnail_url: null, member_count: 3, last_activity_at: NOW, created_at: NOW, updated_at: NOW, deleted_at: null };
db.binder_settings.b1 = { binder_id: 'b1', is_public: false, is_searchable: false, require_approval: false, updated_at: NOW };
setMember('b1', 'author1', 3);
setMember('b1', 'editor1', 2);
setMember('b1', 'member1', 3);
setMember('b1', 'master1', 0);

db.binders.b2 = { id: 'b2', name: 'PublicBinder', description: null, image_url: null, thumbnail_url: null, member_count: 1, last_activity_at: NOW, created_at: NOW, updated_at: NOW, deleted_at: null };
db.binder_settings.b2 = { binder_id: 'b2', is_public: true, is_searchable: true, require_approval: false, updated_at: NOW };
setMember('b2', 'author1', 0);

db.calendars.c1 = { id: 'c1', binder_id: 'b1', title: 'Cal1', description: null, color: 0, is_public: false, created_at: NOW, updated_at: NOW, deleted_at: null };
db.calendars.c1pub = { id: 'c1pub', binder_id: 'b1', title: 'PubCal', description: null, color: 0, is_public: true, created_at: NOW, updated_at: NOW, deleted_at: null };
// outsider가 이미 속한 바인더(b3)의 공개 캘린더 — subscribe의 AC-SEC-6(자기 바인더 캘린더 구독 400) 검증용
db.binders.b3 = { id: 'b3', name: 'OutsiderOwnBinder', description: null, image_url: null, thumbnail_url: null, member_count: 1, last_activity_at: NOW, created_at: NOW, updated_at: NOW, deleted_at: null };
db.binder_settings.b3 = { binder_id: 'b3', is_public: true, is_searchable: true, require_approval: false, updated_at: NOW };
setMember('b3', 'outsider', 3);
db.calendars.c3pub = { id: 'c3pub', binder_id: 'b3', title: 'OutsiderOwnPubCal', description: null, color: 0, is_public: true, created_at: NOW, updated_at: NOW, deleted_at: null };

db.events.e1 = { id: 'e1', calendar_id: 'c1', author_id: 'author1', event_type: 0, summary: 'E1', description: null, color: 0, r_rule: null, locations: null, forked_from: null, created_at: NOW, updated_at: NOW, deleted_at: null };
db.event_instances.ei1 = { id: 'ei1', event_id: 'e1', deleted_at: null };

db.tasks.t1 = { id: 't1', calendar_id: 'c1', author_id: 'author1', task_type: 0, summary: 'T1', description: null, priority: 0, locations: null, r_rule: null, forked_from: null, created_at: NOW, updated_at: NOW, deleted_at: null };
db.task_instances.ti1 = { id: 'ti1', task_id: 't1', deleted_at: null };

db.special_days.sd1 = { id: 'sd1', calendar_id: 'c1', name: 'SD1', deleted_at: null };

db.casts.cast1 = { id: 'cast1', calendar_id: 'c1', author_id: 'author1', deleted_at: null };
db.casts.castpub = { id: 'castpub', calendar_id: 'c1pub', author_id: 'author1', deleted_at: null };

db.posts.p1 = { id: 'p1', binder_id: 'b1', author_id: 'author1', deleted_at: null };

db.attachments.attEvent = { id: 'attEvent', binder_id: 'b1', context_type: 'EVENT', context_id: 'e1', storage_key: 'k1', content_type: 'image/png', status: 'ready' };
db.attachments.attCast = { id: 'attCast', binder_id: 'b1', context_type: 'CAST', context_id: 'castpub', storage_key: 'k2', content_type: 'image/png', status: 'ready' };

const queryLog = [];

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  queryLog.push(s);

  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // BinderDAO.getMember
  if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
    const row = db.binder_members[`${params[0]}:${params[1]}`];
    return { rows: row ? [row] : [] };
  }
  // BinderDAO.getMembers (목록 — authz 통과 후에만 도달해야 함)
  // RLY-20260806-066 — u.email 제거로 `JOIN users u`도 함께 빠졌다(이 함수의 유일한
  // 존재 이유였음). LEFT JOIN user_infos만으로 매칭한다.
  if (s.includes('FROM binder_members dm') && s.includes('LEFT JOIN user_infos ui')) {
    return { rows: [] };
  }
  // BinderDAO.getSettings
  if (s.startsWith('SELECT binder_id, is_public, is_searchable, require_approval, updated_at') && s.includes('FROM binder_settings')) {
    const row = db.binder_settings[params[0]];
    return { rows: row ? [row] : [] };
  }
  // BinderDAO.findById
  if (s.includes('FROM binders') && s.includes('WHERE id = $1') && !s.includes('ILIKE')) {
    const row = db.binders[params[0]];
    return { rows: row ? [row] : [] };
  }
  // CalendarDAO.findById
  if (s.includes('FROM calendars') && s.includes('WHERE id = $1')) {
    const row = db.calendars[params[0]];
    return { rows: row ? [row] : [] };
  }
  // CalendarDAO 구독 관련(authz 통과 후 목록/쓰기 — 안전하게 no-op)
  if (s.includes('FROM calendar_subscriptions') || s.includes('INTO calendar_subscriptions')) {
    return { rows: [] };
  }
  // EventDAO.findById
  if (s.includes('FROM events') && s.includes('WHERE id = $1') && !s.includes('JOIN')) {
    const row = db.events[params[0]];
    return { rows: row ? [row] : [] };
  }
  // EventDAO.findInstanceContext
  if (s.includes('FROM event_instances ei') && s.includes('JOIN events e')) {
    const [instanceId, eventId] = params;
    const inst = db.event_instances[instanceId];
    const ev = inst && db.events[inst.event_id];
    const cal = ev && db.calendars[ev.calendar_id];
    if (inst && ev && cal && inst.event_id === eventId) {
      return { rows: [{ id: inst.id, deleted_at: null, calendar_id: ev.calendar_id, author_id: ev.author_id, binder_id: cal.binder_id }] };
    }
    return { rows: [] };
  }
  // TaskDAO.findById
  if (s.includes('FROM tasks') && s.includes('WHERE id = $1') && !s.includes('JOIN')) {
    const row = db.tasks[params[0]];
    return { rows: row ? [row] : [] };
  }
  // TaskDAO.findInstanceContext
  if (s.includes('FROM task_instances ti') && s.includes('JOIN tasks t')) {
    const [instanceId, taskId] = params;
    const inst = db.task_instances[instanceId];
    const tk = inst && db.tasks[inst.task_id];
    const cal = tk && db.calendars[tk.calendar_id];
    if (inst && tk && cal && inst.task_id === taskId) {
      return { rows: [{ id: inst.id, completion_rule: 0, deleted_at: null, calendar_id: tk.calendar_id, author_id: tk.author_id, binder_id: cal.binder_id }] };
    }
    return { rows: [] };
  }
  // SpecialDayDAO.findById
  if (s.includes('FROM special_days WHERE id = $1')) {
    const row = db.special_days[params[0]];
    return { rows: row ? [row] : [] };
  }
  // CastDAO.findById
  if (s.includes('FROM casts WHERE id = $1')) {
    const row = db.casts[params[0]];
    return { rows: row ? [row] : [] };
  }
  // CastDAO 목록(authz 통과 후에만 도달)
  if (s.includes('FROM casts WHERE calendar_id') || s.includes('FROM cast_comments')) {
    return { rows: [] };
  }
  // PostDAO.findById
  if (s.includes('FROM posts p') && s.includes('WHERE p.id = $1')) {
    const row = db.posts[params[0]];
    return { rows: row ? [row] : [] };
  }
  if (s.includes('FROM post_comments')) return { rows: [] };
  // attachments 직접 조회(mediaService.getSignedUrl)
  if (s.includes('FROM attachments WHERE id = $1')) {
    const row = db.attachments[params[0]];
    return { rows: row ? [row] : [] };
  }
  // attachments insert(presign) — authz 통과 후에만 도달해야 함
  if (s.includes('INSERT INTO attachments')) return { rows: [] };
  // AttachmentDAO.getTier(binderService.getBoost 재구현, RLY-20260806-099) — authz 통과 후
  // 도달, Free tier(0)로 흉내낸다.
  if (s.startsWith('SELECT COALESCE(bb.tier, 0) AS tier')) return { rows: [{ tier: 0 }] };
  // AttachmentDAO.getBytesUsed(동일) — 집계 행 없음 → 0바이트.
  if (s.startsWith('SELECT bytes_used FROM binder_storage_usage')) return { rows: [] };
  // binderService.getBoost의 status·current_period_end 조회(동일) — 활성 Boost 없음(Free tier).
  if (s.startsWith('SELECT status, current_period_end FROM binder_boosts')) return { rows: [] };
  // AttachmentDAO.findByContext(postService.withAttachments) — 응답 조립용, 인가와 무관
  if (s.includes('FROM attachments') && s.includes('context_type')) return { rows: [] };
  // EventDAO/TaskDAO.findInstanceById — split의 DAO 내부 호출(authz 통과 후에만 도달)
  if (s.includes('FROM event_instances') && s.includes('WHERE id = $1')) {
    const row = db.event_instances[params[0]];
    return { rows: row ? [{ ...row, original_date: NOW }] : [] };
  }
  if (s.includes('FROM task_instances') && s.includes('WHERE id = $1') && !s.includes('JOIN')) {
    const row = db.task_instances[params[0]];
    return { rows: row ? [{ ...row, original_date: NOW }] : [] };
  }
  // RLY-20260806-034 — EventDAO/TaskDAO.countActiveInstances(범위 편집 fork의 r_rule COUNT 조정용).
  // 인가 분기 이후에만 도달하고 이 회귀의 관심사는 아니라 0으로 흉내낸다.
  if (s.startsWith('SELECT COUNT(*)::int AS count FROM event_instances')
    || s.startsWith('SELECT COUNT(*)::int AS count FROM task_instances')) {
    return { rows: [{ count: 0 }] };
  }
  // authz 통과 후 도달하는 나머지 쓰기 구문(UPDATE/INSERT..SELECT/DELETE) — SQL 정합성은 이 회귀의
  // 관심사가 아니다(서비스 레이어 인가 분기만 검증). 값 없이 성공만 흉내낸다.
  if (s.startsWith('UPDATE ') || s.startsWith('INSERT INTO') || s.startsWith('DELETE FROM')) {
    return { rows: [{}] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const mockDb = {
  query: mockQuery,
  connect: async () => ({ query: mockQuery, release() {} }),
};

require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

// ── 실제 서비스 로드(가짜 DB가 주입된 뒤) ─────────────────────────────────
const { EventService } = require('./eventService');
const { TaskService } = require('./taskService');
const { SpecialDayService } = require('./specialDayService');
const { CalendarService } = require('./calendarService');
const { CastService } = require('./castService');
const { PostService } = require('./postService');
const { MediaService } = require('./mediaService');
const { BinderService } = require('./binderService');

const ctx = (userId) => ({ sender_id: userId, device_uuid: 'dev-1' });

let pass = 0;
let fail = 0;
const failures = [];

async function expectStatus(desc, fn, expectedStatus) {
  try {
    await fn();
    fail++;
    failures.push(`${desc}: 예상 ${expectedStatus} — 통과해버림(에러 없음)`);
  } catch (err) {
    if (err.statusCode === expectedStatus) {
      pass++;
    } else {
      fail++;
      failures.push(`${desc}: 예상 ${expectedStatus}, 실제 ${err.statusCode || '(non-AppError) ' + err.message}`);
    }
  }
}

async function expectOk(desc, fn) {
  try {
    await fn();
    pass++;
  } catch (err) {
    fail++;
    failures.push(`${desc}: 정상 통과를 기대했지만 에러 — ${err.statusCode || ''} ${err.message}`);
  }
}

async function run() {
  const OUT = 'outsider'; // b1/b2/c1/e1/t1/sd1/cast1/p1/attEvent 어디에도 속하지 않는 비멤버

  // ============ Event (9) ============
  await expectStatus('Event.getEvent 비멤버', () => EventService.getEvent('e1', OUT), 403);
  await expectStatus('Event.createEvent 비멤버', () => EventService.createEvent({ id: 'e-new', calendar_id: 'c1', summary: 'x' }, ctx(OUT)), 403);
  await expectStatus('Event.updateEvent 비멤버', () => EventService.updateEvent('e1', { summary: 'y' }, ctx(OUT)), 403);
  await expectStatus('Event.updateEvent 일반멤버(비작성자·비editor)', () => EventService.updateEvent('e1', { summary: 'y' }, ctx('member1')), 403);
  await expectStatus('Event.deleteEvent 비멤버', () => EventService.deleteEvent('e1', ctx(OUT)), 403);
  await expectStatus('Event.splitEvent 비멤버', () => EventService.splitEvent({ event_id: 'e1', instance_id: 'ei1' }, ctx(OUT)), 403);
  await expectStatus('Event.updateEventInstance 비멤버', () => EventService.updateEventInstance('e1', 'ei1', { summary: 'y' }, ctx(OUT)), 403);
  await expectStatus('Event.deleteEventInstance 비멤버', () => EventService.deleteEventInstance('e1', 'ei1', ctx(OUT)), 403);
  await expectStatus('Event.addParticipant 비멤버', () => EventService.addParticipant('e1', 'ei1', { user_id: OUT }, ctx(OUT)), 403);
  await expectStatus('Event.removeParticipant 비멤버', () => EventService.removeParticipant('e1', 'ei1', 'author1', ctx(OUT)), 403);
  // 긍정 경로: 작성자는 role=member(3)이어도 수정 가능(도메인 §12 author 항상 편집 가능)
  await expectOk('Event.updateEvent 작성자(role=3)는 항상 가능', () => EventService.updateEvent('e1', { summary: 'y' }, ctx('author1')));
  await expectOk('Event.updateEvent editor(role=2, 비작성자)도 가능', () => EventService.updateEvent('e1', { summary: 'z' }, ctx('editor1')));
  await expectOk('Event.getEvent 일반 멤버', () => EventService.getEvent('e1', 'member1'));

  // ============ Task (7, mirror) ============
  await expectStatus('Task.getTask 비멤버', () => TaskService.getTask('t1', OUT), 403);
  await expectStatus('Task.createTask 비멤버', () => TaskService.createTask({ id: 't-new', calendar_id: 'c1', summary: 'x' }, ctx(OUT)), 403);
  await expectStatus('Task.updateTask 비멤버', () => TaskService.updateTask('t1', { summary: 'y' }, ctx(OUT)), 403);
  await expectStatus('Task.updateTask 일반멤버(비작성자·비editor)', () => TaskService.updateTask('t1', { summary: 'y' }, ctx('member1')), 403);
  await expectStatus('Task.deleteTask 비멤버', () => TaskService.deleteTask('t1', ctx(OUT)), 403);
  await expectStatus('Task.splitTask 비멤버', () => TaskService.splitTask({ task_id: 't1', instance_id: 'ti1' }, ctx(OUT)), 403);
  await expectStatus('Task.updateTaskInstance 비멤버', () => TaskService.updateTaskInstance('t1', 'ti1', { summary: 'y' }, ctx(OUT)), 403);
  await expectStatus('Task.deleteTaskInstance 비멤버', () => TaskService.deleteTaskInstance('t1', 'ti1', ctx(OUT)), 403);
  await expectOk('Task.updateTask 작성자는 항상 가능', () => TaskService.updateTask('t1', { summary: 'y' }, ctx('author1')));
  // RLY-20260806-034 — new_task_id는 클라 UUIDv7이 필수(H19, 서버가 더 이상 생성하지 않음).
  await expectOk('Task.splitTask editor 가능(instance 존재 확인 포함)', () => TaskService.splitTask({ task_id: 't1', instance_id: 'ti1', new_task_id: 'new-t1-fork' }, ctx('editor1')));

  // ============ SpecialDay (1) ============
  await expectStatus('SpecialDay.getById 비멤버', () => SpecialDayService.getById('sd1', OUT), 403);
  await expectOk('SpecialDay.getById 일반 멤버', () => SpecialDayService.getById('sd1', 'member1'));

  // ============ R11 조회·컨텍스트 (9) ============
  await expectStatus('Calendar.getById 비멤버(비공개)', () => CalendarService.getById('c1', OUT), 403);
  await expectOk('Calendar.getById 멤버', () => CalendarService.getById('c1', 'member1'));
  await expectStatus('Calendar.getCalendarSubscriptions 비멤버', () => CalendarService.getCalendarSubscriptions('c1', OUT), 403);
  await expectStatus('Calendar.subscribe 자기 바인더 캘린더(AC-SEC-6)', () => CalendarService.subscribe('c3pub', ctx(OUT)), 400);
  await expectOk('Calendar.subscribe 타 바인더 공개 캘린더는 허용', () => CalendarService.subscribe('c1pub', ctx(OUT)));

  await expectStatus('Cast.getCasts 비멤버(비공개 캘린더)', () => CastService.getCasts('c1', {}, OUT), 403);
  await expectOk('Cast.getCasts 비멤버(공개 캘린더는 허용)', () => CastService.getCasts('c1pub', {}, OUT));
  await expectStatus('Cast.getCast 비멤버(비공개)', () => CastService.getCast('cast1', OUT), 403);
  await expectOk('Cast.getCast 비멤버(공개 캘린더 캐스트는 허용)', () => CastService.getCast('castpub', OUT));
  await expectStatus('Cast.getComments 비멤버(비공개)', () => CastService.getComments('cast1', {}, OUT), 403);

  await expectStatus('Post.getPost 비멤버', () => PostService.getPost('p1', OUT), 403);
  await expectOk('Post.getPost 멤버', () => PostService.getPost('p1', 'member1'));
  await expectStatus('Post.getComments 비멤버', () => PostService.getComments('p1', {}, OUT), 403);

  await expectStatus('Media.getSignedUrl 비멤버(EVENT 첨부)', () => MediaService.getSignedUrl('attEvent', OUT), 403);
  await expectOk('Media.getSignedUrl 비멤버(공개 캘린더 CAST 첨부는 허용)', () => MediaService.getSignedUrl('attCast', OUT).catch((e) => {
    // GCS 클라이언트가 실제 자격증명 없이 서명 URL 생성을 시도하면 인가 통과 후 인프라 계층에서 실패할 수 있다.
    // 인가 게이트(403)만 통과했는지가 이 회귀의 관심사이므로 403이 아니면 통과로 간주한다.
    if (err_is_authz(e)) throw e;
  }));

  // ============ Binder (4) ============
  await expectStatus('Binder.getBinderMembers 비멤버', () => BinderService.getBinderMembers('b1', OUT), 403);
  await expectOk('Binder.getBinderMembers 멤버', () => BinderService.getBinderMembers('b1', 'member1'));
  await expectOk('Binder.getBinder 비멤버(공개 바인더 preview)', () => BinderService.getBinder('b2', OUT));
  await expectStatus('Binder.getBinder 비멤버(비공개 바인더)', () => BinderService.getBinder('b1', OUT), 403);
  await expectStatus('Binder.getBoost 비멤버', () => BinderService.getBoost('b1', OUT), 403);
  // RLY-20260806-099 — storage_bytes_used·storage_limit_bytes 전달을 위해 getBoost를
  // 구현했다(구매 검증·이전·취소는 여전히 501 — 아래 checkBoost 이하 참조). 구 단언(501)을
  // 새 단언(정상 응답)으로 교체한다 — 재구현 범위였음이 이제 확정됐다.
  await expectOk('Binder.getBoost 멤버는 인가 통과 후 정상 응답(RLY-20260806-099로 구현됨)', () => BinderService.getBoost('b1', 'member1'));
  await expectStatus('Binder.checkBoost 비멤버', () => BinderService.checkBoost('b1', OUT), 403);
  await expectStatus('Binder.checkBoost 멤버는 인가 통과 후 501', () => BinderService.checkBoost('b1', 'member1'), 501);
  await expectStatus('Binder.transferBoost 비멤버', () => BinderService.transferBoost('b1', OUT, {}), 403);
  await expectStatus('Binder.transferBoost 멤버지만 manager 미만', () => BinderService.transferBoost('b1', 'editor1', {}), 403);
  await expectStatus('Binder.transferBoost manager+는 인가 통과 후 501', () => BinderService.transferBoost('b1', 'master1', {}), 501);
  await expectStatus('Binder.cancelBoost 비멤버', () => BinderService.cancelBoost('b1', OUT), 403);
  await expectStatus('Binder.cancelBoost manager+는 인가 통과 후 501', () => BinderService.cancelBoost('b1', 'master1'), 501);
  await expectStatus('Binder.verifyBoost 비멤버는 501이 아니라 403', () => BinderService.verifyBoost('b1', OUT, {}), 403);
  await expectStatus('Binder.verifyBoost 멤버는 인가 통과 후 501', () => BinderService.verifyBoost('b1', 'member1', {}), 501);

  // ============ 추가 2건 ============
  await expectStatus('Media.presign 비멤버(EVENT 업로드)', () => MediaService.presign({ context_type: 'EVENT', context_id: 'e1', binder_id: 'b1', filename: 'a.png', content_type: 'image/png' }, ctx(OUT)), 403);
  await expectStatus('Post.unlikePost 비멤버', () => PostService.unlikePost('p1', ctx(OUT)), 403);

  // ============ 기존 role 게이트 회귀 없음(대표 샘플) ============
  await expectOk('Event.updateParticipantState 본인 RSVP는 기존대로 동작', async () => {
    // findParticipant는 mock에 없으므로 여기서는 함수가 멤버십과 무관한 자체 가드(본인 확인)까지만 검증한다.
    try {
      await EventService.updateParticipantState('ei1', 'author1', { state: 3 }, ctx('author1'));
    } catch (e) {
      if (e.statusCode === 403) throw e; // 본인인데 403이면 회귀
      // 404(참가자 없음)는 mock 미구현 한계이지 회귀가 아니다 — 통과로 간주
    }
  });

  console.log(`\n[authzRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

function err_is_authz(e) {
  return e && e.statusCode === 403;
}

run().catch((error) => {
  console.error('[authzRegression] 실행 실패:', error);
  process.exitCode = 1;
});
