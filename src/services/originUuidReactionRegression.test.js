/**
 * src/services/originUuidReactionRegression.test.js
 * =========================================
 * RLY-20260806-142 — 클라(`section_repository.dart` addReaction)가 반응 id를 `_uuid.v7()`로
 * 스스로 만들어 **로컬** `MessageReactions`(id-keyed, `uk_message_reactions`
 * `UNIQUE(message_id,user_id,emoji) WHERE deleted_at IS NULL`, `app_database.dart:140`)에
 * 먼저 써 두고, 그 id를 body가 아니라 `X-Origin-UUID` 헤더로만 서버에 보낸다
 * (SC-messaging.md:765 "origin_uuid=reactionId"). 서버(`messageService.js`)는 그 헤더를
 * 읽지 않고 매번 새 id를 발급했다 — 다음 sync pull이 다른 id의 행을 또 삽입해 로컬 같은
 * UNIQUE 인덱스(`uk_message_reactions`)를 위반, 그 pull 배치 전체가 롤백돼 SyncToken이
 * 전진하지 못하는 영구 동기화 정지가 실제 증상이었다(140 실측).
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`, config/db를 가짜 connection으로
 * 교체해 실제 서비스 코드(MessageService.addReaction)를 그대로 구동한다.
 *
 * ⚠️ RLY-20260806-179 갱신 — addReaction이 이제 eventBus.emit('sync')를 위해 메시지·섹션을
 * 먼저 조회한다(binder_id가 필요해서다 — 179 참조). 그 두 조회에 대한 mock 분기를 추가했다.
 *
 * 실행: node src/services/originUuidReactionRegression.test.js
 */

const fs = require('fs');
const path = require('path');

const dbPath = require.resolve('../../config/db');
const NOW = new Date('2026-08-07T00:00:00Z').toISOString();

const messages = { m1: { id: 'm1', section_id: 's1', user_id: 'author1', parent_id: null, content: 'hi', mention_everyone: false, is_pinned: false, deleted_at: null } };
const sections = { s1: { id: 's1', binder_id: 'b1', title: 'sec1', access_scope: 0, is_default: false, deleted_at: null } };
const savedReactions = [];

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // MessageDAO.findById (RLY-20260806-179 — addReaction이 binder_id를 위해 조회)
  if (s.startsWith('SELECT id, section_id, user_id, parent_id, content') && s.includes('FROM section_messages')) {
    const row = messages[params[0]];
    return { rows: row ? [row] : [] };
  }
  // SectionDAO.findById (위와 동일 이유)
  if (s.startsWith('SELECT id, binder_id, title, access_scope, is_default') && s.includes('FROM sections')) {
    const row = sections[params[0]];
    return { rows: row ? [row] : [] };
  }
  // MessageDAO.addReaction
  if (s.startsWith('INSERT INTO message_reactions')) {
    const [id, message_id, user_id, emoji] = params;
    const row = { id, message_id, user_id, emoji, created_at: NOW };
    savedReactions.push(row);
    return { rows: [row] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { MessageService } = require('./messageService');

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond, detail) { if (cond) pass++; else { fail++; failures.push(detail ? `${desc}: ${detail}` : desc); } }

async function run() {
  // ============ 클라가 X-Origin-UUID로 보낸 id를 서버가 그대로 쓴다(핵심 수리) ============
  savedReactions.length = 0;
  const clientReactionId = 'client-origin-uuid-1234';
  await MessageService.addReaction('m1', '❤️', { sender_id: 'u1', origin_uuid: clientReactionId });
  check(
    '클라가 보낸 X-Origin-UUID를 반응 id로 그대로 저장한다(로컬 optimistic 행과 일치해야 sync pull이 같은 행을 UPDATE한다)',
    savedReactions[0] && savedReactions[0].id === clientReactionId,
    `실제=${JSON.stringify(savedReactions[0])}`
  );

  // ============ 회귀 불변 — origin_uuid가 없으면(구버전 클라 등) 여전히 서버가 발급한다(하위호환) ============
  savedReactions.length = 0;
  await MessageService.addReaction('m1', '👍', { sender_id: 'u1', origin_uuid: null });
  check(
    '회귀 불변 — origin_uuid가 없으면 서버가 UUID를 새로 발급한다(하위호환, 빈 값이 아니어야 함)',
    savedReactions[0] && typeof savedReactions[0].id === 'string' && savedReactions[0].id.length > 0 && savedReactions[0].id !== clientReactionId
  );

  savedReactions.length = 0;
  await MessageService.addReaction('m1', '👍', { sender_id: 'u1' }); // context.origin_uuid 필드 자체가 없는 구 호출부 흉내
  check(
    '회귀 불변 — context.origin_uuid 필드가 아예 없어도(구 시그니처) 안전하게 발급한다',
    savedReactions[0] && typeof savedReactions[0].id === 'string' && savedReactions[0].id.length > 0
  );

  // ============ 컨트롤러가 헤더를 실제로 읽어 서비스에 넘기는지(구조 확인) ============
  const controllerSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'sections', 'sectionController.js'), 'utf8');
  const addReactionStart = controllerSrc.indexOf('addReaction: asyncHandler');
  const nextHandlerStart = controllerSrc.indexOf('removeReaction: asyncHandler');
  check('addReaction 컨트롤러를 소스에서 찾음', addReactionStart > -1 && nextHandlerStart > addReactionStart);
  const addReactionBlock = controllerSrc.slice(addReactionStart, nextHandlerStart);
  check(
    "컨트롤러가 'x-origin-uuid' 헤더를 실제로 읽는다(하드코딩 확인이 아니라 소스 텍스트로 직접 확인)",
    /req\.headers\[['"]x-origin-uuid['"]\]/.test(addReactionBlock)
  );
  check(
    '컨트롤러가 읽은 헤더값을 origin_uuid로 서비스에 전달한다',
    /origin_uuid:\s*originUuid/.test(addReactionBlock)
  );

  console.log(`\n[originUuidReactionRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[originUuidReactionRegression] 실행 실패:', error);
  process.exitCode = 1;
});
