# CLAUDE.md (서버 워크스페이스)

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

## 0-A. 멀티 에이전트 팀 운영 (2026-06-17 도입)

본 프로젝트는 **Sonnet 오케스트레이터 + Opus 아키텍트 + 3-Sonnet 구현 에이전트** 5-tier 모델로 운영된다. 정의·운영 가이드는 모두 클라이언트 워크스페이스에 있다.

| Pane | 에이전트 | 정의 파일 |
|------|---------|---------|
| 0 | 오케스트레이터 (Sonnet 4.6) | `c:\dev\rough\.claude\agents\orchestrator.md` |
| 1 | 아키텍트 (Opus 4.8) | `c:\dev\rough\.claude\agents\architect.md` |
| 2 | **Backend** (Sonnet 4.6) — 이 워크스페이스 전담 | `c:\dev\rough\.claude\agents\backend.md` |
| 3 | Client-Domain (Sonnet 4.6) | `c:\dev\rough\.claude\agents\client-domain.md` |
| 4 | Client-UI (Sonnet 4.6) | `c:\dev\rough\.claude\agents\client-ui.md` |
| 5 | 리뷰어 (Sonnet 4.6) | `c:\dev\rough\.claude\agents\reviewer.md` |
| — | 운영 가이드 | `c:\dev\rough\.claude\agents\README.md` |

---
