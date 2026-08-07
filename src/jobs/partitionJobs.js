/**
 * src/jobs/partitionJobs.js
 * =========================================
 * RLY-20260806-175 — 연도별 파티션 테이블(`notifications`·`audit_logs`·`activity_feeds`,
 * 전부 `PARTITION BY RANGE (created_at)`)이 `config/schema.sql`에 2026~2028년만 정적으로
 * 선언돼 있었다(173에서 발견). 2029-01-01부터 그 해 파티션이 없어 세 테이블 모두 INSERT가
 * 전면 실패한다 — 알림·감사 로그·활동 피드가 동시에 죽는다. 173의 정리(파티션 DROP)보다
 * 급한 결함이다: 정리 누락은 디스크가 서서히 차는 문제지만, 이건 특정 시점부터 쓰기 자체가
 * 전면 중단된다.
 *
 * ── "언제 만드는가" — holidayJobs.js 선례를 그대로 따랐다(168이 확인한 그 cron) ──────
 * holidayJobs.js가 구조적으로 동일한 문제(미래 시점 데이터가 미리 있어야 한다)를 이미
 * 풀어 놨다: ①매년 1/2 cron으로 "올해+내년"을 미리 채우고, ②서버 기동 시(`setImmediate`)
 * 누락이 있으면 즉시 보정한다. 세 갈래(cron으로 미리 / INSERT 실패 시 생성 / 넉넉히 미리
 * 선언) 중 하나만 고르지 않고 **holidayJobs와 같은 이중 구조**를 그대로 재사용했다 —
 * 판단 기준은 "안 돌았을 때 무엇이 죽는가"다:
 *   · cron 단독이면 "cron이 안 돌면 조용히 실패한다"(team-lead 지적 그대로) — cron
 *     스케줄러 자체가 장애거나, 서버가 그 시각에 재시작 중이었거나, 배포 파이프라인이
 *     cron 등록을 빠뜨리는 경우 등, **몇 년 뒤에야 발견되는 침묵 실패**가 된다.
 *   · INSERT 실패 시 생성은 team-lead가 이미 "복잡하고 경합이 있다"고 지적했다 — 파티션
 *     생성은 배타적 락을 잡는 DDL이라 여러 요청이 동시에 실패해 동시에 생성을 시도하면
 *     서로 기다리거나 충돌한다. 정상 요청 경로에 DDL을 얹는 것도 지연·실패 표면을 넓힌다.
 *   · 넉넉히 미리 선언(예: 2035까지)만으로는 "언젠가 또 온다"는 게 team-lead의 지적대로
 *     맞다 — 그 시점이 오면 지금과 똑같은 침묵 실패가 반복된다. 파티션 생성 자체는
 *     휴일 API 호출과 달리 완전히 로컬(외부 의존 없음, DDL 한 줄)이라 "넉넉히" 자체는
 *     쉽지만, 그것만으론 이 문제를 구조적으로 닫지 못한다.
 * **기동 시 자가 보정이 핵심이다** — 서버는 배포·재시작이 cron 주기보다 훨씬 잦다
 * (일반적인 운영 패턴). 이 침묵 실패가 실제로 터지려면 "매년 1/2 cron이 계속 실패"
 * **하고 동시에** "그 몇 년 동안 서버가 단 한 번도 재기동하지 않아야" 한다 — 사실상
 * 불가능에 가까운 복합 조건이라야만 실패한다. 이 정도 안전 마진이면 "조용히 실패하면
 * 서비스가 멈추는 부류"(team-lead 표현)에 맞는 방어라고 판단했다.
 *
 * ── 확보 범위 — "올해 + 2년" ────────────────────────────────────────────────
 * holidayJobs는 "올해+내년"(1년 여유)이었지만, 여긴 2년 여유(`LOOKAHEAD_YEARS = 2`)로
 * 더 넓게 잡았다 — 실패의 성격이 다르다. 휴일 데이터 누락은 캘린더 일부가 비는 정도지만,
 * 파티션 누락은 **쓰기 전면 중단**이다. 파티션 생성 비용은 사실상 0(빈 테이블 DDL,
 * 외부 API 없음)이라 여유를 더 주는 데 실질적인 비용이 없다 — 2년 여유면 "cron 계속
 * 실패 + 2년 넘게 서버 재기동 0회"라는 훨씬 더 일어나기 힘든 조건이라야 실패한다.
 *
 * ── schema.sql의 정적 선언은 그대로 둔다 ─────────────────────────────────────
 * `config/schema.sql`이 2026~2028을 정적으로 선언해 두는 것 자체는 문제가 아니다 —
 * 신규 설치 직후 `startPartitionJobs()`의 기동 시 자가 보정(`setImmediate`)이 그 시점
 * 기준으로 "올해+2년"이 있는지 다시 확인해 부족하면 채운다. 이 스키마 파일을 몇 년 뒤에
 * 그대로 재사용해 설치해도(예: 이 파일 그대로 2029년에 설치) 앱 첫 기동에서 곧바로
 * 스스로 메꾼다 — schema.sql 자체를 연도 계산하도록 동적으로 바꿀 필요가 없다(이 파일이
 * 이미 "부족하면 채운다"를 전담하므로, 정적 선언은 그저 초기 시드일 뿐이다). 이 사실을
 * schema.sql의 해당 선언 옆에도 짧게 남겨 다음 사람이 "왜 2028까지만 있지"를 다시 조사할
 * 필요가 없게 했다.
 * =========================================
 */

const cron = require('node-cron');
const pool = require('../../config/db');
const logger = require('../utils/logger');

// PARTITION BY RANGE(created_at), `<table>_<YYYY>` 명명 규칙(config/schema.sql)을 쓰는
// 테이블만 나열한다 — 임의 문자열이 아니라 이 고정 화이트리스트만 SQL에 보간한다.
const PARTITIONED_TABLES = ['notifications', 'audit_logs', 'activity_feeds'];
const LOOKAHEAD_YEARS = 2;

// RLY-20260806-175 — 세 테이블 모두 파티션 "생성"만 다룬다. 정리(오래된 파티션 DROP)는
// notifications만(173) 보관 정책이 확정됐고, audit_logs·activity_feeds는 아직 판정 전이라
// 이 파일도 173의 cleanupNotificationPartitions()도 그 둘을 지우지 않는다.
async function ensurePartitionsForTable(table, currentYear) {
  let created = 0;
  for (let year = currentYear; year <= currentYear + LOOKAHEAD_YEARS; year++) {
    const relname = `${table}_${year}`;
    const nextYear = year + 1;
    // CREATE TABLE IF NOT EXISTS ... PARTITION OF — 이미 있으면 조용히 스킵(멱등, 실측
    // 확인: Postgres가 NOTICE만 내고 에러 없이 성공한다). pg_inherits로 먼저 존재 여부를
    // 조회하는 별도 왕복이 필요 없다 — IF NOT EXISTS 자체가 그 역할을 한다.
    const { rows } = await pool.query(
      `SELECT to_regclass($1) IS NULL AS missing`,
      [relname]
    );
    if (!rows[0].missing) continue; // 이미 있음 — CREATE 자체를 시도하지 않아 로그도 안 남긴다.

    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${relname} PARTITION OF ${table}
       FOR VALUES FROM ('${year}-01-01') TO ('${nextYear}-01-01')`
    );
    logger.info('Partition created', { table, partition: relname, range: `[${year}-01-01, ${nextYear}-01-01)` });
    created += 1;
  }
  return created;
}

async function ensurePartitions() {
  const { rows: nowRows } = await pool.query(`SELECT EXTRACT(YEAR FROM NOW())::int AS year`);
  const currentYear = nowRows[0].year;

  let totalCreated = 0;
  for (const table of PARTITIONED_TABLES) {
    try {
      totalCreated += await ensurePartitionsForTable(table, currentYear);
    } catch (err) {
      logger.error('Partition ensure failed for table', { table, error: err.message });
    }
  }
  return totalCreated;
}

function startPartitionJobs() {
  // holidayJobs.js와 동일한 시각(매년 1/2 02:00 KST) — 새해 파티션이 실제로 필요해지기
  // 전에 미리 확보해 둔다는 취지가 같다.
  cron.schedule('0 2 2 1 *', ensurePartitions, { timezone: 'Asia/Seoul' });
  logger.info('Partition jobs scheduled (yearly: Jan 2 02:00 KST, lookahead 2 years)');

  // 기동 시 즉시 1회 자가 보정 — cron이 오래 안 돌았거나(장애·배포 공백) 방금 설치된
  // 환경이어도 서버가 뜨는 순간 바로 메운다(holidayJobs.syncMissingCountriesOnStartup과
  // 동일 패턴). 서버 시작을 블로킹하지 않는다.
  setImmediate(() => {
    ensurePartitions().catch((err) => {
      logger.error('Startup partition ensure failed', { error: err.message });
    });
  });
}

module.exports = { startPartitionJobs, ensurePartitions };
