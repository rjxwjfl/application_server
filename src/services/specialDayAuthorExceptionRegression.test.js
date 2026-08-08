/**
 * src/services/specialDayAuthorExceptionRegression.test.js
 * =========================================
 * RLY-20260806-114 ② — specialDayService.update/delete가 api.md:1173("작성자 + Binder
 * editor 이상")의 **작성자 예외**를 구현하지 않고 role만(`role > 2`) 확인했다 — 본인이 만든
 * 기념일이라도 role<=2(editor+)가 아니면 수정·삭제할 수 없었다. 이건 보안 구멍이 아니라
 * **정당한 사용자가 막히는 과잉 제한**이다(107·111의 "과잉 허용"과 반대 방향).
 *
 * `special_days.author_id`(schema.sql, NOT NULL) 컬럼이 실제로 존재함을 확인한 뒤,
 * eventService·taskService의 기존 `assertCanEditItem`(작성자는 role 무관 통과) 패턴을
 * specialDayService에도 옮겼다.
 *
 * ⚠️ 권한을 넓히는 변경(과잉 제한 해소)이지만 **비작성자·role<=2 미만은 여전히 차단**돼야
 * 한다 — 대조군을 함께 넣는다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`, require.cache로 config/db를
 * 가짜 connection으로 교체해 실제 서비스 코드를 그대로 구동한다.
 *
 * 실행: node src/services/specialDayAuthorExceptionRegression.test.js
 */


const dbPath = require.resolve('../../config/db');
const NOW = new Date('2026-08-07T00:00:00Z').toISOString();

function freshDb() {
  return {
    calendars: { cal1: { id: 'cal1', binder_id: 'b1', title: 'Cal', description: null, color: 0, is_public: false, created_at: NOW, updated_at: NOW, deleted_at: null } },
    // role: 0=master 1=manager 2=editor 3=member
    binderMembers: {
      'b1:editor1': { binder_id: 'b1', user_id: 'editor1', role: 2, deleted_at: null },
      'b1:author1': { binder_id: 'b1', user_id: 'author1', role: 3, deleted_at: null }, // 기념일 작성자, binder role은 일반 member
      'b1:other1': { binder_id: 'b1', user_id: 'other1', role: 3, deleted_at: null },   // 비작성자·member
    },
    userSettings: {}, // resolveOwnerTimezone — 없으면 'UTC' 폴백(기존 동작)
    specialDays: {},
    reminderDeletes: [],
  };
}

function addSpecialDay(db, id, authorId) {
  db.specialDays[id] = {
    id, calendar_id: 'cal1', author_id: authorId, name: 'D-Day', base_date: '2026-12-25',
    r_rule: null, is_lunar: false, lunar_month: null, lunar_day: null, lunar_is_leap_month: null,
    show_dday: true, count_from_one: true, show_every_day: false, sticker: null, color: null,
    reminder_offsets: null, created_at: NOW, updated_at: NOW, deleted_at: null,
  };
  return db.specialDays[id];
}

function makeMockDb(db) {
  async function mockQuery(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

    // SpecialDayDAO.findById
    if (s.startsWith('SELECT * FROM special_days WHERE id = $1')) {
      const row = db.specialDays[params[0]];
      return { rows: row && !row.deleted_at ? [row] : [] };
    }

    // CalendarDAO.findById
    if (s.startsWith('SELECT id, binder_id, title, description, color, is_public')) {
      const row = db.calendars[params[0]];
      return { rows: row ? [row] : [] };
    }

    // BinderDAO.getMember
    if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
      const row = db.binderMembers[`${params[0]}:${params[1]}`];
      return { rows: row ? [row] : [] };
    }

    // resolveOwnerTimezone
    if (s.startsWith('SELECT timezone FROM user_settings')) {
      const tz = db.userSettings[params[0]];
      return { rows: tz ? [{ timezone: tz }] : [] };
    }

    // SpecialDayDAO.update
    if (s.startsWith('UPDATE special_days') && s.includes('SET name')) {
      const id = params[params.length - 1];
      const row = db.specialDays[id];
      if (row) row.updated_at = new Date();
      return { rows: row ? [row] : [] };
    }

    // SpecialDayDAO.softDelete
    if (s.startsWith('UPDATE special_days SET deleted_at')) {
      const row = db.specialDays[params[0]];
      if (row) row.deleted_at = new Date();
      return { rows: [] };
    }

    // ReminderDAO.syncTarget(offsets=null → DELETE 분기) / deleteByTarget — 같은 문 형태
    if (s.startsWith('DELETE FROM reminders')) {
      db.reminderDeletes.push(params[1]);
      return { rows: [] };
    }

    throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
  }
  return { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
}

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond) { if (cond) pass++; else { fail++; failures.push(desc); } }
async function expectOk(desc, fn) { try { await fn(); pass++; } catch (err) { fail++; failures.push(`${desc}: 정상 기대했지만 에러 — ${err.statusCode || ''} ${err.message}`); } }
async function expectBlocked(desc, fn) {
  try { await fn(); fail++; failures.push(`${desc}: 차단을 기대했지만 통과해버림`); }
  catch (err) { if (err.statusCode === 403) pass++; else { fail++; failures.push(`${desc}: 403 기대, 실제 ${err.statusCode} ${err.message}`); } }
}

async function run() {
  const db = freshDb();
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: makeMockDb(db) };
  delete require.cache[require.resolve('./specialDayService')];
  const { SpecialDayService } = require('./specialDayService');

  // ============ update ============
  // ① 재현 겸 회귀 — 작성자 본인(binder role=member)이 이제 자기 기념일을 수정할 수 있다
  addSpecialDay(db, 'sd1', 'author1');
  await expectOk(
    'update ① 작성자 본인(author1, role=member)이 role 무관하게 수정할 수 있다(수정 전엔 403이었다)',
    () => SpecialDayService.update('sd1', { name: '새 이름' }, { sender_id: 'author1', device_uuid: 'd' })
  );

  // ② 대조군 — 비작성자·member는 여전히 차단된다
  addSpecialDay(db, 'sd2', 'author1');
  await expectBlocked(
    'update ② 대조군 — 비작성자 member(other1)는 여전히 차단된다',
    () => SpecialDayService.update('sd2', { name: 'x' }, { sender_id: 'other1', device_uuid: 'd' })
  );

  // ③ 대조군 — 비작성자여도 editor 이상은 수정할 수 있다(기존 동작 불변)
  await expectOk(
    'update ③ 대조군 — 비작성자여도 editor(role=2)는 수정할 수 있다',
    () => SpecialDayService.update('sd2', { name: 'x' }, { sender_id: 'editor1', device_uuid: 'd' })
  );

  // ============ delete ============
  addSpecialDay(db, 'sd3', 'author1');
  await expectOk(
    'delete ① 작성자 본인은 role 무관하게 삭제할 수 있다',
    () => SpecialDayService.delete('sd3', { sender_id: 'author1', device_uuid: 'd' })
  );
  check('delete ① 실제로 삭제됨', db.specialDays['sd3'].deleted_at !== null);

  addSpecialDay(db, 'sd4', 'author1');
  await expectBlocked(
    'delete ② 대조군 — 비작성자 member는 여전히 차단된다',
    () => SpecialDayService.delete('sd4', { sender_id: 'other1', device_uuid: 'd' })
  );
  check('delete ② 차단 후 실제로 안 지워짐', db.specialDays['sd4'].deleted_at === null);

  await expectOk(
    'delete ③ 대조군 — 비작성자여도 editor는 삭제할 수 있다',
    () => SpecialDayService.delete('sd4', { sender_id: 'editor1', device_uuid: 'd' })
  );

  console.log(`\n[specialDayAuthorExceptionRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[specialDayAuthorExceptionRegression] 실행 실패:', error);
  process.exitCode = 1;
});
