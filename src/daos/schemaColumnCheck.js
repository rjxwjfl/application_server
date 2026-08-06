/**
 * src/daos/schemaColumnCheck.js
 * =========================================
 * RLY-20260806-026(reminderGenerationRegression.test.js)이 처음 만든 "config/schema.sql의
 * 실제 CREATE TABLE 정의를 파싱해 DAO 소스가 참조하는 컬럼명과 정적으로 대조"하는 장치를
 * 공용 모듈로 뽑아낸 것 — RLY-20260806-035가 이 장치를 저장소 전체 DAO로 확장하면서, 같은
 * 파서를 두 벌로 복제하지 않기 위해 추출했다(팀리드 지시 — "새로 만들지 마라, 재사용·확장해라").
 *
 * 이 모듈은 순수 파싱 유틸만 제공한다. pass/fail 카운팅·assert 문구는 각 회귀 파일이
 * 자신의 `check()` 클로저로 감싸서 쓴다(reminderGenerationRegression.test.js·
 * allDaoSchemaColumnRegression.test.js 둘 다 이 패턴).
 *
 * 실제 Postgres가 없어 mock은 컬럼 존재를 검증 못 한다 — 이 파서가 그 구멍을 막는 유일한 장치다.
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_SQL_PATH = path.join(__dirname, '../../config/schema.sql');

function readSchemaSql() {
  return fs.readFileSync(SCHEMA_SQL_PATH, 'utf8');
}

// CHECK(...) 블록을 균형 괄호로 통째로 제거한다 — 내부의 AND/OR/NOT/컬럼명이 라인 파싱에서
// "컬럼처럼" 오검출되는 것(예: ck_sd_lunar_fields의 "OR (is_lunar AND ...")을 막는다.
function stripCheckBlocks(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const idx = text.indexOf('CHECK', i);
    if (idx === -1) { out += text.slice(i); break; }
    out += text.slice(i, idx);
    let j = idx + 5;
    while (j < text.length && /\s/.test(text[j])) j += 1;
    if (text[j] !== '(') { out += text.slice(idx, j); i = j; continue; }
    let depth = 1; j += 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '(') depth += 1;
      else if (text[j] === ')') depth -= 1;
      j += 1;
    }
    i = j; // CHECK(...) 전체 스킵
  }
  return out;
}

// RLY-20260806-035 rework — sqlSourceScanner.js가 alias→table 해석 시 "이 이름이 실제
// 테이블인가"(CTE·서브쿼리 별칭이 아닌가)를 판정하는 데 쓴다.
function getAllTableNames(schemaSql) {
  const names = new Set();
  const re = /CREATE TABLE (\w+)/g;
  let m;
  while ((m = re.exec(schemaSql))) names.add(m[1]);
  return names;
}

function extractTableColumns(schemaSql, tableName) {
  const re = new RegExp(`CREATE TABLE ${tableName} \\(`);
  const m = re.exec(schemaSql);
  if (!m) throw new Error(`[schema] 테이블을 찾을 수 없음: ${tableName}`);
  const start = m.index + m[0].length;
  let depth = 1;
  let j = start;
  while (j < schemaSql.length && depth > 0) {
    if (schemaSql[j] === '(') depth += 1;
    else if (schemaSql[j] === ')') depth -= 1;
    j += 1;
  }
  const body = schemaSql.slice(start, j - 1);
  const cleaned = stripCheckBlocks(body);
  const cols = [];
  cleaned.split('\n').forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('--')) return;
    const kw = line.split(/\s+/)[0].toUpperCase();
    if (['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN'].includes(kw)) return;
    const colMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s/);
    if (colMatch) cols.push(colMatch[1]);
  });
  return cols;
}

// 주석(// ·  /* */)은 "왜 이 컬럼을 더 이상 안 쓰는지" 설명하느라 그 컬럼명을 자연스럽게
// 언급한다(예: "구 user_id·base_time은 참조하지 않는다") — 이런 설명 자체가 오탐이 되면 안 되므로
// 실제 코드(문자열 리터럴·SQL) 판정 전에 주석을 먼저 제거한다.
function stripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

module.exports = {
  SCHEMA_SQL_PATH,
  readSchemaSql,
  stripCheckBlocks,
  extractTableColumns,
  getAllTableNames,
  stripJsComments,
};
