/**
 * src/daos/attachmentEntityImageSchemaRegression.test.js
 * =========================================
 * RLY-20260806-080 (S1) — 아바타·커버 통합의 스키마 마이그레이션(context_type 9종 확장·
 * binder_id NOT NULL 해제·chk_att_binder_scope·chk_att_entity_target 신설·유일 인덱스
 * 미신설·레거시 값 초기화)이 media.md §3-3-1·schema.md의 계약과 실제로 일치하는지 검증한다.
 *
 * 이 저장소엔 실제 Postgres가 없어 CHECK 제약을 진짜로 평가해볼 수 없다 —
 * schemaColumnCheck.js 헤더의 "실제 Postgres가 없어 mock은 컬럼 존재를 검증 못 한다"와
 * 같은 한계다. 이 스위트는 두 층으로 나눠 검증한다:
 *
 *   § A. config/schema.sql 텍스트 대조 — allDaoSchemaColumnRegression.test.js와 동일한
 *        readSchemaSql() 재사용. "선언이 실제로 이 형태로 존재하는가"만 본다.
 *   § B. CHECK 식 논리 미러 — 세 CHECK(chk_att_context·chk_att_binder_scope·
 *        chk_att_entity_target)의 SQL 불리언 식을 JS 함수로 그대로 옮겨 적고(실제 SQL
 *        문법이 아니라 그 "의미"만 재현), 대표 행들을 통과시켜 team-lead AC①~④를 직접
 *        확인한다. 미러 함수의 로직이 실제 CHECK 식과 문자 그대로 대응하는지는 §A가
 *        간접적으로 보증한다(같은 상수·같은 컬럼명을 쓰는지 이 파일 안에서 눈으로 대조 가능).
 *
 * 이 저장소엔 테스트 프레임워크가 없다. plain assert + `node <file>.js` 직접 실행.
 *
 * 실행: node src/daos/attachmentEntityImageSchemaRegression.test.js
 */

const fs = require('fs');
const path = require('path');
const { readSchemaSql } = require('./schemaColumnCheck');

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

// ════════════════════════════════════════════════════════════════════════
// § A. config/schema.sql 텍스트 대조
// ════════════════════════════════════════════════════════════════════════

const schemaSql = readSchemaSql();
const attMatch = schemaSql.match(/CREATE TABLE attachments \(([\s\S]*?)\n\);/);
if (!attMatch) throw new Error('config/schema.sql에서 attachments 테이블 정의를 찾지 못함');
const attBody = attMatch[1];

const chkAttContextListed = (() => {
  const m = attBody.match(/chk_att_context CHECK \(context_type IN \(([\s\S]*?)\)\)/);
  if (!m) return null;
  return m[1].match(/'([A-Z_]+)'/g).map((s) => s.replace(/'/g, ''));
})();
check('§A① chk_att_context가 9종(첨부 6종+엔티티 이미지 3종)을 전부 포함한다',
  !!chkAttContextListed
  && ['SECTION_MESSAGE', 'EVENT', 'TASK', 'POST', 'CAST', 'SPECIAL_DAY', 'USER_AVATAR', 'BINDER_AVATAR', 'CAST_COVER']
    .every((v) => chkAttContextListed.includes(v))
  && chkAttContextListed.length === 9);

check('§A② binder_id 컬럼 선언에 NOT NULL이 없다(해제됨)', /binder_id\s+UUID,/.test(attBody) && !/binder_id\s+UUID\s+NOT NULL/.test(attBody));

check('§A③ chk_att_binder_scope가 선언돼 있다(USER_AVATAR만 binder_id NULL 허용)',
  /chk_att_binder_scope CHECK \(context_type = 'USER_AVATAR' OR binder_id IS NOT NULL\)/.test(attBody));

check('§A④ chk_att_entity_target이 선언돼 있다(엔티티 이미지 3종은 context_id 필수)',
  /chk_att_entity_target CHECK \(\s*context_type NOT IN \('USER_AVATAR','BINDER_AVATAR','CAST_COVER'\) OR context_id IS NOT NULL\)/.test(attBody));

const uniqueIndexStatements = schemaSql.match(/CREATE UNIQUE INDEX[^;]*;/g) || [];
check('§A⑤ ⚠️ (context_type, context_id) 유일 인덱스가 없다(있으면 이 Task는 실패)',
  !uniqueIndexStatements.some((stmt) =>
    /ON\s+attachments\s*\(\s*context_type\s*,\s*context_id\s*\)/.test(stmt)));

check('§A⑥ 기존 6종 첨부 관련 컬럼(uploader_id·filename·file_size·content_type)은 여전히 NOT NULL — 무관한 컬럼을 건드리지 않았다',
  /uploader_id\s+UUID\s+NOT NULL/.test(attBody)
  && /filename\s+TEXT\s+NOT NULL/.test(attBody)
  && /file_size\s+BIGINT\s+NOT NULL/.test(attBody)
  && /content_type\s+VARCHAR\(128\)\s+NOT NULL/.test(attBody));

check('§A⑦ chk_att_status(기존 7개 status)는 변경 없이 그대로 있다',
  /chk_att_status CHECK \(status IN \('pending','processing','ready','hidden','deleted','rejected','error'\)\)/.test(attBody));

// migration 파일 존재 + up/down 쌍 확인
const migDir = path.join(__dirname, '../../migrations');
const upPath = path.join(migDir, '20260807_attachments_entity_images.sql');
const downPath = path.join(migDir, '20260807_attachments_entity_images.down.sql');
check('§A⑧ up 마이그레이션 파일이 존재한다', fs.existsSync(upPath));
check('§A⑨ down 마이그레이션 파일이 존재한다', fs.existsSync(downPath));
if (fs.existsSync(upPath)) {
  const up = fs.readFileSync(upPath, 'utf8');
  check('§A⑩ up 마이그레이션에 레거시 값 초기화(user_infos·binders·casts)가 있다',
    /UPDATE user_infos/.test(up) && /UPDATE binders/.test(up) && /UPDATE casts/.test(up)
    && /image_url = NULL/.test(up) && /cover_image_url = NULL/.test(up));
  check('§A⑪ up 마이그레이션도 유일 인덱스를 만들지 않는다', !/CREATE UNIQUE INDEX/.test(up));
}

// ════════════════════════════════════════════════════════════════════════
// § B. CHECK 식 논리 미러 — team-lead AC①~④ 직접 확인
// ════════════════════════════════════════════════════════════════════════

const VALID_CONTEXT_TYPES = new Set([
  'SECTION_MESSAGE', 'EVENT', 'TASK', 'POST', 'CAST', 'SPECIAL_DAY',
  'USER_AVATAR', 'BINDER_AVATAR', 'CAST_COVER',
]);
const ENTITY_IMAGE_TYPES = new Set(['USER_AVATAR', 'BINDER_AVATAR', 'CAST_COVER']);

// chk_att_context 미러
function chkAttContext(row) {
  return VALID_CONTEXT_TYPES.has(row.context_type);
}
// chk_att_binder_scope 미러 — context_type = 'USER_AVATAR' OR binder_id IS NOT NULL
function chkAttBinderScope(row) {
  return row.context_type === 'USER_AVATAR' || row.binder_id != null;
}
// chk_att_entity_target 미러 — context_type NOT IN (3종) OR context_id IS NOT NULL
function chkAttEntityTarget(row) {
  return !ENTITY_IMAGE_TYPES.has(row.context_type) || row.context_id != null;
}
function passesAll(row) {
  return chkAttContext(row) && chkAttBinderScope(row) && chkAttEntityTarget(row);
}

// ── ① 새 3종이 CHECK를 통과한다 ──────────────────────────────────────────
check('① USER_AVATAR(binder_id=null, context_id=user_id)는 세 CHECK를 전부 통과한다',
  passesAll({ context_type: 'USER_AVATAR', binder_id: null, context_id: 'user-1' }));
check('① BINDER_AVATAR(binder_id=그 바인더, context_id=binder_id와 동일)는 세 CHECK를 전부 통과한다',
  passesAll({ context_type: 'BINDER_AVATAR', binder_id: 'binder-1', context_id: 'binder-1' }));
check('① CAST_COVER(binder_id=캐스트가 속한 바인더, context_id=cast_id)는 세 CHECK를 전부 통과한다',
  passesAll({ context_type: 'CAST_COVER', binder_id: 'binder-1', context_id: 'cast-1' }));

// ── ② 잘못된 값은 거부된다 ────────────────────────────────────────────────
check('② 정의되지 않은 context_type("AVATAR" — 구 값)은 chk_att_context에서 거부된다',
  !chkAttContext({ context_type: 'AVATAR', binder_id: 'b1', context_id: 'x' }));
check('② BINDER_AVATAR인데 binder_id가 없으면 chk_att_binder_scope에서 거부된다(USER_AVATAR만 예외)',
  !chkAttBinderScope({ context_type: 'BINDER_AVATAR', binder_id: null, context_id: 'binder-1' }));
check('② CAST_COVER인데 context_id가 없으면 chk_att_entity_target에서 거부된다',
  !chkAttEntityTarget({ context_type: 'CAST_COVER', binder_id: 'b1', context_id: null }));
check('② USER_AVATAR인데 context_id가 없으면 chk_att_entity_target에서 거부된다(엔티티 이미지는 대상 필수)',
  !chkAttEntityTarget({ context_type: 'USER_AVATAR', binder_id: null, context_id: null }));

// ── ③ binder_id 없이 유저 아바타 행이 만들어진다 ─────────────────────────
check('③ USER_AVATAR 행 하나를 binder_id 없이 구성해도 세 CHECK를 전부 통과한다(회귀의 핵심 목적)',
  passesAll({ context_type: 'USER_AVATAR', binder_id: null, context_id: 'user-42' }));

// ── ④ 기존 6종 불변 — 여전히 binder_id가 필수이고, context_id는 자유(pre-upload null 허용) ──
const LEGACY_SIX = ['SECTION_MESSAGE', 'EVENT', 'TASK', 'POST', 'CAST', 'SPECIAL_DAY'];
for (const t of LEGACY_SIX) {
  check(`④ 기존 첨부(${t}) — binder_id 있고 context_id는 null이어도(pre-upload) 여전히 통과한다`,
    passesAll({ context_type: t, binder_id: 'binder-1', context_id: null }));
  check(`④ 기존 첨부(${t}) — binder_id가 없으면 여전히 chk_att_binder_scope에서 거부된다(USER_AVATAR만 예외라는 규칙 불변)`,
    !chkAttBinderScope({ context_type: t, binder_id: null, context_id: null }));
}

console.log(`\n[attachmentEntityImageSchemaRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
if (failures.length) {
  console.log('--- 실패 목록 ---');
  failures.forEach((f) => console.log(' - ' + f));
  process.exitCode = 1;
}
