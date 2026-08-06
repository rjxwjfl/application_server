/**
 * src/daos/sqlSourceScanner.js
 * =========================================
 * RLY-20260806-035 rework — Team Lead가 재현한 결함: 이전 버전의
 * allDaoSchemaColumnRegression.test.js는 "DAO 소스가 참조하는 컬럼"을 사람이 손으로 선언한
 * 목록(assertColumnsExist(desc, table, ['col1', 'col2', ...]))과 실 스키마만 대조했다 — 소스
 * 파일 자체를 읽지 않았다. 그래서 소스에 없는 컬럼을 주입해도(WHERE 절이든 INSERT 컬럼
 * 목록이든) 통과했다: 그 주입이 "손으로 적은 목록"에 반영되지 않는 한 애초에 대조 대상이
 * 아니었기 때문이다. 이 모듈은 그 구멍을 막는다 — **실제 .js 소스 파일의 SQL 문자열을
 * 정규식으로 파싱해 컬럼 참조를 뽑아내고, 그것을 실 스키마와 대조한다.**
 *
 * 완전한 SQL 파서가 아니다(과공학·오탐 위험 — 026·035의 기존 방침을 유지). 대신:
 *   - 알 수 없는/모호한 표현은 "확인 불가"로 건너뛴다(스킵 카운터에 기록) — 실패시키지 않는다.
 *   - 확실히 판별 가능한 다섯 위치(SELECT 목록·INSERT 컬럼 목록·UPDATE SET·WHERE/AND/ON의
 *     비교식·RETURNING)만 검증한다.
 *   - alias가 가리키는 테이블을 모르면(CTE·서브쿼리 별칭 등) 스킵한다 — 잘못된 테이블에
 *     대고 존재 여부를 묻는 오탐을 만들지 않기 위해서다.
 *   - JOIN이 둘 이상이라 테이블이 모호한데 alias 접두사가 없는 컬럼도 스킵한다(같은 이유).
 *
 * 오탐(실제로 존재하는 컬럼을 "없다"고 잘못 판정)보다 미탐(실제로 없는 컬럼을 놓침)을
 * 택한다 — "완벽할 필요는 없다, 오탐이 나면 그 자체가 실패다"(팀리드 원 지시)를 그대로 따른다.
 */

const fs = require('fs');

// ─── SQL 리터럴 추출 ─────────────────────────────────────────────────────
// backtick 템플릿 리터럴 중 SQL 동사가 포함된 것만 후보로 삼는다(GCS 경로 조립 등 SQL이 아닌
// backtick 문자열을 걸러낸다). `${...}` 보간은 문자 그대로 캡처된다 — 동적 테이블/컬럼명
// (deleteCascadeHelpers.js·sectionDAO.js 루프)은 그래서 파싱이 자연히 실패해 스킵된다.
function extractSqlLiterals(jsSource) {
  const literals = [];
  const re = /`([\s\S]*?)`/g;
  let m;
  while ((m = re.exec(jsSource))) {
    const content = m[1];
    if (/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(content)) {
      literals.push(content);
    }
  }
  return literals;
}

// -- 라인 주석(SQL) 제거 — syncDAO.js 등이 SQL 문자열 안에 한국어 설명을 `-- ...`로 남긴다.
// 식별자처럼 보이는 텍스트가 주석 안에 있어도 오검출되지 않도록 비교 전에 제거한다.
function stripSqlLineComments(sql) {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

// 괄호 깊이를 지켜 최상위(depth 0) 콤마에서만 나눈다 — CASE/함수 호출/서브쿼리 내부의 콤마를
// 항목 경계로 오인하지 않기 위해서다.
function splitTopLevelComma(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

// FROM/JOIN/UPDATE/INSERT INTO/DELETE FROM 뒤에 alias처럼 보이지만 사실은 다음 SQL 키워드인
// 토큰(`FROM binders WHERE ...`에서 WHERE를 alias로 오인하는 것)을 걸러내는 예약어 집합.
const SQL_RESERVED = new Set([
  'WHERE', 'SET', 'VALUES', 'RETURNING', 'ON', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL',
  'GROUP', 'ORDER', 'BY', 'LIMIT', 'OFFSET', 'UNION', 'ALL', 'AND', 'OR', 'NOT', 'IS', 'NULL', 'IN',
  'FOR', 'UPDATE', 'INTO', 'FROM', 'SELECT', 'INSERT', 'DELETE', 'AS', 'CASE', 'WHEN', 'THEN', 'ELSE',
  'END', 'EXISTS', 'DISTINCT', 'HAVING', 'WITH', 'CONFLICT', 'DO', 'NOTHING', 'EXCLUDED', 'INTERVAL',
  'BETWEEN', 'LIKE', 'ILIKE', 'ANY', 'NOW', 'TRUE', 'FALSE', 'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST',
  'UNNEST', 'CASCADE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'COALESCE', 'GREATEST', 'LEAST', 'EXTRACT',
]);

function isPlainIdentifier(tok) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tok);
}

// FROM/JOIN/UPDATE/INSERT INTO/DELETE FROM에서 alias → table 맵과 "1차 대상 테이블"을 뽑는다.
function parseTableAliasMap(sql) {
  const aliasMap = {};
  let primaryTable = null;

  const insertM = /INSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_]*)/i.exec(sql);
  if (insertM) primaryTable = insertM[1];

  if (!primaryTable) {
    const updateM = /UPDATE\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+([a-zA-Z_][a-zA-Z0-9_]*))?\s+SET\b/i.exec(sql);
    if (updateM) {
      primaryTable = updateM[1];
      if (updateM[2] && !SQL_RESERVED.has(updateM[2].toUpperCase())) aliasMap[updateM[2]] = updateM[1];
    }
  }

  if (!primaryTable) {
    const deleteM = /DELETE\s+FROM\s+([a-zA-Z_][a-zA-Z0-9_]*)/i.exec(sql);
    if (deleteM) primaryTable = deleteM[1];
  }

  const fromJoinRe = /\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?/gi;
  let m;
  let firstFromTable = null;
  while ((m = fromJoinRe.exec(sql))) {
    const table = m[1];
    let alias = m[2];
    if (alias && SQL_RESERVED.has(alias.toUpperCase())) alias = undefined;
    if (alias) aliasMap[alias] = table;
    aliasMap[table] = table; // table명 자체도 접두사로 허용(별칭 없이 table.col 쓰는 경우 대비)
    if (!firstFromTable) firstFromTable = table;
  }
  if (!primaryTable) primaryTable = firstFromTable;

  return { aliasMap, primaryTable };
}

// ── 다섯 위치 추출 ──────────────────────────────────────────────────────

// ① INSERT INTO table (col1, col2, ...) — 항상 primaryTable(=INSERT 대상) 소속, 명확.
function extractInsertColumns(sql) {
  const m = /INSERT\s+INTO\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\(([^)]*)\)/i.exec(sql);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim()).filter(isPlainIdentifier);
}

// ② UPDATE ... SET col = ... (일반 UPDATE와 INSERT ... ON CONFLICT DO UPDATE SET 둘 다 잡는다 —
// 두 형태 다 "primaryTable에 대한 SET"이라는 점은 동일하다).
function extractSetColumns(sql) {
  const m = /\bSET\b([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|$)/i.exec(sql);
  if (!m) return [];
  const parts = splitTopLevelComma(m[1]);
  const cols = [];
  parts.forEach((part) => {
    const cm = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=/.exec(part);
    if (cm) cols.push(cm[1]);
  });
  return cols;
}

// ③ RETURNING col1, col2, ... — 항상 INSERT/UPDATE/DELETE 대상(primaryTable) 소속.
function extractReturningColumns(sql) {
  const m = /\bRETURNING\b([\s\S]*)$/i.exec(sql);
  if (!m) return { star: false, items: [], skipped: 0 };
  const body = m[1].trim();
  if (/^\*$/.test(body)) return { star: true, items: [], skipped: 0 };
  const parts = splitTopLevelComma(body);
  const items = [];
  let skipped = 0;
  parts.forEach((part) => {
    const p = part.trim().replace(/\s+AS\s+"?[a-zA-Z_][a-zA-Z0-9_]*"?$/i, '').trim();
    const idMatch = /^(?:([a-zA-Z_][a-zA-Z0-9_]*)\.)?([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(p);
    if (idMatch) items.push({ alias: idMatch[1] || null, col: idMatch[2] });
    else skipped += 1;
  });
  return { star: false, items, skipped };
}

// ④ SELECT col1, alias.col2, ... FROM — 첫 SELECT..FROM 사이. `*`/`alias.*`/복합 표현식은 스킵.
function extractSelectColumns(sql) {
  const m = /\bSELECT\b([\s\S]*?)\bFROM\b/i.exec(sql);
  if (!m) return { items: [], skipped: 0, hasStarItem: false };
  const parts = splitTopLevelComma(m[1]);
  const items = [];
  let skipped = 0;
  let hasStarItem = false;
  parts.forEach((rawPart) => {
    const part = rawPart.trim().replace(/\s+AS\s+"?[a-zA-Z_][a-zA-Z0-9_]*"?$/i, '').trim();
    if (/^([a-zA-Z_][a-zA-Z0-9_]*\.)?\*$/.test(part)) { hasStarItem = true; return; }
    const idMatch = /^(?:([a-zA-Z_][a-zA-Z0-9_]*)\.)?([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(part);
    if (idMatch) items.push({ alias: idMatch[1] || null, col: idMatch[2] });
    else skipped += 1;
  });
  return { items, skipped, hasStarItem };
}

// ⑤ WHERE/AND/ON 등 비교식의 LHS — 쿼리 전체(중첩 서브쿼리 포함)를 대상으로 "식별자 다음에
// 비교 연산자/IS NULL/IN(" 패턴을 전역으로 찾는다. SET 절과 겹쳐 잡히는 경우가 있으나 같은
// 결론(같은 테이블의 같은 컬럼)이라 무해하다.
function extractComparisonColumns(sql) {
  const re = /\b([a-zA-Z_][a-zA-Z0-9_]*\.)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=(?!=)|<>|!=|<=|>=|<(?!>)|>|IS\s+NOT\s+NULL\b|IS\s+NULL\b|ILIKE\b|(?<![a-zA-Z_])LIKE\b|IN\s*\()/g;
  const items = [];
  let m;
  while ((m = re.exec(sql))) {
    const alias = m[1] ? m[1].slice(0, -1) : null;
    const col = m[2];
    const upperCol = col.toUpperCase();
    if (SQL_RESERVED.has(upperCol)) continue; // "SET"·"AND" 등이 앞선 alias.col 없이 단독으로 안 걸리게
    if (alias && SQL_RESERVED.has(alias.toUpperCase())) continue;
    items.push({ alias, col });
  }
  return items;
}

// ── 스키마 대조 ──────────────────────────────────────────────────────────

function resolveTable(ref, aliasMap, primaryTable, allTables) {
  if (ref.alias) {
    const t = aliasMap[ref.alias];
    if (t && allTables.has(t)) return t;
    return null; // 별칭을 모름(CTE 등) — 스킵
  }
  const realTables = new Set(Object.values(aliasMap).filter((t) => allTables.has(t)));
  if (primaryTable && allTables.has(primaryTable)) realTables.add(primaryTable);
  if (realTables.size === 1) return [...realTables][0];
  return null; // 테이블이 0개(파싱 실패) 또는 2개 이상(모호) — 스킵
}

/**
 * 하나의 SQL 문자열에서 (table, column) 참조 목록 + 스킵 카운트를 뽑는다.
 * @returns {{ refs: {table:string, column:string, clause:string}[], skipped: {reason:string, count:number}[] }}
 */
function scanOneStatement(rawSql, allTables) {
  const sql = stripSqlLineComments(rawSql);
  const { aliasMap, primaryTable } = parseTableAliasMap(sql);
  const refs = [];
  const skipped = [];
  const bump = (reason, count = 1) => { if (count > 0) skipped.push({ reason, count }); };

  const isDml = /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql.trim()) || /\bINSERT\s+INTO\b/i.test(sql) || /\bUPDATE\b[\s\S]*\bSET\b/i.test(sql);
  const primaryResolvable = primaryTable && allTables.has(primaryTable);

  // ① INSERT 컬럼 목록
  const insertCols = extractInsertColumns(sql);
  if (insertCols) {
    if (primaryResolvable) {
      insertCols.forEach((col) => refs.push({ table: primaryTable, column: col, clause: 'INSERT columns' }));
    } else {
      bump(`INSERT columns — 대상 테이블 미확정(${primaryTable || '?'})`, insertCols.length);
    }
  }

  // ② UPDATE/ON CONFLICT SET
  const setCols = extractSetColumns(sql);
  if (setCols.length) {
    if (primaryResolvable) {
      setCols.forEach((col) => refs.push({ table: primaryTable, column: col, clause: 'UPDATE SET' }));
    } else {
      bump(`UPDATE SET — 대상 테이블 미확정(${primaryTable || '?'})`, setCols.length);
    }
  }

  // ③ RETURNING
  const returning = extractReturningColumns(sql);
  if (returning.star) {
    bump('RETURNING * — 컬럼명 비노출');
  } else if (returning.items.length || returning.skipped) {
    returning.items.forEach((item) => {
      // RETURNING은 항상 primaryTable 소속(별칭이 있어도 DML 대상은 하나뿐이므로 별칭 유무 무관).
      if (primaryResolvable) refs.push({ table: primaryTable, column: item.col, clause: 'RETURNING' });
      else bump(`RETURNING — 대상 테이블 미확정(${primaryTable || '?'})`);
    });
    bump('RETURNING — 복합 표현식(함수·별칭 계산식)', returning.skipped);
  }

  // ④ SELECT 목록
  const select = extractSelectColumns(sql);
  if (select.hasStarItem) bump('SELECT * / alias.*');
  if (select.skipped) bump('SELECT — 복합 표현식(CASE·함수·서브쿼리)', select.skipped);
  select.items.forEach((item) => {
    const table = resolveTable(item, aliasMap, primaryTable, allTables);
    if (table) refs.push({ table, column: item.col, clause: 'SELECT list' });
    else bump(`SELECT — alias/테이블 미확정 (${item.alias || '(무접두)'}.${item.col})`);
  });

  // ⑤ WHERE/AND/ON 비교식
  const cmp = extractComparisonColumns(sql);
  cmp.forEach((item) => {
    const table = resolveTable(item, aliasMap, primaryTable, allTables);
    if (table) refs.push({ table, column: item.col, clause: 'WHERE/AND/ON' });
    else bump(`WHERE/AND/ON — alias/테이블 미확정 (${item.alias || '(무접두)'}.${item.col})`);
  });

  return { refs, skipped };
}

/**
 * JS 소스 파일 하나를 스캔해 (table, column, clause) 참조와 스킵 사유 목록을 반환한다.
 */
function scanFile(filePath, allTables) {
  const src = fs.readFileSync(filePath, 'utf8');
  const literals = extractSqlLiterals(src);
  const refs = [];
  const skipped = [];
  literals.forEach((sql) => {
    const result = scanOneStatement(sql, allTables);
    refs.push(...result.refs);
    skipped.push(...result.skipped);
  });
  return { refs, skipped, statementCount: literals.length };
}

module.exports = {
  extractSqlLiterals,
  stripSqlLineComments,
  splitTopLevelComma,
  parseTableAliasMap,
  extractInsertColumns,
  extractSetColumns,
  extractReturningColumns,
  extractSelectColumns,
  extractComparisonColumns,
  resolveTable,
  scanOneStatement,
  scanFile,
};
