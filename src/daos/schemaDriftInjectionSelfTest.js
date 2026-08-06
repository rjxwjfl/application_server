/**
 * src/daos/schemaDriftInjectionSelfTest.js
 * =========================================
 * RLY-20260806-035 rework — ④ 자가검증을 "재현 가능한 형태"로 자동화한다(팀리드 지시).
 *
 * allDaoSchemaColumnRegression.test.js가 실제로 다섯 위치(SELECT 목록·INSERT 컬럼 목록·
 * UPDATE SET·WHERE/AND/ON·RETURNING) 각각에서 존재하지 않는 컬럼 주입을 잡아내는지, 실제
 * DAO 소스 파일을 5번 순서대로 수정 → `node allDaoSchemaColumnRegression.test.js` 서브프로세스
 * 실행 → FAIL 확인(exit code ≠ 0 AND 실패 목록에 주입한 가짜 컬럼명 등장) → 원복 → 원본과
 * 바이트 단위 동일한지 확인, 을 자동으로 반복한다.
 *
 * ⚠️ 파괴적 스크립트다 — 대상 파일을 실제로 write한다(끝나면 반드시 원복하고 검증한다).
 * 실패 도중(assert 실패·예외) 중단되면 파일이 오염된 채 남을 수 있다 — 그래서 각 케이스마다
 * try/finally로 원복을 보장한다.
 *
 * 실행: node src/daos/schemaDriftInjectionSelfTest.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.join(__dirname, '..', '..');
const regressionScript = path.join(__dirname, 'allDaoSchemaColumnRegression.test.js');

function runRegression() {
  try {
    const stdout = execFileSync(process.execPath, [regressionScript], { cwd: repoRoot, encoding: 'utf8' });
    return { exitCode: 0, stdout };
  } catch (err) {
    return { exitCode: err.status ?? 1, stdout: (err.stdout || '') + (err.stderr || '') };
  }
}

// 5개 케이스 — 팀리드 지시대로 **다섯 곳 전부 postDAO.js 한 파일**에 주입한다(팀리드가 같은
// 파일로 직접 재현할 것이므로 위치를 맞춘다).
const CASES = [
  {
    clause: 'SELECT 목록',
    file: 'src/daos/postDAO.js',
    // findLike(): SELECT * → SELECT zzz_fake (팀리드 지정 형태 그대로)
    find: '`SELECT * FROM post_likes WHERE post_id = $1 AND user_id = $2`',
    replace: '`SELECT zzz_fake FROM post_likes WHERE post_id = $1 AND user_id = $2`',
    fakeColumn: 'zzz_fake',
  },
  {
    clause: 'INSERT 컬럼 목록',
    file: 'src/daos/postDAO.js',
    // createLike(): INSERT 컬럼 목록 맨 앞에 추가
    find: 'INSERT INTO post_likes (post_id, user_id, created_at)',
    replace: 'INSERT INTO post_likes (zzz_fake, post_id, user_id, created_at)',
    fakeColumn: 'zzz_fake',
  },
  {
    clause: 'UPDATE SET',
    file: 'src/daos/postDAO.js',
    // softDelete(): posts UPDATE의 SET 절에 추가
    find: 'UPDATE posts SET deleted_at = now(), updated_at = now()',
    replace: 'UPDATE posts SET deleted_at = now(), updated_at = now(), zzz_fake = 1',
    fakeColumn: 'zzz_fake',
  },
  {
    clause: 'WHERE/AND/ON',
    file: 'src/daos/postDAO.js',
    // getLikeCount(): WHERE post_id = $1 → AND zzz_fake IS NULL 추가(팀리드 지정 형태 그대로)
    find: '`SELECT COUNT(*)::int AS count FROM post_likes WHERE post_id = $1`',
    replace: '`SELECT COUNT(*)::int AS count FROM post_likes WHERE post_id = $1 AND zzz_fake IS NULL`',
    fakeColumn: 'zzz_fake',
  },
  {
    clause: 'RETURNING',
    file: 'src/daos/postDAO.js',
    // createLike(): RETURNING * → RETURNING *, zzz_fake
    find: '       VALUES ($1,$2,COALESCE($3,now()))\n       RETURNING *`,',
    replace: '       VALUES ($1,$2,COALESCE($3,now()))\n       RETURNING *, zzz_fake`,',
    fakeColumn: 'zzz_fake',
  },
];

let allOk = true;
const resultsTable = [];

console.log('[schemaDriftInjectionSelfTest] 사전 확인 — 주입 전 그린 상태');
const baseline = runRegression();
if (baseline.exitCode !== 0) {
  console.error('사전 상태가 이미 RED다 — 자가검증을 시작할 수 없다.\n' + baseline.stdout);
  process.exit(1);
}
console.log('  OK — 그린 확인.\n');

CASES.forEach((c) => {
  const absPath = path.join(repoRoot, c.file);
  const original = fs.readFileSync(absPath, 'utf8');

  if (!original.includes(c.find)) {
    resultsTable.push({ ...c, outcome: 'ERROR — find 문자열을 소스에서 못 찾음(파일이 바뀌었을 수 있음)' });
    allOk = false;
    return;
  }

  const injected = original.replace(c.find, c.replace);

  try {
    fs.writeFileSync(absPath, injected, 'utf8');
    const result = runRegression();
    const caughtIt = result.exitCode !== 0 && result.stdout.includes(c.fakeColumn);
    resultsTable.push({
      ...c,
      outcome: caughtIt ? 'PASS(정상 탐지)' : 'FAIL(못 잡음!)',
      exitCode: result.exitCode,
      matchedFakeColumnInOutput: result.stdout.includes(c.fakeColumn),
    });
    if (!caughtIt) allOk = false;
  } finally {
    fs.writeFileSync(absPath, original, 'utf8');
    const restored = fs.readFileSync(absPath, 'utf8');
    if (restored !== original) {
      console.error(`⚠️ 원복 실패: ${c.file}`);
      allOk = false;
    }
  }
});

console.log('[schemaDriftInjectionSelfTest] 사후 확인 — 원복 후 그린 상태');
const after = runRegression();
if (after.exitCode !== 0) {
  console.error('원복 후에도 RED다 — 원복이 불완전하다.\n' + after.stdout);
  allOk = false;
} else {
  console.log('  OK — 그린 확인.\n');
}

console.log('| # | 위치 | 파일 | 주입한 문자열(가짜 컬럼) | 결과 |');
console.log('|---|---|---|---|---|');
resultsTable.forEach((r, i) => {
  console.log(`| ${i + 1} | ${r.clause} | ${r.file} | \`${r.fakeColumn}\` | ${r.outcome} |`);
});

console.log(`\n[schemaDriftInjectionSelfTest] ${allOk ? '전체 통과 — 5개 위치 모두 탐지 확인' : '실패 — 위 표에서 FAIL/ERROR 항목 확인'}`);
process.exitCode = allOk ? 0 : 1;
