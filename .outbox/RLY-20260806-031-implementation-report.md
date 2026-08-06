# Implementation Report — RLY-20260806-031 (참가자 inviter_id 드리프트) — 범위 축소판

> 근거: docs/agents/multi-agent-operating-architecture.md §14.
> ⚠️ **범위 변경**: 최초 배정은 결함1(inviter_id)+결함2(reminder_offsets 배선) 둘 다였으나,
> 결함 2는 다른 Writer가 026 후속(서버 main `8216884`)으로 이미 처리·병합했다는 팀리드 통지를
> 받고 즉시 되돌렸다. **이 보고서는 결함 1(inviter_id)만** 다룬다.

- Writer: Backend Writer / Claude / Sonnet 5 / writer_agent_id=(this session)
- Branch: agent/claude/RLY-20260806-031-backend   code_base_commit: 3a0dd8cb6e6e4d3fd7e8a77b2f625cd58bb05f6f (서버 main, 032·035 등 병합분 포함)   Head: 동일(커밋하지 않음 — Custodian 처리 대기)
- 변경 파일:
  - `src/daos/eventDao.js` — `addParticipantRaw`·`addParticipant`에서 `inviter_id` 참조 제거
  - `src/daos/taskDAO.js` — 동일(Event와 대칭)
  - `src/services/eventService.js` — `addParticipant` 호출부에서 `invitedBy` 인자(`context.sender_id`) 제거
  - `src/services/taskService.js` — 동일
  - `src/services/reminderGenerationRegression.test.js` — 026이 만든 정적 대조 장치를 확장(새 파일 아님) + 신규 시나리오 6건

**되돌린 것(반영 안 함)**: `reminder_offsets` INSERT/UPDATE/SELECT 배선, `ReminderDAO.syncTarget` 역산 분기 제거, `eventService`/`taskService`의 오프셋 출처 전환 — 전부 다른 Writer의 026 후속 작업(main `8216884`·`991e58f`)과 100% 중복이라 되돌렸다. `createEvent`·`updateEvent`·`splitEvent`·`splitTask` 본문은 건드리지 않았다(034가 `splitEvent`/`splitTask`를 동시에 작업 중이라는 경계 통지에 따름) — `addParticipant` 계열 호출부 한 줄씩만 손댔다.

## 판정 — inviter_id 컬럼은 없다, 컬럼을 추가하지 않는다

`config/schema.sql`로 직접 재확인: `event_participants`는 `instance_id user_id state memo created_at updated_at deleted_at`(7컬럼), `task_participants`는 여기에 `completed_at`이 더해진 8컬럼. **`inviter_id`는 둘 다 없다.**

`docs/database/schema.md` changelog(2026-07-20): **"사용자 결정으로 `event_participants`·`task_participants`에서 `inviter_id`(구 `invited_by`) 컬럼·FK 완전 제거 — 참가자 테이블의 '초대자 추적'은 원 설계에 없던 오염(2026-06-10 리네임으로 유입)."** 컬럼을 되살리는 방향은 이 확정 결정과 정반대라 택하지 않았다.

**초대자 정보가 정말 불필요한지**: 서비스 레이어 전체(`src/services`·`src/api`·`src/routes`)를 grep했고, `inviter_id`/`invitedBy`를 참조하는 곳이 DAO의 죽은 파라미터 외엔 없었다. "누가 초대했는지"는 `audit_logs`/`activity_feeds`의 `actor_id`(모든 도메인 이벤트에 이미 기록되는 값, `eventBus.emit`의 `sender_id`)가 담당한다 — 별도 컬럼 없이도 이미 커버되고 있었다. `binder_invitations.inviter_id`(초대 링크 생성자, 별개 엔티티)는 이 결정과 무관해 손대지 않았다.

## 수리

`EventDAO`/`TaskDAO`의 `addParticipantRaw`·`addParticipant`에서 INSERT·UPDATE·RETURNING의 `inviter_id`를 전부 제거하고, 함수 시그니처에서 `invitedBy` 파라미터 자체를 뺐다(죽은 파라미터를 남기지 않음). 호출부 4곳:
- `EventDAO.createEvent`/`TaskDAO.createTask`의 인스턴스별 참가자 루프 — `participant.inviter_id` 전달 제거.
- `eventService.addParticipant`/`taskService.addParticipant` — `context.sender_id`를 `invitedBy`로 넘기던 인자 제거.

**`RETURNING inviter_id` 제거 후 호출부 확인**: `grep -rn "\.inviter_id" src/`로 반환된 행의 `inviter_id` 필드를 읽는 곳이 있는지 확인 — 서비스/라우트 어디에도 없었다. 안전하게 제거 가능했다.

## AC 대조

| AC | 상태 |
|---|---|
| `inviter_id` 참조가 저장소에 0건(주석 제외) | ✅ `grep`으로 확인, 남은 매치는 전부 "왜 없는지" 설명하는 주석뿐 |
| 참가자를 포함해 이벤트·태스크 생성이 성공한다 | ✅ 회귀 ⑦⑧ |

## 테스트

`src/services/reminderGenerationRegression.test.js`(026이 만든 스위트를 확장, 새 파일 아님) — **135/135 통과**:

- 기존 시나리오(①~⑥, reminder_offsets 관련) 그대로 유지, 회귀 없음.
- **정적 대조 확장**(팀리드 지시 "새로 만들지 마라"를 그대로 실행) — `assertColumnsExist`/`assertColumnsAbsent`/`assertSourceDoesNotReference`(026이 만든 헬퍼)를 재사용해:
  - `event_participants`/`task_participants`에 `inviter_id`가 스키마에도 없고(`assertColumnsAbsent`) `eventDAO.js`·`taskDAO.js`·`eventService.js`·`taskService.js` 소스에도 없음(`assertSourceDoesNotReference`, 4파일)을 확인.
- **⑦ 참가자 포함 이벤트 생성 성공** / **⑧ 태스크 동일** — 결함의 직접 재현(과거엔 SQL 에러).
- **⑨ 참가자 상태 갱신 성공** — 이벤트·태스크 양쪽에서 "생성 → 단건 참가자 추가 → 본인 상태 전이"를 왕복 검증(이벤트: invite→accept, 태스크: ready→inProgress).

**검증 방법**(정적 대조가 실제로 결함을 잡는지): `EventDAO.addParticipantRaw` 호출부를 일시적으로 구 `inviter_id` 참조로 되돌려 재실행 → 정확히 그 단언에서 실패(`⑤ EventDAO: ... inviter_id를 참조하지 않음: 단언 실패`)함을 직접 확인한 뒤 원복, `diff`로 파일이 완전히 원상 복구됐음을 재확인했다. (mock 자체는 컬럼 존재를 검증 못 해 시나리오 ⑦⑧⑨는 이 회귀를 못 잡는다 — 정적 대조가 유일한 방어선이다. 이 사실 자체가 헤더 주석과 이 검증 방법에 명시돼 있다.)

**저장소 전체 회귀(21개 파일, 개별 실행)** — **21/21 그린**: 위 포함 `allDaoSchemaColumnRegression.test.js`(RLY-20260806-035, 2324건 §A+§B 합산)·`deleteCascadeRegression.test.js`·`eventTaskDeleteCascadeRegression.test.js`·`sectionCascadeRegression.test.js`·`reminderDispatchRegression.test.js`(RLY-20260806-032, 69건)·`attachmentHardDeleteRegression.test.js`·`authzRegression.test.js`·`binderJoinApprovalRegression.test.js`·`emitBinderIdRegression.test.js`·`messageAttachmentQuotaRegression.test.js`·`pendingApplicantFilterCoverageRegression.test.js`·`postLikeRegression.test.js`·`storageQuotaRegression.test.js`·`tests/*` 6개. (`reminderDispatchRegression.test.js`가 처음엔 `korean-lunar-calendar` 모듈 누락으로 실패했으나, package.json엔 이미 선언돼 있었고 이 worktree의 `node_modules`가 033의 dependency 추가 이후로 갱신 안 된 상태였을 뿐이었다 — `npm install`로 해결, 내 코드와 무관.)

`node --check` 전 변경 파일 통과. `npm test`는 미실행(placeholder).

## `allDaoSchemaColumnRegression.test.js`(RLY-20260806-035)와의 관계 — 손대지 않음

이 파일의 헤더·`EXCLUDED_FILES`가 정확히 내 결함을 이미 알고 있었다: `src/daos/eventDao.js`·`src/daos/taskDAO.js`를 "031 소유, 이미 알려진 실 결함(inviter_id) 있음 — 031이 병합되면 이 배열에서 뺄 것"이라며 제외해 두고 있었다. **이 파일은 편집하지 않았다** — 팀리드 지시("035가 저장소 전체로 확장 중이다. 중복이 생기면 내가 병합 때 정리한다 — 네 영역만 덮으면 된다")대로 내 영역(`eventDao.js`/`taskDAO.js`/서비스 2개)만 고쳤다. **내 fix를 반영한 상태로 `EXCLUDED_FILES`에서 두 파일을 빼고 로컬로 실행해 봤고(파일을 임시로 고쳐 실행한 뒤 즉시 원상 복구 — 커밋하지 않음), 2322/2322 그대로 통과함을 확인했다**(제외 목록이 비면서 "EXCLUDED_FILES 항목이 실제 파일" 자기 확인 2건이 없어지고 `eventDao.js`·`taskDAO.js` 소스 스캔분이 새로 더해져 총 건수는 2324에서 2322로 바뀌지만, 실패는 0건) — 이 fix가 035의 소스 스캐너 기준으로도 완전히 깨끗하다는 뜻이다. 실제로 배열에서 빼는 작업은 병합 시점 조율(Custodian/팀리드)에 맡긴다.

## 데이터/API/호환성 영향

- 스키마 변경 없음. API 계약 변경 없음.
- 참가자를 포함한 이벤트·태스크 생성이 이제 성공한다(과거 100% SQL 에러).
- `POST .../participants`(단건 참가자 추가) 응답에서 `inviter_id` 필드가 사라진다 — 애초에 존재하지 않는 컬럼을 조회하려던 것이므로, 실제 클라이언트가 이 필드를 읽고 있었다면 이미 항상 `undefined`였을 것이다(클라 코드는 이 세션 범위 밖이라 직접 확인하지 않았다).
- 마이그레이션 불필요.

## 위험·제한

- 실 Postgres 통합 테스트는 미실행(모두 in-memory mock). 정적 소스 대조(`assertSourceDoesNotReference` + 035의 소스 스캐너)가 컬럼 드리프트의 실질적 방어선이다.
- `TaskService.addParticipant`가 매 참가자 추가마다 `TaskDAO.reevaluateInstanceCompletion`을 호출한다 — 이번 테스트에서는 이 회귀의 관심사가 아니라(참가자 CRUD만 검증) mock에서 no-op으로 흡수했다. 별도 검증 필요하면 요청 바란다.

## 미검증 항목

- `RLY-20260806-035`의 `EXCLUDED_FILES`에서 실제로 두 파일이 제거되는 시점(병합 조율)은 확인하지 않았다 — 로컬 임시 확인(2324/2324 통과)만 했다.

## 후속 작업

- 없음(이번 범위 완결). `allDaoSchemaColumnRegression.test.js`의 `EXCLUDED_FILES`에서 `src/daos/eventDao.js`·`src/daos/taskDAO.js`를 빼는 작업을 병합 시점에 처리해 주시기 바란다(양쪽 다 이미 클린 상태 확인됨).

## 교차 리뷰 요청

- Implementation Reviewer — 되돌린 reminder_offsets 관련 코드가 완전히 원상 복구됐는지(즉 이번 커밋이 결함 1만 건드렸는지) 확인 바람.

- 제출: submitted_by=backend-writer(claude) submitted_at=2026-08-06
