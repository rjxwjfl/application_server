# RLY-20260726-undefined-method-audit Investigation Report (read-only)

- Role: backend (investigation only — 코드/문서 미수정)
- Agent: rally-backend (Claude-only 서브팀, Sonnet 5)
- 성격: 조사·보고만. **코드 변경 없음** — `git status --short` 로 작업 트리 무변경 확인 (본 보고서 파일 1개만 신규).

## 방법론 — 왜 스크립트를 여러 번 고쳤는지 먼저 밝힌다

이번 조사는 정적 grep이 아니라 **작은 read-only Node 스크립트**(`/private/tmp/.../scratchpad/`,
저장소 밖)로 진행했다. 처음 두 버전은 **오탐이 컸다**:

1. `src/daos/syncDAO.js`는 `static async method()` 문법을 쓰는데 첫 스크립트는 `async method()`만
   인식해 34개 오탐(전부 정상 코드를 결함으로 오판)을 냈다.
2. 컨트롤러 export 스타일이 파일마다 3가지로 달랐다(`{ name: fn }` 객체 리터럴 / `const name=...;
   module.exports={name}` shorthand / `const ctrl={...}; module.exports=ctrl`). 텍스트 정규식으로는
   신뢰할 수 없어 **실제로 `require()`해서 런타임 introspection**(`typeof mod[method] ===
   'function'`)으로 바꾼 뒤에야 오탐이 사라졌다.
3. 서비스 orphan(호출되지 않는 메서드) 탐지는 export 변수명 불일치·`this._x` 아닌 dispatch table
   참조(`webhookService.js`)·클래스 밖 헬퍼 함수 오인식(`mediaService.js`의 `if`문을 메서드로
   오판) 등으로 **끝내 신뢰할 만한 결과를 못 얻었다** — 이 부분은 항목별로 "미완료"로 명시한다.

**아래 "확인"으로 표시한 항목은 전부 스크립트 결과에 그치지 않고 해당 파일을 직접 열어(또는
`require()` 런타임 introspection으로) 재확인했다.** grep 추정과 직접 확인을 구분해 표기한다.

---

## ① 호출되지만 정의되지 않은 메서드 — 완료, 확인됨

**방법**: `src/services/*.js`의 `XxxDAO.method(...)` 및 `XxxService.method(...)` 호출을 전수
추출해 각 DAO/Service 파일의 실제 클래스 메서드(2단계: 정규식 추출 후 → `require()` 런타임
introspection으로 재검증)와 대조. `src/daos/*.js` 19개 파일, `src/services/*.js` 17개 파일 전수
스캔.

### 확정 결함 (직접 파일 열어 확인)

| # | 호출 지점 | 정의 존재 여부 | 실행 시 결과 | 영향받는 기능 | 심각도 |
|---|---|---|---|---|---|
| 1 | `eventService.js:1` `require('../daos/eventDAO')` + `daos/index.js:16` `require('./eventDAO')` | **파일명 대소문자 불일치.** 실제 파일은 `src/daos/eventDao.js`(소문자 `Dao`). `ls src/daos/` 로 확인 | macOS(APFS 기본 대소문자 무시)에서는 우연히 동작. **Cloud Run 배포 대상(Linux, ext4/overlay — 대소문자 구분)에서는 `require` 시점에 `MODULE_NOT_FOUND`.** 이 두 require 모두 파일 최상단(top-level)이라 **모듈 로드 자체가 실패** — 실제로 Linux에서 기동을 재현하지는 못했다(서버 기동 금지 제약, §"미검증" 참조). `Object.freeze` 급의 정적 사실은 확인, 배포 시 실제 크래시는 파일시스템 semantics로부터의 추정. | **binderService·eventService·groupService·sectionService 4개 서비스가 `require('../daos')`(집계 index)를 쓴다** — `daos/index.js` 로드 자체가 실패하면 이 4개 서비스를 require하는 모든 라우트 마운트가 연쇄 실패할 가능성이 높다(서버 전체 기동 실패 후보). | **Critical(추정 포함)** — 사실관계(파일명·require 경로)는 확인, "서버 전체가 못 뜬다"는 결론은 Node.js 표준 module 해석 규칙에 근거한 추정이며 Linux 환경에서 직접 재현하지 않았다. |
| 2 | `eventService.js:179` `EventDAO.softDeleteEventInstance(...)` | **없음.** `grep -n softDelete src/daos/eventDao.js` → `softDeleteEvent`만 존재, `softDeleteEventInstance` 0건 | `TypeError: EventDAO.softDeleteEventInstance is not a function` → 500 | `DELETE /events/:eventId/instances/:instanceId` — 반복 일정 특정 회차 삭제/스킵. 라우트 마운트 확인(`eventRoutes.js:12`) → 항상 도달·항상 실패 | **Blocker** — 재현 가능, 항상 발생(조건 없음) |
| 3-4 | `binderService.js:351,356` `BillingDAO.getBinderBoost(...)` (2회) | **없음.** `grep -n "Boost\|boost" src/daos/billingDAO.js` → 0건(대소문자 무관 전무) | `TypeError` → 500 | `GET /binders/:binderId/boost`·`GET .../boost/check` — Binder Boost(유료 구독) 상태 조회 전부. 라우트 확인(`binderRoutes.js:55-56`) | **Blocker(유료 기능)** — 재현 가능 |
| 5 | `binderService.js:370` `BillingDAO.transferBinderBoost(...)` | 없음(동일 확인) | `TypeError` → 500 | `PATCH /binders/:binderId/boost/transfer` — Boost 양도 | **Blocker(유료 기능)** |
| 6 | `binderService.js:380` `BillingDAO.cancelBinderBoost(...)` | 없음(동일 확인) | `TypeError` → 500 | `DELETE /binders/:binderId/boost` — Boost 구독 취소 | **Blocker(유료 기능)** |
| 7 | `binderService.js:362` `BillingService.verifyBinderBoost(...)` | **없음.** `grep -n verifyBinderBoost src/services/billingService.js` → 0건(호출부 1건만 존재) | `TypeError` → 500 | `POST /binders/:binderId/boost/verify-purchase` — Boost 구매 검증·활성화 | **Blocker(유료 기능)** |

**#3~7 종합**: `binderRoutes.js:55-59`에 마운트된 **Binder Boost 5개 엔드포인트 전부**가
`BillingDAO`/`BillingService`의 미정의 메서드를 호출해 예외 없이 전부 500이다. `billingDAO.js`에는
Boost 관련 메서드가 **단 하나도 없다**(스키마상 `binder_boosts` 테이블은 존재 — `docs/database/
schema.md` 확인 — DAO 구현만 누락). Binder Boost는 결제(유료) 기능이라 매출에 직결된다.

### 조사했지만 결함 없음 (확인됨)

- `src/services/*.js` 전체의 `XxxDAO.method()` 호출 중 위 표 밖의 호출은 전부 대응하는 DAO에
  정의돼 있었다(1차 정규식 스캔에서 `syncDAO.js`(34건) 오탐이 났으나, `static` 메서드 인식
  버그로 확인 후 재검사하여 **전부 정상**임을 확인 — `syncService.js`가 호출하는 `SyncDAO.*` 34개
  메서드 모두 `src/daos/syncDAO.js`에 `static async`로 정의돼 있음을 직접 열어 재확인).
- `src/routes/*.js` → 컨트롤러 방향은 ③에서 별도 기술(0건).

### 이번에 새로 확인한 것 (지난 Task 보고와 이어짐)

- `EventDAO.findParticipant`(지난 Task에서 발견·수정 완료)와 `EventDAO.softDeleteEventInstance`
  (지난 Task에서 발견만 하고 미수정, 이번에 재확인)는 **같은 파일의 같은 유형 결함**이다.
  이번 조사로 **`billingDAO`·`billingService` 쪽에서 동일 유형이 5건 더** 나왔다 — 팀장님 예상대로
  "체계적으로 훑은 적이 없어 더 있을 가능성이 높다"가 확인됐다.

---

## ② 존재하지 않는 필드 참조 — 부분 완료 (지정된 4곳만 상세 확인, 전수 스캔은 미시도)

**범위 고지**: ①·③에서 겪은 스크립트 신뢰성 문제(변수 흐름 추적·구조분해·spread 등을 텍스트
정규식으로 안정적으로 잡기 어려움) 때문에, ②는 팀장님이 이미 짚은 `eventService.js:102·122·
162·180` 4곳만 직접 열어 상세 확인했다. **그 외 서비스 파일들의 전수 스캔은 신뢰성 있는 방법을
찾지 못해 시도하지 않았다** — 아래 "미완료" 참조.

| 호출 지점 | 정의 존재 여부 | 실행 시 결과 | 영향받는 기능 | 심각도 |
|---|---|---|---|---|
| `eventService.js:102` `event.binder_id`(`updateEvent`) | **없음.** `EventDAO.findById` SELECT 목록(`eventDao.js:6-16`)에 `binder_id` 컬럼 없음(이벤트는 `calendar_id`만 가짐) | `undefined` 전파 → `eventBus.emit('sync', {binder_id: undefined, ...})`. **크래시는 아님** — `PATCH /events/:eventId`는 DB 갱신에는 성공. `audit_logs.binder_id`는 nullable(`schema.md:1030`)이라 **NULL로 조용히 삽입**됨(`auditHandler.js`에 binder_id 진위 체크 없음). `feedHandler.js`는 `if (!data.binder_id ...) return`로 **activity_feed는 조용히 미기록**. `notificationService.sendSync`는 `binder_undefined` FCM 토픽으로 발행 시도 → try/catch로 조용히 실패(로그만) | 이벤트 제목/설명/색상 수정 시: **DB는 정상 갱신되나, 감사 로그의 binder 귀속이 깨지고, activity feed에 안 남고, 다른 멤버에게 sync 알림이 안 감** | **Major** — 크래시는 아니지만 조용한 데이터 오염 + 협업 알림 무음 실패. 사용자는 "왜 다른 기기에 안 뜨지"로만 체감, 원인 추적 어려움 |
| `eventService.js:122` `instance.binder_id`(`updateEventInstance`) | 없음(동일 사유, `findInstanceById` SELECT에 `binder_id` 없음) | 위와 동일 패턴 | 이벤트 인스턴스(회차) 수정 시 동일 | **Major** |
| `eventService.js:162` `event.binder_id`(`deleteEvent`) | 없음(동일) | 위와 동일 패턴 | 이벤트 삭제 시 동일 | **Major** |
| `eventService.js:180` `instance.binder_id`(`deleteEventInstance`) | 없음(동일) — **단, 이 줄에 도달하기 전에 179행 `softDeleteEventInstance` 미정의로 항상 TypeError가 먼저 터진다(①-#2)**. 그래서 이 필드 문제는 **현재는 은폐되어 있다**(①-#2가 먼저 고쳐지면 그 즉시 이 필드 문제가 드러난다) | 현재는 도달 불가(①-#2가 선행 차단) | ①-#2 수정 시 함께 노출될 잠재 결함 | **Major(잠재)** — ①-#2 수정과 함께 처리 권장 |

### 미완료

- `eventService.js` 외 나머지 16개 서비스 파일에 대한 "DAO 반환 컬럼 ↔ 서비스 참조 필드" 전수
  대조는 시도했으나 신뢰할 만한 자동화 방법을 찾지 못해 **수행하지 못했다**. 수동으로 파일별
  대조가 필요하며, 이번 세션에서는 시간 배분상 ①을 우선했다.

---

## ③ 서비스 함수 ↔ 라우트 ↔ 컨트롤러 3자 대조 — 라우트→컨트롤러는 완료, 서비스 orphan은 미완료

### (a) 라우트에 컨트롤러 메서드가 없는 경우 — 확인됨, **0건**

**방법**: `src/routes/*.js`(19개, `index.js` 제외) 전체의 `router.get/post/patch/put/delete(...)`
마운트에서 참조하는 컨트롤러 메서드를, 텍스트 정규식이 아니라 **실제로 해당 컨트롤러 파일을
`require()`해 `typeof mod[methodName] === 'function'`로 런타임 확인**(export 스타일 3종 모두
안전하게 처리). **전 라우트 파일에서 결함 0건** — 마운트된 모든 핸들러가 실제 함수로 resolve됨.

### (b) 정의는 있으나 도달 불가능한 서비스 함수 (orphan) — **미완료, 신뢰 불가**

`rejectApply`·`restoreRejected`(지난 Task에서 발견·정리 완료)와 같은 유형을 다른 서비스에서도
찾으려 했으나, export 변수명 불일치(예: `authService.js`는 `module.exports = new AuthService()`로
소문자 인스턴스를 직접 export, 소비 측 변수명은 파일마다 제각각) · dispatch table을 통한 간접
호출(`webhookService.js`의 `this._appleHandlers = { SUBSCRIBED: this._appleSubscribed, ... }`) ·
클래스 밖 순수 함수를 메서드로 오인식(`mediaService.js`) 때문에 **스크립트 결과에 40개 "후보"가
나왔으나 거의 전부 오탐으로 판단, 신뢰할 수 없어 보고에서 제외했다.** 이 하위 항목은 **수행하지
못한 것으로 명시**하며, 수동 검토가 필요하다.

---

## ④ 규격이 지정한 분기를 구현이 차단하는 사례 — 미완료, **미검증 후보 목록만**

**방법**: `!== context.sender_id` 계열 가드를 `src/services/*.js`에서 grep했다. **문서
(`domain.md`·`SC-*.md`) 대조는 하지 않았다** — 시간 배분상 시도하지 못했다. 아래는 **추정
후보일 뿐 확인된 결함이 아니다.**

| 파일:행 | 패턴 | 비고 |
|---|---|---|
| `castService.js:67,90` | `member.role > 1 && cast.author_id !== context.sender_id` | 이미 role OR author 조합 — 관리자 우회 있음. 규격 일치 여부 미대조 |
| `castService.js:143,152` | `comment.user_id !== context.sender_id` (단독) | 댓글 수정·삭제 — cast 댓글에 master/manager 대리 편집 권한이 규격에 있는지 미대조 |
| `postService.js:57,81,138,229` | `post.author_id`/`comment.user_id !== context.sender_id` | 일부는 `role > 1` OR 조합 있음(`:57,81`), 댓글 쪽(`:138,229`)은 단독 조건으로 보임 — 미대조 |
| `messageService.js:108` | `message.user_id !== context.sender_id`(단독) | 메시지 수정 — master/manager 대리 수정 허용 여부 미대조. api.md 상 메시지 수정 권한 정책 직접 확인 필요 |
| `taskService.js:135,186` | `... !== context.sender_id && actor.role > 2` | **이미 role OR 조합**(editor 이상 대리 가능) — 정상으로 보이나 문서 대조는 안 함 |
| `taskService.js:160` | `userId !== context.sender_id`(단독) | **팀장님이 이미 `domain.md §3-5(11)` 기준 정상으로 확정한 항목** — 재확인만, 결함 아님 |

**결론**: 위 목록 중 `messageService.js:108`과 `castService.js:143·152`, `postService.js:138·229`
(댓글 수정·삭제류, 전부 단독 `!==` 조건)가 조사할 가치가 가장 커 보이지만 **이것은 근거 없는
직감이며 문서 대조 전까지는 결함이라 부를 수 없다.** 후속 조사가 필요하다.

---

## 종합 — 우선순위

| 순위 | 항목 | 상태 | 즉시 영향 |
|---|---|---|---|
| 1 | `eventDAO` require 대소문자 불일치 (①-#1) | 확인(사실) + 추정(배포 영향) | Linux 배포 시 서버 전체 기동 실패 가능성 — **가장 급함** |
| 2 | Binder Boost 5개 엔드포인트 전멸 (①-#3~7) | 확인 | 유료 기능 100% 불능 |
| 3 | `EventDAO.softDeleteEventInstance` 미정의 (①-#2) | 확인(지난 Task 재확인) | 반복 일정 회차 삭제 500 |
| 4 | `eventService.js` 4곳 `binder_id` undefined (②) | 확인 | 조용한 감사·피드·알림 무음 실패 (크래시 아님) |
| 5 | ③(b) 서비스 orphan 전수, ④ 문서 대조 | **미완료** | 후속 조사 필요 |

## 검증 방법 요약

- ①: 정규식 추출 + 직접 파일 열람(전 6~7건 각각 `grep`/`Read`로 재확인) + Service→Service 건은
  `require()` 런타임 introspection으로 교차검증.
- ③(a): `require()` 런타임 introspection — 서버 기동·DB 접속 없이 모듈 로드만 수행(요청된
  read-only 제약 준수).
- ②: 지정된 4곳만 스키마(`schema.md`)·핸들러 코드(`auditHandler.js`·`feedHandler.js`·
  `notificationService.js`) 직접 대조.
- **실행하지 않은 것**: 서버 기동, DB 접속, 마이그레이션, Linux 컨테이너에서의 실제 재현 — 전부
  지시대로 하지 않았다. ①-#1의 "서버 전체 기동 실패" 결론은 파일시스템 사실 확인 + Node.js
  표준 module 해석 규칙에 근거한 **추정**이며, 실제 재현은 하지 못했다(재현하려면 Linux 환경이
  필요하고 이는 조사 범위 밖).

## 변경 파일

- 없음. 본 보고서(`application_server/.outbox/RLY-20260726-undefined-method-audit-investigation-report.md`)
  1개만 신규 생성.
