/**
 * src/jobs/holidayJobs.js
 * =========================================
 * 공휴일 외부 API 동기화 배치 (§16-1)
 *
 * - Nager.Date: 전 세계 공휴일 (무료, 인증 불필요)
 * - data.go.kr: 한국 공휴일 보강 (대체공휴일 포함, API 키 필요)
 *
 * 스케줄: 매년 1월 2일 02:00 KST
 * 기동 시: 현재 연도 데이터가 없는 국가가 있으면 즉시 1회 실행
 *
 * 단일 진실: docs/standards/system.md §10-10
 * =========================================
 */

const cron = require('node-cron');
const pool = require('../../config/db');
const logger = require('../utils/logger');

const NAGER_BASE = 'https://date.nager.at/api/v3/PublicHolidays';
const KR_API_BASE = 'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getHolidyInfo';
const KR_API_KEY = process.env.HOLIDAYS_KR_API_KEY;

// ──────────────────────────────────────────
// 외부 API 호출
// ──────────────────────────────────────────

async function fetchNagerHolidays(year, countryCode) {
  const url = `${NAGER_BASE}/${year}/${countryCode}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) return []; // 해당 국가 데이터 없음
    throw new Error(`Nager.Date API error: ${res.status} ${url}`);
  }
  const data = await res.json();
  return data.map((h) => ({
    name: h.localName || h.name,
    holiday_date: h.date,
    country_code: countryCode,
    is_substitute: h.name?.toLowerCase().includes('substitute') || h.localName?.includes('대체') || false,
  }));
}

async function fetchKrHolidays(year) {
  if (!KR_API_KEY) return null; // API 키 없으면 Nager.Date fallback

  const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
  const results = [];

  for (const month of months) {
    const params = new URLSearchParams({
      serviceKey: KR_API_KEY,
      solYear: String(year),
      solMonth: month,
      numOfRows: '50',
      _type: 'json',
    });
    const url = `${KR_API_BASE}?${params}`;
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn('data.go.kr API error', { status: res.status, month });
      continue;
    }
    const json = await res.json();
    const items = json?.response?.body?.items?.item;
    if (!items) continue;

    const list = Array.isArray(items) ? items : [items];
    for (const item of list) {
      if (item.isHoliday !== 'Y') continue;
      const d = String(item.locdate); // 'YYYYMMDD'
      const dateStr = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      results.push({
        name: item.dateName,
        holiday_date: dateStr,
        country_code: 'KR',
        is_substitute: item.dateName?.includes('대체') || false,
      });
    }
  }
  return results;
}

// ──────────────────────────────────────────
// DB UPSERT (연도+국가 단위 교체)
// ──────────────────────────────────────────

async function upsertHolidays(countryCode, year, holidays) {
  if (holidays.length === 0) return 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `DELETE FROM holidays
       WHERE country_code = $1
         AND EXTRACT(YEAR FROM holiday_date) = $2`,
      [countryCode, year]
    );

    let inserted = 0;
    for (const h of holidays) {
      await client.query(
        `INSERT INTO holidays (name, holiday_date, country_code, is_substitute)
         VALUES ($1, $2, $3, $4)`,
        [h.name, h.holiday_date, h.country_code, h.is_substitute]
      );
      inserted++;
    }

    await client.query('COMMIT');
    return inserted;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ──────────────────────────────────────────
// 국가별 공휴일 동기화
// ──────────────────────────────────────────

async function syncCountry(countryCode, year) {
  let holidays;

  if (countryCode === 'KR') {
    const krData = await fetchKrHolidays(year);
    holidays = krData ?? await fetchNagerHolidays(year, 'KR');
  } else {
    holidays = await fetchNagerHolidays(year, countryCode);
  }

  const count = await upsertHolidays(countryCode, year, holidays);
  logger.info('Holiday sync complete', { countryCode, year, count });
  return count;
}

// ──────────────────────────────────────────
// 전체 동기화 실행
// ──────────────────────────────────────────

async function syncAllHolidays() {
  logger.info('Holiday sync started');

  // user_settings 에서 사용 중인 모든 고유 국가 코드 수집
  const { rows } = await pool.query(`
    SELECT DISTINCT UNNEST(holidays_countries) AS country_code
    FROM user_settings
    WHERE holidays_countries IS NOT NULL AND holidays_countries != '{}'
  `);

  if (rows.length === 0) {
    logger.info('Holiday sync: no countries configured, skipping');
    return;
  }

  const years = [new Date().getFullYear(), new Date().getFullYear() + 1];
  let totalCount = 0;

  for (const { country_code } of rows) {
    for (const year of years) {
      try {
        totalCount += await syncCountry(country_code, year);
      } catch (err) {
        logger.error('Holiday sync failed for country', { country_code, year, error: err.message });
      }
    }
  }

  logger.info('Holiday sync finished', { totalInserted: totalCount });
}

// ──────────────────────────────────────────
// 기동 시 초기 실행 — 현재 연도 데이터 없는 국가 체크
// ──────────────────────────────────────────

async function syncMissingCountriesOnStartup() {
  try {
    const currentYear = new Date().getFullYear();

    const { rows: configured } = await pool.query(`
      SELECT DISTINCT UNNEST(holidays_countries) AS country_code
      FROM user_settings
      WHERE holidays_countries IS NOT NULL AND holidays_countries != '{}'
    `);
    if (configured.length === 0) return;

    const configuredCodes = configured.map((r) => r.country_code);

    const { rows: existing } = await pool.query(
      `SELECT DISTINCT country_code
       FROM holidays
       WHERE EXTRACT(YEAR FROM holiday_date) = $1
         AND country_code = ANY($2)`,
      [currentYear, configuredCodes]
    );
    const existingCodes = new Set(existing.map((r) => r.country_code));

    const missing = configuredCodes.filter((c) => !existingCodes.has(c));
    if (missing.length === 0) return;

    logger.info('Holiday sync: missing countries on startup, syncing now', { missing });

    for (const country_code of missing) {
      for (const year of [currentYear, currentYear + 1]) {
        try {
          await syncCountry(country_code, year);
        } catch (err) {
          logger.error('Startup holiday sync failed', { country_code, year, error: err.message });
        }
      }
    }
  } catch (err) {
    logger.error('Startup holiday sync check failed', { error: err.message });
  }
}

// ──────────────────────────────────────────
// 스케줄러 등록
// ──────────────────────────────────────────

function startHolidayJobs() {
  // 매년 1월 2일 02:00 KST
  cron.schedule('0 2 2 1 *', syncAllHolidays, { timezone: 'Asia/Seoul' });

  logger.info('Holiday jobs scheduled (yearly: Jan 2 02:00 KST)');

  // 기동 시 누락 국가 즉시 보정 (비동기, 서버 시작 블로킹 없음)
  setImmediate(syncMissingCountriesOnStartup);
}

module.exports = { startHolidayJobs, syncAllHolidays };
