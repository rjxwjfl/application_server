/**
 * src/services/postLikeRegression.test.js
 * =========================================
 * RLY-20260806-035 — post_likes DAO ↔ 실 스키마 드리프트 수리 회귀.
 *
 * 결함: postDAO.js가 post_likes에 없는 컬럼(id·deleted_at)을 참조했다 — findLike·getLikeCount·
 * createLike·softDeleteLike 넷 다. 실 스키마(config/schema.sql — post_id, user_id, created_at
 * 3컬럼, PK (post_id, user_id))는 soft delete 대상이 아니다(design_intent.md §post_likes,
 * docs/binder/SC-post.md L1·액션D — "좋아요 OFF → post_likes hard DELETE"). reminderGenerationRegression
 * 과 동일 관행: 테스트 프레임워크 없이 plain assert + `node <file>.js` 직접 실행, 가짜 DB
 * connection으로 실제 서비스 코드를 구동한다.
 *
 * 실행: node src/services/postLikeRegression.test.js
 */

let pass = 0;
let fail = 0;
const failures = [];

function check(desc, condition) {
  if (condition) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${desc}: 단언 실패`);
  }
}

async function expectOk(desc, fn) {
  try {
    const result = await fn();
    pass += 1;
    return result;
  } catch (err) {
    fail += 1;
    failures.push(`${desc}: 정상 통과를 기대했지만 에러 — ${err.statusCode || ''} ${err.message}\n${err.stack}`);
    return undefined;
  }
}

const dbPath = require.resolve('../../config/db');
const NOW = new Date().toISOString();

const db = {
  posts: {
    post1: {
      id: 'post1', binder_id: 'b1', author_id: 'author1', post_type: 0, is_public: false,
      title: null, body_markdown: '본문', thumbnail_url: null, cover_image_url: null,
      special_day_id: null, created_at: NOW, updated_at: NOW, deleted_at: null,
    },
  },
  binder_members: {
    'b1:author1': { binder_id: 'b1', user_id: 'author1', role: 0, deleted_at: null },
    'b1:liker1': { binder_id: 'b1', user_id: 'liker1', role: 3, deleted_at: null },
    'b1:liker2': { binder_id: 'b1', user_id: 'liker2', role: 3, deleted_at: null },
  },
  // key: `${post_id}:${user_id}` — post_likes PK가 (post_id, user_id) 복합키인 것과 동형.
  post_likes: {},
};

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();

  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

  // PostDAO.findById
  if (s.startsWith('SELECT p.*') && s.includes('FROM posts p')) {
    const row = db.posts[params[0]];
    return { rows: row && !row.deleted_at ? [row] : [] };
  }

  // BinderDAO.getMember
  if (s.includes('FROM binder_members') && s.includes('WHERE binder_id = $1 AND user_id = $2')) {
    const row = db.binder_members[`${params[0]}:${params[1]}`];
    if (!row || row.role < 0) return { rows: [] };
    return { rows: [row] };
  }

  // PostDAO.findLike — id·deleted_at 없이 (post_id, user_id) 자연키로만 조회한다는 것이 이 회귀의 핵심.
  if (s === 'SELECT * FROM post_likes WHERE post_id = $1 AND user_id = $2') {
    const row = db.post_likes[`${params[0]}:${params[1]}`];
    return { rows: row ? [row] : [] };
  }

  // PostDAO.getLikeCount
  if (s === "SELECT COUNT(*)::int AS count FROM post_likes WHERE post_id = $1") {
    const count = Object.values(db.post_likes).filter((r) => r.post_id === params[0]).length;
    return { rows: [{ count }] };
  }

  // PostDAO.createLike — id 파라미터가 아예 없다(3개 컬럼만: post_id, user_id, created_at).
  if (s.startsWith('INSERT INTO post_likes (post_id, user_id, created_at)')) {
    const [post_id, user_id, created_at] = params;
    const row = { post_id, user_id, created_at: created_at || NOW };
    db.post_likes[`${post_id}:${user_id}`] = row;
    return { rows: [row] };
  }

  // PostDAO.deleteLike — hard DELETE, UPDATE가 아니다.
  if (s === 'DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2') {
    delete db.post_likes[`${params[0]}:${params[1]}`];
    return { rows: [] };
  }

  throw new Error(`[mock] Unhandled query: ${s.slice(0, 160)} params=${JSON.stringify(params)}`);
}

const mockDb = {
  query: mockQuery,
  connect: async () => ({ query: mockQuery, release() {} }),
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { PostService } = require('./postService');

async function run() {
  const liker1 = { sender_id: 'liker1', device_uuid: 'dev1' };
  const liker2 = { sender_id: 'liker2', device_uuid: 'dev2' };

  // ① 좋아요 생성 — 이전엔 INSERT INTO post_likes (id, post_id, user_id, created_at)가 없는
  // id 컬럼을 넣어 100% SQL 에러였다.
  const liked = await expectOk('① 좋아요 생성', () => PostService.likePost('post1', liker1));
  check('① 응답에 count 포함', liked && liked.count === 1);

  // ② 좋아요 수 집계 — COUNT(*) 쿼리가 존재하지 않는 deleted_at 필터 없이 동작해야 한다.
  const liked2 = await expectOk('② 두 번째 사용자 좋아요', () => PostService.likePost('post1', liker2));
  check('② 좋아요 수 2로 집계', liked2 && liked2.count === 2);

  // ① 좋아요 조회(findLike) 왕복 — 중복 좋아요는 멱등(기존 좋아요 그대로 count만 반환).
  const dup = await expectOk('① 중복 좋아요 요청(멱등)', () => PostService.likePost('post1', liker1));
  check('① 중복 요청도 count 2 유지(중복 삽입 없음)', dup && dup.count === 2);

  // ① 좋아요 취소(hard delete) 왕복.
  const unliked = await expectOk('① 좋아요 취소', () => PostService.unlikePost('post1', liker1));
  check('① 취소 후 count 1로 감소', unliked && unliked.count === 1);
  check('① 취소된 좋아요가 실제로 행에서 사라짐(hard delete)', db.post_likes['post1:liker1'] === undefined);

  // ② 취소 후 재조회로 카운트 정합 재확인.
  const countAfter = await expectOk('② 취소 후 카운트 재조회', () => PostService.likePost('post1', liker2));
  check('② liker2 재요청(멱등) 후에도 count 1', countAfter && countAfter.count === 1);

  console.log(`\n[postLikeRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[postLikeRegression] 실행 실패:', error);
  process.exitCode = 1;
});
