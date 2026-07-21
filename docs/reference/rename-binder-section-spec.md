# Canonical Rename Spec — Drawer→Binder / Series→Section

> **상태: 확정 실행 스펙(authoritative design_source).** Writer 는 즉흥 치환 없이 **본 문서만** 따른다.
> **범위**: 클라이언트 저장소(본 repo) + 문서. 서버 코드는 별도 저장소(§7-C) — wire 계약 lockstep.
> **정책 근거**: 출시 전 clean-install(schemaVersion=1·데이터 이관 없음) → 물리 리네임 안전. 정수 enum 값 고정.
> **User 확정(Gate)**: D-R1=A(물리 전면)·D-R2 정수유지·문자열 리네임·D-R3 관계테이블 물리·**D-R4 단일 전면 pass(Drawer+Section 동시, 2026-07-21 재확정 — 구 2-pass 폐기)**·D-R5 lockstep·D-R6 AST 강제.
> **base commit**: 클라이언트 현행 HEAD (Custodian 이 worktree 시 정확 hash 고정).
> **분리 유지**: content_links(참조 계약)·연락처/주소록 트랙과 절대 혼합 금지. 본 스펙은 **순수 리네임**(행위 변화 0).

---

## 0. 불변 원칙
1. **행위 변화 0** — 리네임만. 로직·시그니처 의미·정수 enum 값·wire 구조 불변(이름만 변경).
2. **정수 enum 값 고정** — TargetType/ActionType 정수 매핑 유지, 문자열 라벨만 변경.
3. **generated 수기편집 금지** — `*.g.dart`·`app_localizations*.dart` 는 소스 리네임 후 **재생성**(§7-E).
4. **Flutter `Drawer` 위젯 불가침**(§6) — 텍스트 치환 금지, AST/symbol-rename 강제.
5. **CHANGELOG 이력 보존** — 과거 이력행의 구 명칭은 당시 사실이므로 보존, 현재형 서술만 개정.
6. **불변 도메인**: Post·Cast·Calendar·SpecialDay·Event·Task·User 명칭 유지. 단 이들이 보유한 `drawer_id`·`series_id` **참조 컬럼/필드는 리네임 대상**.

---

## 1. DB 물리 리네임 (schema.md · design_intent.md)

### 1-1. 테이블
| old | new |
|---|---|
| `drawers` | `binders` |
| `drawer_settings` | `binder_settings` |
| `drawer_members` | `binder_members` |
| `drawer_invitations` | `binder_invitations` |
| `drawer_join_requests` | `binder_join_requests` |
| `drawer_boosts` | `binder_boosts` |
| `drawer_storage_usage` | `binder_storage_usage` |
| `series` | `sections` |
| `series_messages` | `section_messages` |
| `series_message_cursors` | `section_message_cursors` |
| `event_series` | `event_sections` |
| `task_series` | `task_sections` |

> `message_embeds`·`message_reactions`·`message_mentions`·`message_polls`·`poll_options`·`poll_votes` 는 **테이블명 불변**(message 개념 유지, `message_id` FK 는 참조 대상만 `series_messages`→`section_messages` 로 갱신).

### 1-2. 컬럼 (전역 규칙)
- **모든 `drawer_id` → `binder_id`** (denormalized 소비 테이블 포함: `calendars`·`attachments`·`posts`·`casts`·`special_days`·`notifications`·`audit_logs`·`activity_feeds`·`calendar_subscriptions`·`drawer_boosts`·`series` 등 전부).
- **모든 `series_id` → `section_id`** (`event_series`·`task_series`·`series_messages`·`series_message_cursors`).
- `message_id`·`parent_id`·`pinned_by_user_id` 등 기타 컬럼 불변.

### 1-3. 제약(FK)·인덱스 — 명칭 규칙 + 명시 매핑
**규칙**: 리터럴 워드 토큰(`drawer→binder`, `series→section`)과 아래 약어 매핑을 적용. `message_*` 자식(me/mr/mm/mp) FK **명칭 불변**(참조 대상만 갱신).

**약어 매핑**: `ds→bs`·`dm→bm`·`di→bi`·`djr→bjr`·`db→bb`·`dsu→bsu` / `sr→sec`·`sm→scm`·`smc→scmc`·`es→esec`·`tsr→tsec`.

| old | new |
|---|---|
| `fk_ds_drawer` | `fk_bs_binder` |
| `fk_dm_drawer` | `fk_bm_binder` |
| `fk_di_drawer` | `fk_bi_binder` |
| `fk_djr_drawer` | `fk_bjr_binder` |
| `fk_db_drawer` | `fk_bb_binder` |
| `fk_dsu_drawer` | `fk_bsu_binder` |
| `fk_cal_drawer` | `fk_cal_binder` |
| `fk_att_drawer` | `fk_att_binder` |
| `fk_p_drawer` | `fk_p_binder` |
| `fk_af_drawer` | `fk_af_binder` |
| `fk_sr_drawer` | `fk_sec_binder` |
| `fk_es_event` | `fk_esec_event` |
| `fk_es_series` | `fk_esec_section` |
| `fk_tsr_task` | `fk_tsec_task` |
| `fk_tsr_series` | `fk_tsec_section` |
| `fk_sm_series` | `fk_scm_section` |
| `fk_sm_user` | `fk_scm_user` |
| `fk_sm_parent` | `fk_scm_parent` |
| `fk_sm_pin_user` | `fk_scm_pin_user` |
| `fk_smc_series` | `fk_scmc_section` |
| `fk_smc_user` | `fk_scmc_user` |
| `idx_drawers_sync` | `idx_binders_sync` |
| `idx_drawer_settings_sync` | `idx_binder_settings_sync` |
| `idx_drawer_members_sync` | `idx_binder_members_sync` |
| `idx_drawer_members_user` | `idx_binder_members_user` |
| `idx_inv_drawer` | `idx_inv_binder` |
| `uq_djr_pending` | `uq_bjr_pending` |
| `idx_djr_blocked` | `idx_bjr_blocked` |
| `idx_att_drawer` | `idx_att_binder` |
| `idx_att_sync` | (불변 — drawer/series 토큰 없음) |
| `idx_p_drawer_recent` | `idx_p_binder_recent` |
| `idx_p_drawer_pinned` | `idx_p_binder_pinned` |
| `idx_p_drawer_public` | `idx_p_binder_public` |
| `idx_al_drawer` | `idx_al_binder` |
| `idx_feed_drawer_cursor` | `idx_feed_binder_cursor` |
| `idx_series_sync` | `idx_sections_sync` |
| `idx_sm_sync` | `idx_scm_sync` |
| `idx_smc_sync` | `idx_scmc_sync` |
| `chk_att_context` (값 `SERIES_MESSAGE`) | 명칭 불변·CHECK 값 `SECTION_MESSAGE`(§2) |

> `idx_calendars_sync`·`idx_boost_payer`·`idx_boost_expiry` 등 drawer/series 리터럴 없는 명칭은 불변(단 컬럼 `drawer_id`→`binder_id` 정의는 갱신). **미열거 `fk_*_drawer`/`idx_*drawer*`/`*_series*` 는 위 규칙을 기계적으로 동일 적용.**

---

## 2. Enum 문자열 (정수 고정) — TypeDefinitions v4 · attachments context_type

| 정수 | old 문자열 | new 문자열 |
|---|---|---|
| 20 | `DRAWER` | `BINDER` |
| 21 | `DRAWER_MEMBER` | `BINDER_MEMBER` |
| 22 | `DRAWER_SETTING` | `BINDER_SETTING` |
| 23 | `DRAWER_INVITATION` | `BINDER_INVITATION` |
| 40 | `SERIES` | `SECTION` |
| 41 | `SERIES_MESSAGE` | `SECTION_MESSAGE` |
| 53 | `EVENT_SERIES` | `EVENT_SECTION` |
| 63 | `TASK_SERIES` | `TASK_SECTION` |
| (billing) | `DRAWER_BOOST` | `BINDER_BOOST` |

- **정수값 절대 불변** — clean-install 라 재번호 불요·금지.
- **attachments `context_type`**: `'SERIES_MESSAGE'` → `'SECTION_MESSAGE'` (schema `chk_att_context` CHECK·media.md·domain.md §3-7·클라 `AttachmentModel.contextType` 비교 문자열·`context_type` 페이로드 전부).
- **ActionType payload 키**: `drawer_id` → `binder_id`(§246-273 예시·페이로드 JSON).
- TypeDefinitions v4 정수 매핑 표(`WHEN 20 THEN 'DRAWER'` 등) 문자열만 교체.

---

## 3. API path / wire

| old | new |
|---|---|
| `/drawers` | `/binders` |
| `/drawers/{id}/members\|settings\|invitations\|join-request\|calendars\|posts\|boost` | `/binders/{id}/...` |
| `/drawers/{id}/series` | `/binders/{id}/sections` |
| `/series` | `/sections` |
| `/series/{id}/messages\|cursor\|messages/{mid}/pin\|reactions\|polls` | `/sections/{id}/messages...` |
| snake 필드 `drawer_id` | `binder_id` |
| snake 필드 `series_id` | `section_id` |

- 클라 `core/constants/api_constants.dart` 의 20+ path builder·상수(`drawers`·`series`·`drawerById`·`seriesById`·`seriesMessages`·`drawerSeries`·`drawerMembers`… → `binders`·`sections`·`binderById`·`sectionById`·`sectionMessages`·`binderSections`·`binderMembers`…) 전면.
- 요청/응답 DTO 의 snake `@JsonKey`/`fieldRename.snake` 대상 필드(`drawer_id`·`series_id`) → wire 변경 → **서버 lockstep(§7-C)**.
- `docs/server/api.md`·`transport.md` 경로·필드·예시 동시 개정.

---

## 4. Dart 식별자 cascade (접두/접미 규칙 + 핵심 목록)

**규칙**: 식별자 내 `Drawer`→`Binder`, `Series`→`Section`, `drawer`→`binder`, `series`→`section`, `SeriesMessage`→`SectionMessage`, `DrawerMember`→`BinderMember`. **단 §6 Flutter 예외 준수**.

**Binder 계열(대표)**: `DrawerModel→BinderModel`·`DrawerMemberModel→BinderMemberModel`·`DrawerRole→BinderRole`·`DrawerBoostModel→BinderBoostModel`·`DrawerSettings*`·`DrawerInvitation*`·`DrawerJoinRequest*`·`DrawerPreview*`·`DrawerSnapshot`·`DrawerSummaryModel`·`DrawerInfoModel`·`DrawerCurrentUserModel`·`DrawerWithCalendars`·`UserDrawerData→UserBinderData`·`DrawersDao→BindersDao`·`DrawersApi→BindersApi`·`DrawerRepository→BinderRepository`·`drawer_enums.dart→binder_enums.dart`·`drawerProvider*→binderProvider*`·route `/drawer/:id→/binder/:id`·`drawer/` 화면 폴더·필드 `drawerId→binderId`.

**Section 계열(대표)**: `SeriesModel→SectionModel`·`SeriesMessageModel→SectionMessageModel`·`SeriesDraftModel→SectionDraftModel`·`SeriesSummary→SectionSummary`·`SeriesActivityModel→SectionActivityModel`·`SeriesRepository→SectionRepository`·`SeriesDao→SectionDao`·`SeriesApi→SectionApi`·`series_enums.dart→section_enums.dart`·`SeriesMessageCursors→SectionMessageCursors`·`series/` 화면·route `/series→/section`·`seriesProvider*→sectionProvider*`·필드 `seriesId→sectionId`·Drift 테이블 클래스 `Series→Sections`·`SeriesMessages→SectionMessages`·`Drawers→Binders`·관계 테이블 참조 `event_series/task_series→event_sections/task_sections`.

> Drift 로컬 테이블 클래스명(`class Drawers`·`class Series`·`class SeriesMessages`)·`.references(Drawers,...)`·`.references(Series,...)` 전부 갱신. app_database schemaVersion **1 유지**.

---

## 5. l10n 키 규칙

- 키: `drawerX→binderX`, `seriesX→sectionX` (예: `seriesErrorDefaultProtected→sectionErrorDefaultProtected`, `drawerCreateTitle→binderCreateTitle`).
- **canonical 영문 값**: "Binder", "Section" (표시 문자열의 "Drawer"/"Series" → "Binder"/"Section", 한/일 번역도 동반 갱신: 서랍→바인더, 시리즈→섹션 대응 번역).
- 소스 = `app_{ko,en,ja}.arb` 3파일. `app_localizations*.dart` 는 `flutter gen-l10n` **재생성**(수기편집 금지).

---

## 6. ⚠️ Flutter `Drawer` 위젯 예외 (불가침) + AST 절차

### 6-1. 절대 불변(프레임워크 API — 리네임 금지)
`Drawer(` · `Scaffold(drawer:` · `Scaffold(endDrawer:` · `endDrawer:` · `DrawerHeader` · `NavigationDrawer` · `openDrawer()` · `closeDrawer()` · `DrawerButton` · `ScaffoldState.openDrawer` · `DrawerHeader`/`AboutListTile` 등 material `Drawer*` 심볼.

### 6-2. 혼재 파일 규칙("클래스명 변경 + Flutter 호출 보존")
`lib/presentation/screens/home/widgets/app_drawer.dart`·`drawer_body.dart`·`navigation_shell.dart`·`custom_app_bar.dart`·`drawer_select_sheet.dart`·`drawer_option.dart` 등:
- Rally 도메인 클래스/변수/파일명(`AppDrawer`·`DrawerBody`·`drawer_*` provider·`drawerId`) → Binder 계열 리네임.
- 동일 파일 내 Flutter `Drawer(`·`Scaffold(drawer:`·`endDrawer`·`DrawerHeader` 호출 → **원형 보존**.
- 판단 애매 시 좁게 보존하고 리뷰로 승격.

### 6-3. AST/symbol-rename 강제 절차 (D-R6)
1. 텍스트 전역 치환 **금지**. IDE/도구 **symbol rename**(Dart Analysis Server rename refactor) 또는 AST 기반 codemod 사용.
2. `Drawer`/`series` 심볼은 **선언 위치 기준**으로 rename(Rally 선언 심볼만 선택, 프레임워크 심볼 제외).
3. 각 파일 rename 후 `dart analyze` 무오류 확인. Flutter `Drawer` 참조가 rename 에 딸려가지 않았는지 diff 검수.
4. `Series` 는 프레임워크 충돌 없음 — 표준 symbol rename 진행.

---

## 7. 작업 분해 — 단일 전면 pass (Drawer+Section 동시)

**단일 리네임 전용 커밋**으로 `Drawer→Binder`·`Series→Section` 을 **동시** 적용한다(로직 무변경). 절차: 소스 symbol-rename → generated 재생성 → `dart analyze`/test green → 커밋.

> **2-pass 폐기 사유(2026-07-21 재확정)**: (1) 도메인 `Drawer`(`DrawerModel`·`drawer_id`·`/drawers`)와 Flutter `Drawer` 위젯(`Scaffold(drawer:)`·`AppDrawer`)은 **완전 별개 식별자 공간**이라 symbol-rename 충돌 없음 → 2-pass 의 핵심 근거(Flutter 충돌 집중) 무효. (2) `binder_id`·`section_id` 가 전 파일에 공존해 두 도메인 pass 의 대상 파일이 거의 완전 중첩 → **분리 격리 이득 0**, cycle·generated 재생성만 2배. (3) 위험분산은 custodian `dart analyze`/test + reviewer 잔여-0·diff-rename-only 교차검증으로 대체. (4) 서버 단일 컷오버와 **wire lockstep** — 분할 시 중간 구간 `section_id`/`/sections`/`SECTION_MESSAGE` 필드 불일치. ⇒ 클라·서버 모두 단일 전면 pass.

### 7-A. client-domain 범위 (writer: client-domain)
`lib/domain/model/**`·`domain/repository/**`·`domain/sync/**`·`data/dto/**`·`data/mappers/**`·`data/sources/local/{tables,daos}/**`·`data/sources/remote/apis/**`·`core/constants/enums/{drawer,series}_enums.dart`·`core/constants/api_constants.dart`·`core/di/**`. (Drift 테이블 클래스·DAO·DTO snake 필드·enum·API 상수·repository·sync handler.)

### 7-B. client-ui 범위 (writer: client-ui)
`lib/presentation/**`(screens·widgets·controller)·`core/configs/routes/routes.dart`·route path·`lib/l10n/app_{ko,en,ja}.arb`. §6 Flutter 예외 준수.

### 7-C. backend 범위 (서버 저장소 — 별도)
서버 코드는 **본 repo 부재**. 서버 저장소에서 endpoint 경로·모델·DDL·enum·wire 필드를 본 §1~3 매핑으로 동일 적용. 서버도 **단일 전면 pass**로 진행. **client §3(wire) 과 원자적 동시 컷오버** — snake 필드·경로·enum 문자열을 양측 단일 pass 로 동시 전환. 조율 창구 = Orchestrator.

### 7-D. 문서 범위 (Architect)
`docs/**` 56파일. 우선순위: `schema.md`·`design_intent.md`·`TypeDefinitions.md`·`api.md`·`transport.md`·`architecture.md`(계약) → `_common.md`(계층도·**§3-3 "SeriesMessage 네이밍 통일"→"SectionMessage"** 규칙 개정, 구 `Comment→SeriesMessage` 이력 보존) → `domain.md`·SC 파일(`SC-series-manage`·`SC-member-manage`·`SC-messaging` 등)·`specs_index`·`user_workflows`. CHANGELOG 이력행 구 명칭 보존.

### 7-E. 공유 파일·순서·경합 회피
1. **순서(단일 pass 내)**: enum 파일 + `api_constants.dart` + `core/di` **먼저**(foundation) → domain(7-A) → ui(7-B). 공유 foundation 을 먼저 확정해 하위 conflict 최소화.
2. **generated(`*.g.dart`·`app_localizations*.dart`)**: 소스 리네임 완료 **후 일괄 재생성**(`dart run build_runner build --delete-conflicting-outputs` + `flutter gen-l10n`). 수기편집·중간 재생성 금지.
3. **lease 경합**: 단일 pass 이므로 **도메인 분리 불요**(Drawer·Section 동시). client-domain·client-ui 는 파일 경계로 분리(위 7-A/7-B) → 동시 작업 가능. 단 `api_constants.dart`·enum 은 domain lease 선점(ui 는 이후).
4. **compile gate**: 단일 pass = 소스 rename(Drawer+Section) → 재생성 → `dart analyze` green → 테스트 → 커밋.

---

## 8. 되돌림 안전성
- 순수 리네임·rename 전용 단일 커밋·행위 변화 0 → `git revert` 로 전체 기계적 복원.
- 리스크: §6 Flutter 충돌 수기편집·generated 재생성. 안전조건: (1) rename 전용 커밋 분리 (2) 단일 pass full compile+test (3) diff 에서 프레임워크 `Drawer` 미변경 확인.
- 로직 무변경 단일 커밋이므로 부분 롤백 불요 — 필요 시 전체 revert 로 복원.

---

## 9. 완료 판정 체크리스트 (단일 pass)
- [ ] 대상 심볼 잔존 0 (`Drawer`(Rally)·`Series` grep, Flutter 예외 제외).
- [ ] `dart analyze` 무오류 · 테스트 green.
- [ ] generated 재생성 완료 · 수기편집 흔적 없음.
- [ ] Flutter `Drawer`/`Scaffold(drawer:` diff 무변경.
- [ ] wire(경로·snake 필드·enum 문자열) client↔server 정합(§7-C).
- [ ] 문서 현재형 서술 정합 · CHANGELOG 이력 보존.
