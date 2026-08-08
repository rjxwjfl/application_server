/**
 * src/services/originUuidBodyFieldRegression.test.js
 * =========================================
 * RLY-20260806-151 — transport.md §8-2가 "③ body origin_uuid 필드(혼용)"로 등재한 4곳
 * (캐스트 댓글·게시글 댓글·결제·재활성화) 조사. **조사 전용 Task — 코드는 고치지 않았다.**
 *
 * 조사 결과: 4곳 전부 무해하다.
 *   - 캐스트·게시글 댓글: SC-cast.md:566·SC-post.md:695가 body 예시로 `origin_uuid`를 적어
 *     뒀지만, 실제 클라 코드(`cast_repository.dart:212-216`·`post_repository.dart:255-259`)는
 *     이미 `{'id': id, 'content': ..., 'parent_id': ...}`를 보낸다 — **문서가 낡았을 뿐 코드는
 *     이미 표준 경로(①body id)를 쓰고 있다.** 서버(`castService.addComment`·
 *     `postService.addComment`)도 이미 `data.id || generateUUID()`로 정확히 존중한다.
 *   - 결제(`billingService.verifyAndActivatePurchase`)·재활성화(`authService.reactivate`)는
 *     `origin_uuid`를 어디서도 읽지 않는다(grep 확인) — 결제는 클라가 로컬에 먼저 낙관적으로
 *     쓰지 않고(`billing_repository.dart:90-104` — 서버 응답의 `sub.id`를 받은 뒤에야 로컬에
 *     쓴다) 조건①이 거짓이라 파생물 판정과 무관하고, 재활성화는 새 행 자체를 안 만든다(기존
 *     `users` 행의 상태만 바꾼다) — 화면에 먼저 보일 "새 행"이 없다.
 *
 * 이 회귀는 그 **현재(올바른) 동작을 고정**한다 — 캐스트·게시글 댓글 회귀가 핵심이다: 클라가
 * (문서 예시대로) `origin_uuid`도 같이 보내는 상황을 가정해도 `data.id`가 흔들리지 않고,
 * `origin_uuid` 필드가 있어도 없어도 결과가 같아야 한다(추가 필드가 조용히 오류를 내면 안 된다).
 *
 * 관행: 테스트 프레임워크 없음. plain assert + `node <file>.js`.
 *
 * 실행: node src/services/originUuidBodyFieldRegression.test.js
 */


const dbPath = require.resolve('../../config/db');
const NOW = new Date('2026-08-07T00:00:00Z').toISOString();

const binderMembers = { 'b1:member1': { binder_id: 'b1', user_id: 'member1', role: 3, deleted_at: null } };
const calendars = { cal1: { id: 'cal1', binder_id: 'b1' } };
const casts = { cast1: { id: 'cast1', calendar_id: 'cal1', deleted_at: null } };
const posts = { post1: { id: 'post1', binder_id: 'b1', deleted_at: null } };

const savedCastComments = [];
const savedPostComments = [];

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
    return { rows: binderMembers[`${params[0]}:${params[1]}`] ? [binderMembers[`${params[0]}:${params[1]}`]] : [] };
  }
  if (s.includes('FROM casts WHERE id = $1')) {
    return { rows: casts[params[0]] ? [casts[params[0]]] : [] };
  }
  if (s.includes('FROM calendars') && s.includes('WHERE id = $1')) {
    return { rows: calendars[params[0]] ? [calendars[params[0]]] : [] };
  }
  if (s.includes('FROM posts p') && s.includes('WHERE p.id = $1')) {
    return { rows: posts[params[0]] ? [posts[params[0]]] : [] };
  }
  // CastDAO.createComment
  if (s.startsWith('INSERT INTO cast_comments')) {
    const [id, cast_id, user_id, parent_id, content] = params;
    const row = { id, cast_id, user_id, parent_id, content, created_at: NOW, updated_at: NOW };
    savedCastComments.push(row);
    return { rows: [row] };
  }
  // PostDAO.createComment
  if (s.startsWith('INSERT INTO post_comments')) {
    const [id, post_id, user_id, parent_id, content] = params;
    const row = { id, post_id, user_id, parent_id, content, created_at: NOW, updated_at: NOW };
    savedPostComments.push(row);
    return { rows: [row] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 140)} params=${JSON.stringify(params)}`);
}

const mockDb = { query: mockQuery, connect: async () => ({ query: mockQuery, release() {} }) };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { CastService } = require('./castService');
const { PostService } = require('./postService');

let pass = 0;
let fail = 0;
const failures = [];
function check(desc, cond, detail) { if (cond) pass++; else { fail++; failures.push(detail ? `${desc}: ${detail}` : desc); } }

async function run() {
  const ctx = { sender_id: 'member1', device_uuid: 'dev1' };

  // ============ 캐스트 댓글 — 클라 실제 형태(id + origin_uuid 둘 다 있어도) ============
  savedCastComments.length = 0;
  await CastService.addComment('cast1', { id: 'cast-comment-1', content: '좋아요', origin_uuid: 'unrelated-queue-tracking-id' }, ctx);
  check(
    '캐스트 댓글 — body id가 그대로 행 id로 저장된다(origin_uuid가 같이 와도 무시)',
    savedCastComments[0] && savedCastComments[0].id === 'cast-comment-1',
    `실제=${JSON.stringify(savedCastComments[0])}`
  );

  savedCastComments.length = 0;
  await CastService.addComment('cast1', { content: 'id 없이 origin_uuid만(문서 예시 형태)', origin_uuid: 'doc-example-shape' }, ctx);
  check(
    '캐스트 댓글 — id가 없으면(문서 예시처럼 origin_uuid만) origin_uuid를 대신 쓰지 않고 서버가 새로 발급한다(하위호환 폴백, 채널을 바꾸지 않았음을 확인)',
    savedCastComments[0] && typeof savedCastComments[0].id === 'string' && savedCastComments[0].id !== 'doc-example-shape',
    `실제=${JSON.stringify(savedCastComments[0])}`
  );

  // ============ 게시글 댓글 — 동일 확인 ============
  savedPostComments.length = 0;
  await PostService.addComment('post1', { id: 'post-comment-1', content: '동의합니다', origin_uuid: 'unrelated-queue-tracking-id' }, ctx);
  check(
    '게시글 댓글 — body id가 그대로 행 id로 저장된다(origin_uuid가 같이 와도 무시)',
    savedPostComments[0] && savedPostComments[0].id === 'post-comment-1',
    `실제=${JSON.stringify(savedPostComments[0])}`
  );

  savedPostComments.length = 0;
  await PostService.addComment('post1', { content: 'id 없이 origin_uuid만(문서 예시 형태)', origin_uuid: 'doc-example-shape' }, ctx);
  check(
    '게시글 댓글 — id가 없으면 origin_uuid를 대신 쓰지 않고 서버가 새로 발급한다',
    savedPostComments[0] && typeof savedPostComments[0].id === 'string' && savedPostComments[0].id !== 'doc-example-shape',
    `실제=${JSON.stringify(savedPostComments[0])}`
  );

  // ============ 결제·재활성화 — 소스 텍스트로 origin_uuid 미참조 고정 ============
  // billingService.verifyAndActivatePurchase·authService.reactivate는 완전히 별개의 DAO 체인
  // (BillingDAO 다건·UserDAO)이라 목업 비용 대비 가치가 낮다고 판단해 별도 서비스 구동 대신
  // 소스 텍스트 대조로 "origin_uuid를 참조하지 않는다"를 고정한다 — 이 파일이 다루는 핵심
  // 대조군(캐스트·게시글 댓글)과 달리 애초에 origin_uuid를 쓸 이유가 없는 두 경로(결제=서버
  // 응답 후에만 로컬 반영이라 조건①이 거짓, 재활성화=새 행 자체가 없음)라 "안 읽는지"만
  // 확인하면 충분하다(보고서 참조).
  const fs = require('fs');
  const path = require('path');
  const billingSrc = fs.readFileSync(path.join(__dirname, 'billingService.js'), 'utf8');
  const authSrc = fs.readFileSync(path.join(__dirname, 'authService.js'), 'utf8');
  check('결제 — billingService.js가 origin_uuid를 참조하지 않는다(소스 텍스트 확인)', !billingSrc.includes('origin_uuid'));
  check('재활성화 — authService.js가 origin_uuid를 참조하지 않는다(소스 텍스트 확인)', !authSrc.includes('origin_uuid'));

  console.log(`\n[originUuidBodyFieldRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[originUuidBodyFieldRegression] 실행 실패:', error);
  process.exitCode = 1;
});
