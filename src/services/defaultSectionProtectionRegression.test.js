/**
 * src/services/defaultSectionProtectionRegression.test.js
 * =========================================
 * RLY-20260806-087 기본 섹션 삭제 차단 회귀 스위트.
 *
 * SectionDAO.create(sectionDAO.js)를 호출하는 3곳(binderService.createBinder·
 * sectionService.createSection·eventService.createEvent) 전부 INSERT에 is_default를
 * 넘기지 않아, 바인더 생성 시 자동 INSERT되는 기본 섹션조차 schema.sql의 DEFAULT FALSE로
 * is_default=false가 됐다. 그 결과 sectionService.deleteSection의 삭제 차단
 * (`if (section.is_default) throw ...`)이 항상 통과해 기본 섹션이 실제로 지워질 수 있었다.
 *
 * 이 스위트는 authzRegression.test.js와 동일 관행(가짜 DB connection, plain assert,
 * `node <file>.js` 직접 실행)을 따른다.
 *
 * 실행: node src/services/defaultSectionProtectionRegression.test.js
 */

const assert = require('assert');

const dbPath = require.resolve('../../config/db');

const NOW = new Date().toISOString();

const db = {
  binders: {},
  binder_settings: {},
  binder_members: {}, // key: `${binderId}:${userId}`
  calendars: {},
  sections: {}, // key: id
};

function setMember(binderId, userId, role) {
  db.binder_members[`${binderId}:${userId}`] = {
    binder_id: binderId, user_id: userId, role,
    notification_level: 1, nickname_in_binder: null,
    joined_at: NOW, created_at: NOW, updated_at: NOW, deleted_at: null,
  };
}

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();

  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // BinderDAO.create
  if (s.startsWith('INSERT INTO binders')) {
    const [id, name, description, image_url, thumbnail_url] = params;
    const row = {
      id, name, description, image_url, thumbnail_url, member_count: 1,
      last_activity_at: NOW, created_at: NOW, updated_at: NOW, deleted_at: null,
    };
    db.binders[id] = row;
    return { rows: [row] };
  }

  // BinderDAO.createSettings
  if (s.startsWith('INSERT INTO binder_settings')) {
    const [binderId] = params;
    const row = { binder_id: binderId, is_public: false, is_searchable: false, require_approval: false, updated_at: NOW };
    db.binder_settings[binderId] = row;
    return { rows: [row] };
  }

  // BinderDAO.addMember
  if (s.startsWith('INSERT INTO binder_members')) {
    const [binderId, userId, role] = params;
    setMember(binderId, userId, role);
    return { rows: [db.binder_members[`${binderId}:${userId}`]] };
  }

  // CalendarDAO.create
  if (s.startsWith('INSERT INTO calendars')) {
    const [id, binder_id, title] = params;
    const row = { id, binder_id, title, description: null, color: 0, is_public: false, created_at: NOW, updated_at: NOW, deleted_at: null };
    db.calendars[id] = row;
    return { rows: [row] };
  }

  // SectionDAO.create — 핵심 회귀 지점. is_default 파라미터가 실제로 INSERT 컬럼 목록에
  // 들어가고, 저장된 값이 findById에서 그대로 되읽히는지가 이 스위트의 전제다.
  if (s.startsWith('INSERT INTO sections')) {
    assert(s.includes('is_default'), 'INSERT INTO sections 쿼리에 is_default 컬럼이 없다 — 회귀');
    const [id, binder_id, title, access_scope, is_default] = params;
    const row = {
      id, binder_id, title, access_scope, is_default: !!is_default,
      created_at: NOW, updated_at: NOW, deleted_at: null,
    };
    db.sections[id] = row;
    return { rows: [row] };
  }

  // SectionDAO.findById
  if (s.startsWith('SELECT id, binder_id, title, access_scope, is_default, created_at, updated_at, deleted_at') && s.includes('FROM sections')) {
    const row = db.sections[params[0]];
    return { rows: row && !row.deleted_at ? [row] : [] };
  }

  // BinderDAO.getMember (deleteSection·createSection의 actor 조회)
  if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
    const row = db.binder_members[`${params[0]}:${params[1]}`];
    return { rows: row ? [row] : [] };
  }

  // SectionDAO.softDelete — 여러 UPDATE 문. 마지막 `UPDATE sections`만 is_default=FALSE 가드를
  // 실제로 시뮬레이션해, 서비스 레이어 차단을 우회해도 DAO 레벨 2차 방어선이 작동하는지도 함께 본다.
  if (s.startsWith('UPDATE sections SET deleted_at')) {
    const [sectionId] = params;
    const row = db.sections[sectionId];
    if (!row || row.is_default) return { rowCount: 0, rows: [] };
    row.deleted_at = NOW;
    return { rowCount: 1, rows: [] };
  }
  if (s.startsWith('UPDATE attachments') || s.startsWith('UPDATE message_embeds') || s.startsWith('UPDATE message_reactions')
    || s.startsWith('UPDATE message_mentions') || s.startsWith('UPDATE section_messages') || s.startsWith('UPDATE event_sections')
    || s.startsWith('UPDATE task_sections') || s.startsWith('UPDATE section_members')) {
    return { rowCount: 0, rows: [] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const mockDb = {
  query: mockQuery,
  connect: async () => ({ query: mockQuery, release() {} }),
};

require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { BinderService } = require('./binderService');
const { SectionService } = require('./sectionService');

let pass = 0;
let fail = 0;
const failures = [];

async function expectOk(desc, fn) {
  try {
    const result = await fn();
    pass++;
    return result;
  } catch (err) {
    fail++;
    failures.push(`${desc}: 정상 통과를 기대했지만 에러 — ${err.statusCode || ''} ${err.message}`);
    return undefined;
  }
}

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

function check(desc, condition) {
  if (condition) {
    pass++;
  } else {
    fail++;
    failures.push(`${desc}: 단언 실패`);
  }
}

const ctx = (sender_id, device_uuid = 'dev1') => ({ sender_id, device_uuid });

async function run() {
  // ① 바인더 생성 시 자동 INSERT되는 기본 섹션은 is_default=true여야 한다.
  const created = await expectOk(
    '바인더 생성',
    () => BinderService.createBinder({ name: '회사' }, 'master1', 'dev1')
  );
  check('① 기본 섹션 is_default=true', created && created.section.is_default === true);
  check('① 기본 섹션 title="기본"', created && created.section.title === '기본');
  const defaultSectionId = created && created.section.id;
  const binderId = created && created.binder.id;

  // ② 그 기본 섹션 삭제는 차단된다(BadRequestError 400) — 실제로 deleted_at도 찍히지 않는다.
  await expectStatus(
    '② 기본 섹션 삭제 시도 → 400 차단',
    () => SectionService.deleteSection(defaultSectionId, ctx('master1')),
    400
  );
  check('② 차단 후 기본 섹션은 실제로 살아있다(deleted_at 없음)', db.sections[defaultSectionId].deleted_at === null);

  // ③ 사용자가 POST /binders/{id}/sections 로 만드는 섹션은 is_default=false다.
  const userSection = await expectOk(
    '③ 사용자 생성 섹션(POST /binders/{id}/sections)',
    () => SectionService.createSection({ id: 'sec-user-1', binder_id: binderId, title: '공지' }, ctx('master1'))
  );
  check('③ 사용자 생성 섹션 is_default=false', userSection && userSection.is_default === false);

  // ④ 사용자 생성 섹션은 정상적으로 삭제된다(차단 없음).
  await expectOk(
    '④ 사용자 생성 섹션 삭제 → 정상 처리',
    () => SectionService.deleteSection('sec-user-1', ctx('master1'))
  );
  check('④ 삭제 후 deleted_at 찍힘', db.sections['sec-user-1'].deleted_at !== null);

  console.log(`\n[defaultSectionProtectionRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[defaultSectionProtectionRegression] 실행 실패:', error);
  process.exitCode = 1;
});
