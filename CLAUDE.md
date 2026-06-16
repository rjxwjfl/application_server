# CLAUDE.md (서버 워크스페이스)

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

---

## 0. 문서 진입 — 단일 진실

Rally 프로젝트의 모든 설계·도메인·동기화·API 문서는 클라이언트 워크스페이스에 있다.

**모든 작업 전 로드 (공통):**
- `c:\dev\rough\docs\standards\_common.md` — 공통 표준 (§1·2·3 도메인 계층도·§7-1 에러 원칙·참조 문서 map)

**관심사별 추가 로드:**

| 작업 관심사 | 추가 로드 |
|------------|----------|
| **System & Security** (인증·동기화·웹훅·인프라·서버 표준) | `standards\system.md`, 필요 시 `standards\billing.md`, `docs\server\architecture.md`, `docs\server\api.md`, `docs\server\media.md` |
| **Domain & Data** (엔티티 CRUD·DB 스키마·도메인 정책) | `standards\domain.md`, `docs\database\schema.md`, `docs\database\design_intent.md`, `docs\server\api.md` (도메인 엔드포인트), 해당 도메인의 `docs\{drawer,calendar,series,user,billing}\SC-*.md` |
| **결제·구독** | `standards\billing.md` + 위 둘 중 해당 관심사 |

**스펙 검색:** `c:\dev\rough\docs\specs_index.md` 에서 도메인·기능 찾아 해당 SC-xxx.md 열기.

**변경 이력:** `c:\dev\rough\docs\standards\CHANGELOG.md` (기본 미로드, 필요 시 참조).

> 충돌 발견 시: 코드보다 문서가 우선. 즉시 보고하고 방향을 확인한다.
> 표준을 바꾸고 싶다면 코드를 바꾸기 전에 해당 standards 파일을 먼저 수정하고 CHANGELOG.md 에 기록한다.

---

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
