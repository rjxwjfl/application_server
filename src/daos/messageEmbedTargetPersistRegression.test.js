/**
 * src/daos/messageEmbedTargetPersistRegression.test.js
 * =========================================
 * RLY-20260806-100 — messageDAO.insertEmbeds의 INSERT 컬럼 목록에 target_type·target_id·
 * embed_data가 없어(087이 판정) F7 링크 카드(캘린더/cast/feed 항목)가 항상 NULL로 저장됐다.
 * message_embeds 자체(id·type·url 등)는 이미 정상 동작하므로 이 스위트는 **새로 추가된 3컬럼만**
 * 재현·검증한다 — 기존 임베드(link/image/video) 저장·조회는 messageAttachmentSyncRegression 등
 * 기존 스위트가 이미 커버한다.
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`, 가짜 conn으로 실제 DAO 코드
 * (MessageDAO.insertEmbeds·getEmbedsByMessageIds)를 그대로 구동한다.
 *
 * 실행: node src/daos/messageEmbedTargetPersistRegression.test.js
 */

const assert = require('assert');
const { MessageDAO } = require('./messageDAO');

function makeConn(store) {
  return {
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim();

      if (s.startsWith('INSERT INTO message_embeds')) {
        // ⚠️ 재현 근거 — 컬럼 목록에 target_type·target_id·embed_data가 실제로 있는지 직접 확인.
        assert(s.includes('target_type'), 'INSERT 컬럼 목록에 target_type이 없다 — 회귀');
        assert(s.includes('target_id'), 'INSERT 컬럼 목록에 target_id가 없다 — 회귀');
        assert(s.includes('embed_data'), 'INSERT 컬럼 목록에 embed_data가 없다 — 회귀');

        const rows = [];
        // 파라미터는 8개 임베드 컬럼 그룹이 반복되는 형태가 아니라 임베드당 11개(id·message_id·
        // type·url·title·description·site_name·image_url·target_type·target_id·embed_data)씩
        // 순서대로 이어붙는다 — insertEmbeds 구현과 동일하게 11개씩 잘라 읽는다.
        for (let i = 0; i < params.length; i += 11) {
          const [id, message_id, type, url, title, description, site_name, image_url, target_type, target_id, embed_data] = params.slice(i, i + 11);
          const row = { id, message_id, type, url, title, description, site_name, image_url, target_type, target_id, embed_data: embed_data ? JSON.parse(embed_data) : null, deleted_at: null };
          store.embeds[id] = row;
          rows.push(row);
        }
        return { rows };
      }

      if (s.startsWith('SELECT id, message_id, type, url, title, description, site_name, image_url, target_type, target_id, embed_data')) {
        const [messageIds] = params;
        const rows = Object.values(store.embeds).filter((e) => messageIds.includes(e.message_id) && !e.deleted_at);
        return { rows };
      }

      throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
    },
  };
}

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond) { if (cond) pass++; else { fail++; failures.push(desc); } }

async function run() {
  const store = { embeds: {} };
  const conn = makeConn(store);

  // ============ ① F7 카드 임베드 — target_type·target_id·embed_data가 실제로 저장된다 ============
  const inserted = await MessageDAO.insertEmbeds(conn, 'm1', [
    {
      id: 'emb1', type: 'event_instance', url: null,
      target_type: 'EVENT_INSTANCE', target_id: 'ei1',
      embed_data: { title: '이번 주 회의', start_date: '2026-08-10T14:00:00Z' },
    },
  ]);
  check('① INSERT 응답에 target_type이 실린다', inserted[0].target_type === 'EVENT_INSTANCE');
  check('① INSERT 응답에 target_id가 실린다', inserted[0].target_id === 'ei1');
  check('① INSERT 응답에 embed_data(JSONB)가 실린다', inserted[0].embed_data && inserted[0].embed_data.title === '이번 주 회의');

  // ============ ② 저장된 값이 조회(getEmbedsByMessageIds)로도 그대로 돌아온다 ============
  const fetched = await MessageDAO.getEmbedsByMessageIds(conn, ['m1']);
  check('② SELECT 컬럼에 target_type·target_id·embed_data가 포함된다', 'target_type' in fetched[0] && 'target_id' in fetched[0] && 'embed_data' in fetched[0]);
  check('② 조회된 target_id가 저장한 값과 일치', fetched[0].target_id === 'ei1');

  // ============ ③ 기존 link 임베드(target_type 없음) — 하위호환, target 컬럼은 NULL로 유지 ============
  const linkEmbed = await MessageDAO.insertEmbeds(conn, 'm2', [
    { id: 'emb2', type: 'link', url: 'https://example.com' },
  ]);
  check('③ 기존 link 임베드는 target_type=NULL', linkEmbed[0].target_type == null);
  check('③ 기존 link 임베드는 target_id=NULL', linkEmbed[0].target_id == null);
  check('③ 기존 link 임베드 url은 그대로 저장됨(회귀 없음)', linkEmbed[0].url === 'https://example.com');

  console.log(`\n[messageEmbedTargetPersistRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[messageEmbedTargetPersistRegression] 실행 실패:', error);
  process.exitCode = 1;
});
