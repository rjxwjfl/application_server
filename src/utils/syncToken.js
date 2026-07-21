/**
 * Sync Token 유틸
 *
 * 상태 기반 동기화 토큰 (Base64 JSON 인코딩)
 * Payload: { ts: number, d_ids: string[], c_ids: string[] }
 *
 *   ts    — 마지막 동기화 완료 시각 (Unix timestamp, seconds)
 *   d_ids — 마지막 동기화 시점에 유저가 속한 바인더 ID 목록
 *   c_ids — 마지막 동기화 시점에 유저가 구독한 캘린더 ID 목록
 *
 * 서버는 현재 d_ids/c_ids 와 토큰의 값을 비교하여
 * 신규 획득 권한(new_d_ids, new_c_ids)을 계산하고
 * Delta(기존 권한) / Full+Window(신규 권한) UNION ALL 쿼리를 선택한다.
 */

/**
 * @param {{ ts: number, d_ids: string[], c_ids: string[] }} payload
 * @returns {string} Base64 encoded sync token
 */
function encode({ ts, d_ids, c_ids }) {
  const json = JSON.stringify({ ts, d_ids, c_ids });
  return Buffer.from(json).toString('base64');
}

/**
 * @param {string | null | undefined} token
 * @returns {{ ts: number, d_ids: string[], c_ids: string[] } | null}
 */
function decode(token) {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
    if (typeof parsed.ts !== 'number') return null;
    return {
      ts: parsed.ts,
      d_ids: Array.isArray(parsed.d_ids) ? parsed.d_ids : [],
      c_ids: Array.isArray(parsed.c_ids) ? parsed.c_ids : [],
    };
  } catch {
    return null;
  }
}

module.exports = { encode, decode };
