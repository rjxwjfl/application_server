# Implementation Report — RLY-20260806-001 (spec_rev 1 / state_rev 3)

> 근거: `docs/agents/multi-agent-operating-architecture.md` §14.
> 제출: 자기 worktree `.outbox/`에 불변 artifact로 생성 → Custodian이 digest 검증 후 `.ai/reports/`로 수입(§13-3). 원저자 본문 무변조.

- Writer: Backend / codex / gpt-5.6-sol / writer_agent_id=/root/f_s8a_backend_writer
- Branch: `agent/codex/RLY-20260806-001-backend`   code_base_commit: `1ba0d0ad36d5451ec33c5b92cdb7bb653e039941`   design_source: `rally@09d5ff85483a11d8f30e6fcc4326a9bb39ef5c21` digest=packet 미기재   reviewed_sha: `7b292bf8e1ee4105f77c00fc2cf75befecf23ad9`   Head: `7b292bf8e1ee4105f77c00fc2cf75befecf23ad9` (Rework 1 미커밋 worktree diff)
- 변경 파일: `src/api/specialDays/specialDayController.js`, `src/services/specialDayService.js`, `tests/specialDayAuthorizationRegression.test.js`
- 구현 내용: `GET /special-days/:id` controller가 `req.user_id`를 service에 전달한다. Service는 SpecialDay 존재를 먼저 확인해 기존 404를 유지하고, `calendar_id → CalendarDAO.findById → binder_id → BinderDAO.findById → BinderDAO.getMember` 기존 경로로 활성 Calendar와 활성 Binder를 먼저 확인한 뒤 활성 멤버(`member != null && deleted_at == null`)를 확인한다. 비멤버와 탈퇴 멤버는 403으로 거부한다. 부모 Calendar가 없거나 삭제됐거나, Binder가 없거나 삭제된 경우 SpecialDay 404로 처리하고 membership 조회를 수행하지 않는다.
- AC 증적:
  - AC-S8A-1: 타 바인더 비멤버 및 tombstone 멤버가 403이고 반환 데이터가 없음을 회귀 테스트로 검증. Rework 1에서 Binder만 soft-delete된 상태에 남은 활성 membership을 사용할 수 없고 404로 데이터가 반환되지 않으며 `getMember`도 호출되지 않음을 검증.
  - AC-S8A-2: 활성 `member` role 사용자의 기존 객체 반환과 존재하지 않는 SpecialDay의 기존 메시지·404 및 parent/membership 미조회 순서를 검증. 누락·삭제 Calendar와 삭제 Binder의 부모 404도 검증.
  - AC-S8A-3: `create/update/delete/getByCalendar`, DAO/schema/routes/common authz 변경 없음. 허용된 세 파일만 제품·테스트 diff에 포함.
- 테스트 명령·결과: `node --test tests/specialDayAuthorizationRegression.test.js` → pass (7 tests, fail 0); `node --check src/api/specialDays/specialDayController.js` → pass; `node --check src/services/specialDayService.js` → pass; `node --check tests/specialDayAuthorizationRegression.test.js` → pass; `git diff --check` → pass.
- 데이터/API/호환성 영향: DB/schema/route 변경 없음. 공개 HTTP 경로·성공 응답 형식은 유지된다. 내부 service 메서드 시그니처가 `getById(id)`에서 `getById(id, userId)`로 확장되며 현재 HTTP controller 호출부를 함께 갱신했다. 비멤버의 기존 무인가 200만 403으로 교정된다.
- 위험·제한: 회귀 테스트는 DAO와 pool을 stub한 service/controller 경계 테스트다. 실제 Firebase 인증·Express error middleware·PostgreSQL 왕복은 수행하지 않았다. 원본 `application_server/AGENTS.md`가 실제로 존재하지 않아 읽을 수 없었고, 명시된 원본 역할 문서 `rally/.codex/agents/backend.md`를 대신 적용했다. `SC-special-day.md §10`에는 외부 구독자 조회 허용이라는 잔여 문구와 비멤버 시야 금지 문구가 공존하지만, Task packet design refs의 최신 `_common.md §3-1`, `user_workflows.md §5-30`, `CHANGELOG 2026-08-02`가 SpecialDay 비노출을 확정하고 잔여 문구 정합을 차순으로 명시하므로 packet AC에 따랐다.
- 미검증 항목: 실 HTTP 요청을 통한 200/403/404 응답 body와 실 DB 왕복. Task가 지정한 좁은 Node 회귀 테스트 외 전체 suite는 실행하지 않았다. `npm test`는 기존 실패 placeholder라 성공 증적으로 사용하지 않았다.
- 후속 작업: 독립 Implementation/Test/Security-Correctness/Documentation-Traceability review. Merge 및 Task completed 판정은 User/Custodian 권한으로 남긴다.
- 교차 리뷰 요청: packet `required_reviews`의 implementation, test, security_correctness, documentation_traceability 전부 필요. 특히 존재 확인 선행에 따른 404 보존, Calendar·Binder·membership 전 계층의 활성 판정, 삭제 Binder에 남은 membership 우회 불가, 비멤버 응답에 data가 실리지 않는지 검토 요청.
- 제출: submitted_by=/root/f_s8a_backend_writer submitted_at=2026-08-06T01:09:48+09:00 source_artifact_digest=Custodian 재산출 대기 (Rework 1)
- 수입: imported_by=Custodian 대기 imported_at=대기
