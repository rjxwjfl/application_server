/**
 * Sync Token 유틸
 *
 * 상태 기반 동기화 토큰 (Base64 JSON 인코딩)
 * Payload: { ts: number, d_ids: string[], c_ids: string[], s_ids: string[] }
 *
 *   ts    — 마지막 동기화 완료 시각 (Unix timestamp, seconds)
 *   d_ids — 마지막 동기화 시점에 유저가 속한 바인더 ID 목록
 *   c_ids — 마지막 동기화 시점에 유저가 구독한 캘린더 ID 목록
 *   s_ids — 마지막 동기화 시점에 유저가 접근 가능했던 섹션 ID 목록
 *
 * 서버는 현재 d_ids/c_ids/s_ids 와 토큰의 값을 비교하여
 * 신규 획득 권한(new_d_ids, new_c_ids, hydrate_section_ids)과
 * 상실한 권한(purge_binder_ids, purge_section_ids)을 계산하고
 * Delta(기존 권한) / Full+Window(신규 권한) UNION ALL 쿼리를 선택한다.
 *
 * s_ids(RLY-20260806-039) — encode/decode가 구조분해로 s_ids를 드롭하고 있었다(호출부는 이미
 * s_ids를 넣어 보내고 있었는데도). 그 결과 previousSectionIds가 매 동기화마다 항상 []로
 * 떨어져 purge_section_ids가 항상 빈 배열, hydrate_section_ids는 매번 전량이었다 — 설계된
 * 대칭(hydrate/purge)이 조용히 반쪽만 동작하던 결함. 이 필드를 실제로 실어 보내고 돌려받게
 * 고쳤다.
 */

/**
 * @param {{ ts: number, d_ids: string[], c_ids: string[], s_ids: string[] }} payload
 * @returns {string} Base64 encoded sync token
 */
function encode({ ts, d_ids, c_ids, s_ids }) {
  const json = JSON.stringify({ ts, d_ids, c_ids, s_ids });
  return Buffer.from(json).toString('base64');
}

/**
 * @param {string | null | undefined} token
 * @returns {{ ts: number, d_ids: string[], c_ids: string[], s_ids: string[] } | null}
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
      // s_ids가 없는 기존 발급 토큰(이 필드 도입 이전) — 크래시 없이 빈 배열로 떨어져야
      // previousSectionIds가 []가 되고, purge_section_ids가 과잉 오발동하지 않는다.
      s_ids: Array.isArray(parsed.s_ids) ? parsed.s_ids : [],
    };
  } catch {
    return null;
  }
}

module.exports = { encode, decode };
