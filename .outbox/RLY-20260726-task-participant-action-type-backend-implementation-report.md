# RLY-20260726-task-participant-action-type Backend Implementation Report

- Role: backend
- Agent: rally-backend (Claude-only 서브팀, Sonnet 5)
- Result: partial — ①③④ 중 구현 가능한 부분 완료, **②(STATE_UPDATE) 및 그에 의존하는 ③(feed 필터)은 차단·보고**

## 착수 전 확인

`docs/server/TypeDefinitions.md`(§3-4 `:184-192`, §4 `:265-266`, §6 `:308`) ·
`docs/standards/domain.md`(§3-5(10) `:191-197`, §3-5(11) `:199-209`) ·
`docs/standards/_common.md` · `docs/standards/system.md` 원문을 직접 열어 대조했다.

## 차단 사유 — 지시문 전제와 실제 코드가 불일치

지시문은 "`ASSIGN`·`UNASSIGN`·`STATE_UPDATE` 세 enum 모두 `typeDefinitions.js:87-89`에 이미
정의되어 있다"고 했으나, 실제로는 **`STATE_UPDATE`만 정의되어 있지 않다.**

```
$ grep -rin "state_update\|stateupdate" src/ package.json
(결과 없음)
$ grep -c "STATE_UPDATE" src/utils/typeDefinitions.js
0
```

`src/utils/typeDefinitions.js:71-113`의 `ActionType` freeze 객체를 직접 확인했다.
`RSVP_UPDATE`(86)·`REJECT`(87)·`ASSIGN`(88)·`UNASSIGN`(89)은 정의돼 있지만 `STATE_UPDATE`
키 자체가 없다(대소문자·오타 변형까지 전수 grep, 0건).

`TypeDefinitions.md` §3-4(`:190`)·§4(`:265`)는 `STATE_UPDATE`를 이미 확정된 값으로 문서화하고
있으므로, 이것은 설계 미결이 아니라 **JS enum 미러링 누락**으로 보인다. 다만:

- 이번 Task의 범위 제약은 "새 enum·테이블·엔드포인트 생성 금지"를 명시한다.
- `ActionType`은 `Object.freeze`된 공유 상수이며 audit/feed/notification 세 핸들러가 함께
  참조한다 — 제가 임의로 키를 추가하면 그 자체가 계약 변경이 된다.
- 지시문의 "이미 정의되어 있다"는 전제가 이 값에 한해 사실이 아니므로, 무엇을 해도(추가하거나
  건너뛰거나) 지시문을 문자 그대로 따를 수 없는 상태다.

그래서 **`STATE_UPDATE` 관련 변경은 하지 않고 판단을 요청**한다. `ActionType.STATE_UPDATE`를
그대로 참조했다면 `undefined`가 되어 `auditHandler.js:8`의 `if (!data.action ...) return;`에
걸려 audit 행 자체가 안 만들어지는, 지난 Task와 같은 종류의 무음 데이터 소실이 재발했을
것이다 — 그래서 시도하지 않았다.

## 구현 완료 (지시문 중 차단되지 않은 부분)

**`application_server/src/services/taskService.js`**

| 항목 | 위치(수정 후) | 변경 |
|---|---|---|
| ① 참여자 추가 | `addParticipant` | `ActionType.CREATE` → `ActionType.ASSIGN` (`TypeDefinitions.md:266`) |
| ② ASSIGN metadata | 〃 | `{ target_user_id: data.user_id }` 추가 (`:266` 형태와 일치, `data.user_id`는 이미 스코프 내) |
| ① 참여자 제거 | `removeParticipant` | `ActionType.DELETE` → `ActionType.UNASSIGN` (§6 `:192`) — §4 표에 UNASSIGN 예시 행이 없어 metadata는 추가하지 않음(지시 범위 내 명시된 것만) |
| 공용 헬퍼 | `emitParticipantSync(binderId, instanceId, context, action, metadata)` | `metadata` 선택 파라미터 추가(기존 함수 파라미터 확장 — 신규 구조 아님). 값이 있을 때만 `{ metadata }`를 spread |
| ④ 에러 문구 | `updateParticipantState` (구 `:158`) | `'타인 상태 변경 역할 기준이 확정되지 않았습니다'` → `'본인 상태만 변경할 수 있습니다'` (동작 변경 없음, 403 그대로). `eventService.js:228`의 동일 계약 문구와 통일 |

**② 상태 전이(`updateParticipantState`)의 `ActionType.UPDATE` → `STATE_UPDATE` 스왑과 그
metadata(`{"new_state": N}`)는 위 차단 사유로 미적용.**

## `feedHandler.js` — 손대지 않음 (③, 요구사항 그대로 미착수)

②가 막혀 있어 `taskService.js`는 여전히 상태 전이마다 `ActionType.UPDATE`를 방출한다.
이 상태에서 `feedHandler.js`에 `action_type === 'STATE_UPDATE'` 필터를 걸어도 실제로 걸러지는
것이 없어(현재 방출값은 `UPDATE`) **아무 효과 없는 죽은 필터**가 된다. 잘못된 안심을 주는
변경이라 보고만 하고 코드는 그대로 두었다. `notificationHandler.js`는 지시대로 손대지
않았다(팀장 정정 확인 — `sendSync`는 무음 데이터 메시지이고 `alert` 경로는 `taskService`에
없음, 재확인 완료).

## 클라이언트

읽기만 했다(`lib/core/constants/enums/activity_enums.dart:85-87`) — `stateUpdate`·`assign`·
`unassign` 이미 정의되어 있음을 재확인. 클라이언트 파일은 수정하지 않았다.

## 검증

- `node -c src/services/taskService.js` → `SYNTAX OK`. **이것은 구문 검사일 뿐이며 동작 검증
  근거로 제시하지 않는다** (지시대로).
- `git status --short` / `git diff -- src/services/taskService.js` 로 의도한 변경만 있는지
  확인 — 위 diff가 전부다.
- `npm test` — 실행하지 않음(placeholder, 성공 검증 불가로 기확인).
- **미검증**: 실제 `audit_logs`/`activity_feeds` 행에 `ASSIGN`/`UNASSIGN`과 metadata가 어떻게
  기록되는지는 로컬에 접근 가능한 Postgres가 없어 확인하지 못했다(`pg_isready` 명령 없음,
  `docker ps`도 데몬 미연결 — 지난 Task와 동일 환경 제약).
- `POST /tasks/:taskId/instances/:instanceId/participants`(addParticipant→ASSIGN),
  `DELETE .../participants/:userId`(removeParticipant→UNASSIGN) 호출 후
  `SELECT action_type, metadata FROM audit_logs WHERE target_type='TASK_PARTICIPANT' ORDER BY created_at DESC LIMIT 5;`
  로 리뷰어가 확인 가능하다.

## 변경 파일

- `application_server/src/services/taskService.js` (ASSIGN/UNASSIGN 스왑 + metadata + 에러 문구)

## 후속 작업 — 결정 요청

1. `ActionType.STATE_UPDATE`를 `typeDefinitions.js`의 freeze 객체에 추가할지 확정 요청.
   추가가 승인되면 ②(`taskService.js` 상태 전이 action_type 스왑 + `{"new_state": N}` metadata)와
   ③(`feedHandler.js`의 `STATE_UPDATE` 제외 필터)을 이어서 구현할 수 있다.
2. 승인 전까지는 Task 상태 전이(ready/inProgress/onHold/done)가 여전히 `ActionType.UPDATE`로
   `activity_feeds`에 기록된다 — §308 "activity_feed 생성 X" 위반이 아직 남아 있다는 점을
   명시해 둔다(단, 팀장 정정대로 알림/notifications 위반은 아님 — audit_log/feed 축만 해당).
