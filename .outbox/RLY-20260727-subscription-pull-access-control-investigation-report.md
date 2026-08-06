# RLY-20260727-subscription-pull-access-control Investigation Report (read-only)

- Role: backend (investigation only — 코드/문서 미수정)
- Agent: rally-backend (Claude-only 서브팀, Sonnet 5)
- 성격: 조사·보고만. **코드 변경 없음**(`git status --short` 확인 — 리뷰 대기 중인 기존 변경 그대로,
  본 보고서 파일 1개만 신규). 서버 기동·DB 접속 없음, 전부 정적 코드 읽기.

## 결론 요약

| 질문 | 판정 | 근거 |
|---|---|---|
| ① 서버가 비멤버 구독자에게 Event·Task를 보내는가 | **확인 — 보낸다.** 실접근 제어 위반 | `syncDAO.js:189-316`, `syncDAO.js:517-526` |
| ② `user_workflows.md` S2.3의 `c_ids` 서술이 서버 구현과 일치하는가 | **확인 — 일치한다.** 즉 서버는 `user_workflows.md`를 그대로 구현했고, 그 결과 `SC-subscribe.md`/`_common.md`와 어긋난다 | `user_workflows.md:340-356`, `:636-648` |
| ③ AC4(서버 최종인가)가 구독 캘린더 Event·Task에도 적용되는가 | **반증 — 적용되지 않는다.** AC4는 문서상 **private Section 전용**으로 범위가 명시돼 있고 구독 캘린더는 언급되지 않는다 | `design_intent.md:604`, `api.md:1464` |

---

## ① 서버 sync/pull이 비멤버 구독자에게 Event·Task row를 내려보내는가 — **확인, 보낸다**

### 1-1. 접근 가능 범위 산출 — `binder_members` + `calendar_subscriptions` 둘 다 사용

`src/services/syncService.js:34-38`:
```js
const [currDIds, currCIds] = await Promise.all([
  SyncDAO.getBinderIdsByUserId(pool, userId),
  SyncDAO.getSubscribedCalIdsByUserId(pool, userId),
]);
```

`src/daos/syncDAO.js:6-20`:
```js
static async getBinderIdsByUserId(pool, userId) {
  const { rows } = await pool.query(
    `SELECT binder_id FROM binder_members WHERE user_id = $1 AND deleted_at IS NULL`, [userId]
  );
  return rows.map(r => r.binder_id);
}
static async getSubscribedCalIdsByUserId(pool, userId) {
  const { rows } = await pool.query(
    `SELECT calendar_id FROM calendar_subscriptions WHERE user_id = $1 AND deleted_at IS NULL`, [userId]
  );
  return rows.map(r => r.calendar_id);
}
```

**`getSubscribedCalIdsByUserId`는 `binder_members`와 조인하지 않는다.** `calendar_subscriptions`
행이 있으면(멤버든 비멤버든) 그 `calendar_id`가 그대로 `currCIds`에 들어간다.

### 1-2. 구독 자체는 비멤버도 가능 — 유일한 게이트는 `is_public`

`src/services/calendarService.js:91-94`:
```js
async subscribe(calId, context) {
  const cal = await CalendarDAO.findById(pool, calId);
  if (!cal) throw new NotFoundError('캘린더를 찾을 수 없습니다');
  if (!cal.is_public) throw new ForbiddenError('공개 캘린더만 구독할 수 있습니다');
  const sub = await CalendarDAO.subscribe(pool, context.sender_id, calId);
  ...
```
`binder_members` 확인이 **없다** — 공개 캘린더면 바인더 멤버가 아닌 누구든(인증된 유저) 구독
가능. `api.md` §"POST /calendars/:calId/subscribe" 서술과 일치.

### 1-3. Event·Task 델타 쿼리가 `c_ids`를 `d_ids`와 대등하게 OR로 사용

`_fetchTrackBCalendar` (`syncService.js:151-167`)가 `SyncDAO.getEventsDeltaFull`·
`getEventInstancesDeltaFull`·`getEventParticipantsDeltaFull`·`getTasksDeltaFull`·
`getTaskInstancesDeltaFull`·`getTaskParticipantsDeltaFull`·`getSpecialDaysDeltaFull` 7개를 모두
같은 `ctx`(`oldCIds`/`newCIds` 포함, `syncService.js:48-51`)로 호출한다.

`src/daos/syncDAO.js` 실제 WHERE 절 (전부 직접 읽어 확인):

| 메서드 | 파일:행 | WHERE 조건 |
|---|---|---|
| `getEventsDeltaFull` | `:189-211` | `(c.binder_id = ANY($dIds) OR e.calendar_id = ANY($cIds))` |
| `getEventInstancesDeltaFull` | `:213-229` | 동일 패턴(OR로 cIds) |
| `getEventParticipantsDeltaFull` | `:231-248` | 동일 패턴 |
| `getTasksDeltaFull` | `:250-265` | 동일 패턴 |
| `getTaskInstancesDeltaFull` | `:267-283` | 동일 패턴 |
| `getTaskParticipantsDeltaFull` | `:285-302` | 동일 패턴 |
| `getSpecialDaysDeltaFull` | `:304-` (이하 동일 패턴, 316행까지) | 동일 패턴 |

7개 쿼리 **전부** `c.binder_id = ANY($dIds) OR e.calendar_id = ANY($cIds)` 형태다. **`is_public`
체크도, `casts`로 종류를 제한하는 필터도 이 7개 쿼리 어디에도 없다.** `event_participants`·
`task_participants`(참가자 개인정보 포함 — RSVP 상태·담당자)까지 동일 게이트로 내려간다.

### 1-4. 두 번째 경로 — 캘린더 무한스크롤 백필도 동일

`SyncService.fetchCalendarWindow`(`syncService.js:102-121`, `GET /sync` 계열의 별도 엔드포인트)도
`currCIds`를 `is_public`·binder membership 재확인 없이 그대로 사용:

`src/daos/syncDAO.js:517-526`:
```js
static async getCalendarDataOnlyByWindow(pool, ctx) {
  const query = `
    SELECT e.* FROM events e
    JOIN calendars c ON e.calendar_id = c.id
    WHERE (c.binder_id = ANY($1::uuid[]) OR e.calendar_id = ANY($2::uuid[]))
      AND e.deleted_at IS NULL
  `;
  const { rows } = await pool.query(query, [ctx.currDIds, ctx.currCIds]);
  return { events: rows };
}
```
(이 경로는 `events`만 반환하며 `tasks`를 위한 대응 window 메서드는 찾지 못했다 — §"미확인" 참조.)

### 판정 — ①

**서버가 보낸다.** 비멤버가 공개 캘린더를 구독하면(멤버십 검증 없이 가능), 그 캘린더의
`events`·`event_instances`·`event_participants`·`tasks`·`task_instances`·`task_participants`·
`special_days`가 **`GET /api/sync` pull과 캘린더 윈도우 백필 양쪽에서 전부** 그 사용자에게
내려간다. `SC-subscribe.md:487`·`_common.md:116-120`이 규정한 "비멤버 시야 = cast만"과 정면
배치되며, **실제 데이터 유출**이다(클라이언트 쿼리 위반과 별개로 서버가 먼저 보낸다).

---

## ② `syncToken`의 `c_ids` 처리 — `user_workflows.md` 서술과 서버 구현 일치 여부 — **확인, 일치한다**

`docs/user_workflows.md:340-356` (S2.3 — 자녀 학교 캘린더 구독, 외부 binder):
```
340: #### S2.3 — 자녀 학교 캘린더 구독 (외부 binder)
...
353: - `binder_members` INSERT 없음 (비멤버 — §5-30)
354: - `calendar_subscriptions` INSERT (선택 calendar만)
355: - Pull 시 syncToken에 `c_ids`에 학교 calendar 포함 → 학교 calendar의 events·instances 동기화
```

`docs/user_workflows.md:636-648` (S4.x, 반대 방향 — 외부인이 우리 캘린더 구독):
```
638: → 클라이언트가 본인 Rally 가입 → 본인 binder에서 "캘린더 구독"
639: → calendar_subscriptions INSERT (외부 user_id, 우리 calendar_id)
640: → 클라이언트가 자기 캘린더에 우리 외부 미팅 일정 통합 표시
641: → 클라이언트는 우리 binder 멤버 X → 우리 섹션·내부 calendar 접근 불가
642: → 미팅 RSVP는 불가 (event_participants는 binder 멤버 한정, 5-1 정책)
...
648: - Pull 시 외부 사용자의 syncToken `c_ids`에 우리 calendar 포함
```

**이 서술은 위 ①에서 직접 읽은 서버 구현과 정확히 일치한다** — `c_ids`가 그대로 events/instances
델타 쿼리에 들어가 비멤버에게 동기화된다는 문서 서술 그대로다. (단, `:642`의 "RSVP는 불가"는
`event_participants` 쓰기 권한 얘기이며, ①에서 확인한 대로 `event_participants` **읽기**는
`getEventParticipantsDeltaFull`을 통해 여전히 내려간다 — 문서도 읽기 차단은 서술하지 않는다.)

### 판정 — ②

**일치한다.** 즉 서버는 `user_workflows.md` S2.3/S4.x의 서술을 그대로 구현한 것으로 보이며,
**서버도 스펙과 어긋나 있다**는 팀장님의 가정이 맞다 — 다만 정확히는 "서버가 스펙과 어긋난다"가
아니라 **"스펙 문서 두 세트가 서로 어긋나 있고, 서버는 그중 `user_workflows.md` 쪽을 구현했다"**다.
`docs/standards/_common.md:116-120`·`docs/calendar/SC-subscribe.md:487`은 "비멤버=cast만"을
규정하는 반면 `user_workflows.md:355·648`은 "비멤버 구독자에게 events·instances 동기화"를
명시적으로 서술한다. 어느 쪽이 최신 확정인지는 문서 버전 이력만으로는 이번 조사에서 확정하지
못했다(양쪽 문서의 최종 개정일 대조는 미수행 — §"미확인" 참조). **이건 설계 판단이 필요한
지점이라 결론을 제가 내리지 않고 사실만 보고한다.**

---

## ③ 서버 최종 인가(AC4)가 구독 캘린더의 Event·Task에도 적용되는가 — **반증, 적용되지 않는다**

`AC4`를 저장소 전체에서 검색한 결과 두 곳에서만 발견됐다(`domain.md`에는 **없음** — 과제
설명이 인용한 출처가 실제로는 다른 파일임을 확인):

`docs/database/design_intent.md:604`:
```
| **AC4 서버 최종인가 범위** | private Section 의 모든 경로에서 서버 재판정 필수 — ①메타(목록·제목·존재)
②메시지 목록·단건 ③전송·수정·삭제 ④첨부 signed URL 발급(Section 접근 검사 — 첨부 존재만으로
부족) ⑤활동피드·대시보드 ⑥검색(비멤버 제외) ⑦알림·FCM(비멤버 미발송) ⑧content_links 참조
해석(비접근→403). 클라 차단=낙관적 UX뿐·서버가 인가 권위 |
```

`docs/server/api.md:1464`:
```
> **private Section 서버 최종인가 (AC4, 2026-07-23):** `access_scope=1`(private) Section 은
접근 판정식(...)을 서버가 전 경로에서 재판정한다 — ①메타 ②메시지 목록·단건 ③전송·수정·삭제
④첨부 signed URL 발급 ⑤활동피드·대시보드 ⑥검색 ⑦알림·FCM ⑧content_links 참조 해석(...)
```

**두 출처 모두 AC4를 명시적으로 "private Section"에 한정한다.** 8개 경로 목록(메타·메시지·
전송/수정/삭제·첨부·피드·검색·알림·content_links) 어디에도 "구독 캘린더"·"calendar_subscriptions"·
"Event"·"Task"라는 단어가 등장하지 않는다.

### 판정 — ③

**반증(적용되지 않는다).** AC4는 문서상 Section 접근 제어(그룹 기반 private Section)를 위해
만들어진 별개의 계약이며, 범위 목록에 구독 캘린더의 Event·Task가 포함돼 있지 않다. 이번 조사
범위(저장소 전체 grep + 두 출처 원문 직독)에서는 "구독 캘린더 Event·Task 서버 최종인가"에
해당하는 **AC4와 동급의 명시적 계약을 찾지 못했다** — 다시 말해 이 영역은 AC4 같은 기존 규정의
적용 대상에서 빠진 것이 아니라, **애초에 그런 규정 자체가 문서상 존재하지 않는 것으로 보인다**
(①에서 확인한 대로 실제 쿼리에도 그런 필터가 없다는 사실과 정합).

---

## 미확인 (시간·범위상 못 한 것, 추측하지 않고 명시)

- `user_workflows.md`와 `SC-subscribe.md`/`_common.md` 중 어느 쪽이 더 최근 확정본인지 —
  두 문서의 변경이력(changelog) 항목을 대조하지 않았다. `user_workflows.md:1745`에 2026-06-07
  changelog 항목은 확인했으나 S2.3/S4.x 서술 자체의 최종 수정일은 별도 확인하지 못했다.
  `SC-subscribe.md:487`·`_common.md:116-120`의 개정일도 대조하지 않았다.
- `casts_dao.dart`·`events_dao.dart`·`tasks_dao.dart`(클라이언트) — 팀장님이 이미 직접 확인했다고
  하셨고 이번 조사는 서버 쪽만 지시받아 클라이언트 코드는 열지 않았다.
- `getCalendarDataOnlyByWindow`에 대응하는 **Task 버전**(윈도우 백필로 tasks를 가져오는 메서드)이
  있는지 — `syncDAO.js` 전체를 훑었을 때 `getCalendarDataOnlyByWindow`는 `events`만 반환했고
  tasks 전용 대응 메서드는 발견하지 못했으나, "없다"를 확정하려면 클라이언트가 이 엔드포인트를
  어떻게 호출하는지까지 봐야 해서 미확인으로 남긴다.
- `binder_members`를 통한 멤버의 경우(비구독, 정상 멤버십) Event·Task 노출은 이번 조사 범위가
  아니라 재확인하지 않았다(그쪽은 원래도 `d_ids` 기준으로 정상 범위라고 가정하고 넘어갔다 —
  이 가정 자체도 이번에 별도 검증하지는 않았다).

## 변경 파일

없음. 본 보고서 1개만 신규 생성 (`application_server/.outbox/
RLY-20260727-subscription-pull-access-control-investigation-report.md`).
