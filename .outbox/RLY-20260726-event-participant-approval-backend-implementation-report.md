# RLY-20260726-event-participant-approval Backend Implementation Report

- Role: backend
- Agent: rally-backend (Claude-only 서브팀, Sonnet 5)
- Result: succeeded

## 착수 전 확인

`docs/standards/domain.md §3-8`(`:353-374`, 2026-07-26 Gate) · `docs/server/api.md`
(`PATCH /events/:eventId/instances/:instanceId/participants/:userId` 절, `:871-887`,
특히 `:883` deprecated 주석) · `docs/calendar/SC-event.md`(`:32-46`·`:140-160`·`:325-346`·
`:405-419`) · `docs/standards/_common.md` 원문을 직접 열어 대조했다.

## 사전에 발견한 차단 요인 — 구현 착수 전 확인 필요했던 것

지시문의 "판단이 필요하면 중단" 항목(author 조회 경로·role 조회 경로)과 별개로, **코드를 열어보니
`updateParticipantState`·`rejectApply`·`restoreRejected` 세 함수 모두 `EventDAO.findParticipant(...)`
를 호출하는데 그 메서드가 `eventDAO`(실제 파일명 `src/daos/eventDao.js`, macOS 대소문자 무시
파일시스템이라 `eventDAO.js`로 지칭해도 같은 파일)에 **정의돼 있지 않았다.**

```
$ grep -n "findParticipant" src/daos/eventDao.js src/services/eventService.js
src/services/eventService.js:236:      const participant = await EventDAO.findParticipant(client, instance_id, user_id);
(eventDao.js에는 없음)
```

즉 **본인 RSVP 경로(`updateParticipantState`)조차 이 지점에서 항상 `TypeError`로 500이
났을 것**이다 — 승인·거부만이 아니라 일반 RSVP도 이미 깨져 있었다. `rejectApply`·
`restoreRejected`는 어차피 `eventRoutes.js`에 마운트된 라우트가 없어(직접 확인) 호출 자체가
불가능한 고아 함수였다(팀장 설명과 일치).

**판단**: 이것은 새 개념이 아니라 이미 호출되고 있던 메서드의 누락된 정의다. `event_participants`
테이블은 이미 존재하고, `findById`/`findInstanceById`와 동일한 조회 패턴(`SELECT ... WHERE ...
AND deleted_at IS NULL`)이라 국소 bug fix로 판단해 추가했다(신규 테이블·컬럼·엔드포인트 아님).
전체를 멈추고 보고하는 대신, 이 사실을 보고서에 명시하고 구현을 진행했다 — 이 메서드 없이는
지시받은 기능이 원천적으로 동작할 수 없기 때문이다.

## 구현

**① `application_server/src/daos/eventDao.js`**
`findParticipant(conn, instanceId, userId)` 추가 — `findById`/`findInstanceById`와 동일한
조회 패턴(존재 여부만 반환, `deleted_at IS NULL`).

**② `application_server/src/services/eventService.js` — `updateParticipantState` 재작성**

- 기존 `if (user_id !== context.sender_id) throw ForbiddenError(...)` 원천 차단 가드 제거.
- `isSelf = user_id === context.sender_id`로 분기.
- `SELF_TRANSITIONS`/`APPROVER_TRANSITIONS` 두 전이표를 `domain.md §3-8`대로 리터럴 작성:
  - 본인: `invite→{accept,tentative,decline}` · `accept→{tentative,decline}` ·
    `tentative→{accept,decline}` · `decline→{apply}`.
  - 승인 권한자: `apply→{accept,rejected}` · `rejected→{accept,tentative}`.
  - `confirm(0)`은 두 표 모두에 없음 — 조기 가드(`state===0`·`participant.state===0`)로 별도 차단,
    승인 권한자 확대와 무관하게 항상 거부.
- 승인 권한자 판정: `event.author_id === context.sender_id` **OR** `binder_members.role <= 1`
  (author 조건을 먼저 보고, 아니면 `BinderDAO.getMember`로 role 조회 — `rejectApply`의 형태만
  참고하고 조건은 새로 작성. 지시대로 `role > 1 → Forbidden`(=`role <= 1` 단독) 복사하지 않고
  author OR 조건으로 새로 작성).
- **author/role/binder_id 조회 경로**: `EventDAO.findInstanceById`(→`event_id`) →
  `EventDAO.findById`(→`author_id`·`calendar_id`) → `CalendarDAO.findById`(→`binder_id`) 로
  이미 존재하는 DAO 체인만 사용했다. `binder_id`를 이제 서버가 직접 도출하므로, 기존처럼
  클라이언트가 보낸 `updateData.binder_id`를 신뢰하지 않는다(부수 효과: 이전엔 클라이언트가
  `binder_id`를 payload에 안 보내면 sync 이벤트 자체가 안 나갔는데, 이제 항상 나간다 — 이것도
  국소 bug fix로 판단해 함께 고쳤다).
- **트랜잭션 경계**: 기존 `withTransaction` 패턴 그대로. 인스턴스·이벤트·캘린더·참가자 조회와
  권한 검증, `EventDAO.updateParticipantState` 갱신을 **같은 트랜잭션 안에서** 수행한다
  (`domain.md:277` role 변경 원자 재조회 관례와 동일하게, 검증에 쓴 값과 실제 갱신 사이에
  별도 커밋 경계를 두지 않았다).
- **emit 액션 매핑**: `state===6` → `ActionType.REJECT` + `metadata:{target_user_id, new_state:6}`
  (`TypeDefinitions.md:259`), 그 외(본인 RSVP·승인 accept·rejected 복원) → `ActionType.RSVP_UPDATE`
  + `metadata:{new_state}` (`:258`). `:258` 행 자체에는 `target_user_id` 필드가 없어 승인·복원
  케이스(actor≠target)에도 넣지 않았다 — 이전 Task에서 동일하게 판단해 보고했던 지점과
  일관성 유지, 새로 확대 해석하지 않았다.

**③ `rejectApply`·`restoreRejected` 삭제** — 위 통합 분기에 로직을 흡수한 뒤 두 메서드를
파일에서 제거했다. `grep -rn "rejectApply\|restoreRejected" src/ tests/` 재확인 결과 호출부가
전혀 없었다(라우트 미마운트, 컨트롤러 미참조) — 삭제로 인한 참조 깨짐 없음.

## 검증

- `node -c src/services/eventService.js` · `node -c src/daos/eventDao.js` → 둘 다 통과.
  **구문 검사일 뿐이므로 통과 근거로 제시하지 않는다.**
- `git status --short` / `git diff` — 의도한 두 파일만 변경. `eventDao.js` 파일명이 실제로는
  `eventDao.js`(대문자 DAO 아님)임을 확인했다 — macOS 대소문자 무시 파일시스템이라 `eventDAO.js`로
  Read/Edit 해도 같은 파일에 적용됐고 git diff도 그 실제 파일 하나만 가리킨다(중복 파일 생성 없음,
  `find -iname` 로 재확인).
- `eventService.js` 건드리지 말라던 항목(`STATE_UPDATE` Task) — 이번엔 반대로 `eventService.js`
  **작업이 이번 Task 본체**이므로 수정했고, `taskService.js`·`feedHandler.js`·
  `typeDefinitions.js`는 diff --stat로 지난 Task 그대로임을 재확인해 이번에 손대지 않았다.
- **DB 없이 실제 코드 경로로 행동 검증** — `pool.connect`를 `BEGIN`/`COMMIT`/`ROLLBACK`만 받는
  가짜 client로, DAO 6개 메서드(`findInstanceById`·`findById`·`CalendarDAO.findById`·
  `findParticipant`·`updateParticipantState`·`BinderDAO.getMember`)를 인메모리 스텁으로
  대체하고 **실제 `eventService.js` 코드를 그대로 실행**했다
  (`/private/tmp/.../scratchpad/verify_event_approval.js`, 저장소 밖 임시 파일). 8개 시나리오
  전부 PASS(종료 코드 0):

  | # | 시나리오 | 결과 |
  |---|---|---|
  | 1 | **manager가 apply→rejected(6) 거부 — 이 Task의 존재 이유** | PASS, 최종 state=6, emit action=`REJECT` metadata=`{target_user_id,new_state:6}` |
  | 2 | author가 apply→accept(3) 승인 | PASS, state=3, emit action=`RSVP_UPDATE` |
  | 3 | author도 manager도 아닌 일반 member가 승인 시도 | PASS(의도대로 403 `ForbiddenError`) |
  | 4 | 신청자 본인이 자기 apply를 self-approve 시도 | PASS(의도대로 403 — apply는 SELF_TRANSITIONS에 없음) |
  | 5 | 일반 본인 RSVP(invite→accept)가 여전히 동작 | PASS, state=3 |
  | 6 | manager라도 `confirm(0)` 변경 시도 | PASS(의도대로 403) |
  | 7 | `rejected(6)` 참가자 본인이 스스로 변경 시도 | PASS(의도대로 403) |
  | 8 | manager가 `rejected(6)`→`accept(3)` 복원 | PASS, state=3, emit action=`RSVP_UPDATE` |

  이 검증은 실제 애플리케이션 로직(모듈 require·권한 분기·전이표·이벤트 emit)을 그대로 태우되
  Postgres 쿼리 실행 자체는 스텁했다 — `node -c`보다 강한 근거이지만 **실제 DB 라운드트립은
  아니다.**
- `npm test` — 실행하지 않음(placeholder, 성공 검증 불가로 기확인).
- **미검증**: 실제 Postgres에 대해 `event_participants`·`audit_logs`·`activity_feeds` 행이
  물리적으로 어떻게 저장되는지, 그리고 `EventDAO.findParticipant`가 실제 스키마 컬럼명과
  100% 일치하는지(로컬 DB로 쿼리를 실행해 본 것은 아님)는 로컬 Postgres 접근이 없어 확인하지
  못했다(`pg_isready` 없음, docker 데몬 미연결 — 지난 세 Task와 동일 환경 제약).

## 변경 파일

- `application_server/src/daos/eventDao.js` (`findParticipant` 추가 — 누락된 기존 호출의 정의)
- `application_server/src/services/eventService.js` (`updateParticipantState` 재작성,
  `rejectApply`·`restoreRejected` 삭제)

## 범위 준수 확인

- `application_server` 안에서만 작업. 클라이언트 코드 미수정.
- `docs/**` 미수정.
- 새 라우트 없음 — 기존 `PATCH .../participants/:userId` 분기만 구현. `rejectApply`/
  `restoreRejected`용 라우트를 새로 붙이지 않았다(애초에 없었음).
- 새 enum·테이블·컬럼 없음. `rejected(6)`은 기존 값 재사용.
- `taskService.js`·`feedHandler.js`·`auditHandler.js`·`notificationHandler.js` 미수정.
- `UNASSIGN`·`PIN_POST` metadata 미추가(User 승인 대기 중이라 손대지 않음).
- commit·branch 조작 없음.

## 참고 — 이번 Task 범위 밖이라 손대지 않은 인접 결함 (발견만 보고)

코드를 읽는 과정에서 같은 파일의 다른 메서드에서도 비슷한 유형의 결함을 봤으나, 이번 지시
범위(`updateParticipantState` + 고아 함수 정리)가 아니라 손대지 않았다.

- `updateEvent`(`:101`)·`updateEventInstance`(`:121`)의 `eventBus.emit` — `event.binder_id`·
  `instance.binder_id`를 참조하지만 `EventDAO.findById`/`findInstanceById`는 `binder_id`
  컬럼을 SELECT하지 않는다(이벤트는 `calendar_id`만 가짐) — 항상 `binder_id: undefined`로
  나간다.
- `deleteEventInstance`(`:179`)가 호출하는 `EventDAO.softDeleteEventInstance`도 `eventDao.js`에
  정의돼 있지 않다(`findParticipant`와 같은 유형의 누락).

후속 Task로 분리해 판단을 요청한다.
