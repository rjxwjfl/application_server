# RLY-20260726-audit-metadata Backend Implementation Report

- Role: backend
- Agent: rally-backend (Claude-only 서브팀, Sonnet 5)
- Result: partial — 지정 결함 수정 완료, 2개 항목은 판단 필요로 중단·보고, 전수 감사 결과 별도 보고

## 1. 구현 (요구사항 1 — `eventService.js` RSVP_UPDATE / REJECT)

`application_server/src/services/eventService.js` 3곳에 `metadata` 필드를 추가했다. 모두 기존
변수 스코프 내 값만 사용하는 순수 추가(additive) 변경이며 쿼리·시그니처·라우팅 변경 없음.

| 위치 | action | 추가한 metadata | TypeDefinitions.md 근거 |
|---|---|---|---|
| `updateParticipantState` (RSVP_UPDATE, 옛 244-251행) | `RSVP_UPDATE` | `{ new_state: state }` | `:258` |
| `rejectApply` (REJECT, 옛 270-277행) | `REJECT` | `{ target_user_id: targetUserId, new_state: 6 }` | `:259` |
| `restoreRejected` (RSVP_UPDATE, 옛 297-304행) | `RSVP_UPDATE` | `{ new_state: newState }` | `:258` (동일 action_type — 아키텍트가 지목한 사례와 같은 종류의 누락으로 판단해 함께 수정) |

`auditHandler.js`의 generic `sync` 리스너는 이미 `metadata: data.metadata || null`로 배선되어
있어 코드 쪽 추가 외에 별도 배선 변경은 불요했다.

## 2. `taskService.js:199` (TASK_PARTICIPANT) 확인 결과 — 요구사항 2 (수정 보류·보고)

`emitParticipantSync()`(taskService.js:193-202)는 `addParticipant`(CREATE) ·
`updateParticipantState`(UPDATE) · `removeParticipant`(DELETE) 세 곳에서 공용으로 호출된다.

**"같은 종류의 metadata 누락"이 아니라 그보다 근본적인 문제였다**: TypeDefinitions.md가
TASK_PARTICIPANT에 규정한 action_type은 `STATE_UPDATE`(§3-4, `:265` 예시 `{"new_state": 2}`)와
`ASSIGN`/`UNASSIGN`(§3-4, `:266` 예시 `{"target_user_id"}`)인데, 실제 코드는 이 세 값을 **한 번도
방출하지 않는다** — 대신 범용 CRUD(`CREATE`/`UPDATE`/`DELETE`)를 쓴다. 저장소 전체를 grep해도
`ActionType.STATE_UPDATE`·`ActionType.ASSIGN`·`ActionType.UNASSIGN`이 audit 경로에서 쓰인 곳은
없다. 즉 규격이 요구하는 그 조합 자체가 지금 발생하지 않으므로, "메타데이터만 비어 있다"는 이번
결함과 같은 패턴으로 단순 추가할 수 없었다.

더 중요한 부수 문제: TypeDefinitions.md §6은 "Task `STATE_UPDATE` — audit_log만 기록.
activity_feed·알림 생성 X (스팸 방지)"라고 명시한다. 그런데 `feedHandler.js`·
`notificationHandler.js`는 둘 다 `eventBus.on('sync', ...)`에 **action_type 필터 없이** 무조건
`activity_feed` insert + FCM push(`notificationService.sendSync`)를 실행한다(코드 확인 완료).
즉 지금 `emitParticipantSync(..., ActionType.UPDATE)`로 매 상태 전이(ready↔inProgress↔onHold↔done)마다
바인더 전체에 활동피드·푸시 알림이 발생하고 있어, §6이 막으려던 "스팸"이 실제로 나가고 있다.

action_type을 `STATE_UPDATE`/`ASSIGN`/`UNASSIGN`으로 바꾸는 것 자체는 기존 enum 값 사용이라
신규 구조는 아니지만, 그 전환은 (a) audit_log 기록 자체의 의미를 바꾸고 (b) §6을 실제로 지키려면
`feedHandler.js`/`notificationHandler.js`에 지금 없는 action_type 필터링을 추가해야 하는 행동
변화다. 두 상황 모두 이번 Task 지시 범위("metadata를 실어 보내십시오")를 넘는 코드 동작 변경이라
**임의로 고치지 않고 중단·보고**한다. 아키텍트/User 판단을 요청한다.

## 3. `target_id` 의미 대조 — 요구사항 3 (판단 필요 — 중단·보고)

`docs/database/schema.md:386-398`(event_participants), 동일 패턴의 task_participants 모두
**`PRIMARY KEY (instance_id, user_id)`인 복합키이며 단일 UUID PK 컬럼이 없다**. 반면
TypeDefinitions.md §2(40행)는 "target_id는 각 테이블의 PK(UUID)를 참조"라고 규정한다 — 이
두 테이블에는 그 전제를 만족하는 컬럼이 애초에 존재하지 않는다.

현재 코드는 `target_id = instance_id`(복합키의 절반)를 쓰고, 나머지 절반(`user_id`)은
REJECT 케이스에서만 `metadata.target_user_id`로 보완해왔다(이번에 추가). RSVP_UPDATE(본인
행위)는 `actor_id`(=sender_id)가 곧 대상 user_id와 같으므로 별도 보완이 불요하다.

**판단**: `target_id`를 `user_id`로 바꾸면 "어느 인스턴스인지"가 사라지고, 복합키 전체를
표현할 단일 UUID 컬럼은 스키마에 없다. 코드를 규격 문언("PK 참조")에 맞추려면 스키마에 없는
값을 요구하게 되어 불가능하고, 현재 방식(target_id=instance_id + metadata로 user_id 보완)이
사실상 유일하게 동작하는 절충안으로 보인다. 다만 이것이 §2 문언과 충돌하는 상태를 규격
문서화 없이 방치하는 것이므로, **코드를 바꾸지 않고 이 판단을 아키텍트/User에게 보고**한다.
문서 정정(§2에 복합키 테이블 예외 명시)이 필요하다면 그것은 Architect·User 권한이라 이번
작업 범위 밖이다.

## 4. TypeDefinitions.md §4 전수 대조 — 요구사항 4 (감사, 코드 수정 없음)

`§4 Logging Examples` 30개 행 전체를 `application_server/src/services/*.js`의 실제
`eventBus.emit(...)` 호출부와 대조했다(전 서비스 파일 원문 확인). 요구사항 4는 "확인"만
지시했으므로 **아래는 보고이며, 이번 커밋에서 코드를 수정하지 않았다** — 범위를 벗어나는
다중 파일 대규모 변경이 될 수 있어 후속 Task로 분리를 제안한다.

### 4-1. metadata만 비어 있음 (action_type·target_id는 이미 올바름 — 낮은 위험의 순수 추가로 해결 가능)

| 조합 | 파일:라인 | 비고 |
|---|---|---|
| `BINDER_MEMBER`×`ROLE_CHANGE` | binderService.js:151, :222 | `{from, to}` — `target.role`/`newMasterMember.role`이 업데이트 전 시점에 이미 스코프 내 존재 |
| `EVENT`×`CREATE` | eventService.js:54 | `{summary: data.summary}` |
| `EVENT`×`FORK` | eventService.js:145 | `{source_event_id: event_id}` |
| `TASK`×`CREATE` | taskService.js:28 | `{summary: taskData.summary}` |
| `SPECIAL_DAY`×`CREATE` | specialDayService.js:45 | `{label: data.name}` (컬럼명 `name`, 예시 키는 `label`) |
| `CAST`×`CREATE` | castService.js:48 | `{title, calendar_id}` |
| `CAST_COMMENT`×`CREATE` | castService.js:128 | `{cast_id}` |
| `POST`×`CREATE` | postService.js:41 | `{post_type: data.post_type, is_public: data.is_public}` |
| `POST_LIKE`×`LIKE`/`UNLIKE` | postService.js:174, :192 | `{post_id: postId}` — target_id와 중복이라 실효는 낮으나 규격 문언상 포함 가능 |
| `SECTION_MESSAGE`×`CREATE` | messageService.js:80 | `{mention_everyone: data.mention_everyone}` |
| `SECTION_MESSAGE`×`DELETE` | messageService.js:132 | `{}` (규격상 빈 객체 — 현재 `undefined`) |
| `CALENDAR`×`CREATE` | calendarService.js:36 | `{title, is_public}` |
| `CALENDAR_SUBSCRIPTION`×`SUBSCRIBE` | calendarService.js:98 | `{host_binder_id}` — binder_id 필드명 대조 필요 |

### 4-2. action_type 자체가 규격과 다름 (metadata 추가만으로 해결 불가 — 설계 판단 필요)

| 조합 | 파일:라인 | 실제 코드 | 규격 |
|---|---|---|---|
| `TASK_PARTICIPANT` | taskService.js:193-202 | `CREATE`/`UPDATE`/`DELETE` | `ASSIGN`/`STATE_UPDATE`/`UNASSIGN` — §2 §3-4·§6 참조 |
| `POST`×핀 토글 | postService.js:204-221 (`pinPost`) | `UPDATE` | `PIN_POST`/`UNPIN_POST`(§3-6) |
| `SECTION_MESSAGE`×핀 토글 | messageService.js:149-154 | `PIN`/`UNPIN` (일치) | 일치 — 문제 없음 |

### 4-3. 감사 이벤트 자체가 방출되지 않음 (metadata 문제 이전 단계 — 새 emit 호출 추가 필요, 더 큰 범위)

| 조합 | 확인한 내용 |
|---|---|
| `BINDER`×`CREATE` | `binderService.createBinder()`(19-56행)는 `member:joined`만 방출. `BINDER`/`CREATE` audit 행 자체가 생기지 않음 |
| `BINDER_MEMBER`×`JOIN`/`KICK` | `member:joined`/`member:left` 리스너(auditHandler.js:32-52)는애초에 `metadata`를 받아 넘기는 배선이 없음(`data.metadata` 참조 자체가 없음) — 생성 시 여기도 함께 손봐야 함 |
| `MESSAGE_REACTION`×`REACT`/`UNREACT` | `messageService.addReaction/removeReaction`(159-174행)은 `eventBus.emit` 호출이 전혀 없음 — 리액션은 audit_logs·activity_feeds에 전혀 기록되지 않음 |
| `ATTACHMENT`×`CREATE` | 저장소 전체에 `attachmentService.js`가 없고 `eventBus`를 쓰는 첨부 confirm 경로도 없음 — 첨부 업로드 audit 자체가 없음 |
| `SUBSCRIPTION`/`BINDER_BOOST`×`PURCHASE`/`RENEW`/`CANCEL_SUBSCRIPTION` | `billingService.js`는 `eventBus`를 전혀 쓰지 않고 별도 테이블 `subscription_events`에 직접 insert(`BillingDAO.insertSubscriptionEvent`, 93·105·181행) — `audit_logs`/`activity_feeds` 경로 자체가 다르다. 결제 도메인은 이번 감사 대상(audit_logs) 범위와 별개 저장소를 쓰고 있다는 사실만 보고 |

### 요약

- 완전 준수: `EVENT`/`EVENT_INSTANCE`/`TASK`/`TASK_INSTANCE`/`SECTION`/`CALENDAR` 등 단순
  CRUD(§3-1)만 쓰는 조합은 action_type·target_id 자체는 맞고, §4 표에 예시가 있는 것 중
  metadata만 비어 있다(4-1).
- §4 표에 예시가 없는 조합(예: `EVENT`×`UPDATE`, `EVENT_INSTANCE`×`UPDATE`, `SECTION`×`CREATE`
  등)은 애초에 규격이 metadata를 요구하지 않는 것으로 해석해 이번 감사에서 결함으로 세지 않았다.

## 5. 검증

- `node -c src/services/eventService.js` → `SYNTAX OK`
- `git diff` 확인 — 위 3개 metadata 추가 외 다른 변경 없음(`git status --short`로 확인)
- `npm test` — 실행하지 않음(placeholder, `echo "Error: no test specified" && exit 1"`, 성공 검증
  불가로 이미 확인됨)
- devDependencies에 테스트 러너 없음, `tests/`에는 무관한 회귀 테스트 1개뿐 — 이번 변경에 대한
  자동 테스트 없음
- **미검증**: 실제 `audit_logs` 테이블에 metadata가 채워지는지는 로컬에 접근 가능한 Postgres/Docker가
  없어 확인하지 못했다(`pg_isready` 명령 없음, `docker ps`도 데몬 연결 실패). 리뷰어가 DB 접근이
  있다면 `PATCH /api/events/:eventId/instances/:instanceId/participants/:userId`(RSVP_UPDATE),
  `POST /api/events/:eventId/instances/:instanceId/participants/:userId` 거부 경로(REJECT — 실제
  라우트명은 castService 아님, eventRoutes 확인 필요) 호출 후
  `SELECT metadata FROM audit_logs WHERE action_type IN ('RSVP_UPDATE','REJECT') ORDER BY created_at DESC LIMIT 5;`
  로 확인 가능하다.

## 6. 변경 파일

- `application_server/src/services/eventService.js` (3곳, 순수 추가)

## 7. 후속 작업 제안

1. §4-2(action_type 불일치, TASK_PARTICIPANT·POST 핀)는 별도 Task로 분리해 아키텍트 판단을 받고
   진행 — feedHandler/notificationHandler의 action_type 필터링 신설 여부까지 함께 결정 필요.
2. §4-3(이벤트 자체 미방출: BINDER CREATE, MESSAGE_REACTION, ATTACHMENT, 결제 도메인)은 범위가
   커서 우선순위·순서를 User가 정해줄 것을 요청.
3. §3 target_id 판단(복합 PK 테이블에 "PK 참조" 문언이 성립하지 않는 문제)은 코드보다 문서
   정정이 더 맞을 수 있어 Architect 확인 요청.
4. §4-1(순수 metadata 추가, 낮은 위험)은 승인되면 바로 착수 가능한 상태로 표까지 정리해 두었다.
