# Rally — 서버 (Node.js/Express)

> 이 문서는 **명령을 치면 무엇이 되는지**를 적는다. "무엇이 있다/없다"로 적으면 낡는다 —
> 아래 수치는 2026-08-08에 이 워크스페이스에서 직접 돌려 확인한 결과다.

## 1. 실행 전 필요한 것

| 필요한 것 | 확인 |
|---|---|
| Node.js | `node --version` → 이 워크스페이스에서 실측: **v23.10.0**. `package.json`에 `engines` 필드가 없어 코드로 강제되는 최소 버전은 없다 — 실측값을 기준으로 삼는다 |
| PostgreSQL | 접속 정보를 `.env`에 채운다(§2). 스키마 DDL은 [`config/schema.sql`](config/schema.sql) — `notifications`·`audit_logs`·`activity_feeds`는 `PARTITION BY RANGE`(연도별 파티션)를 쓴다 |
| `.env` | `.env.example`을 복사해서 채운다: `cp .env.example .env`. **`.env.example`을 직접 고치지 마라** — 실제 값은 `.env`에만 넣고, `.env`는 `.gitignore`가 무시한다(`.env.example`은 무시하지 않는다 — `git check-ignore`로 확인함) |

`npm install`로 의존성을 받는다. `devDependencies`에 있는 `eslint`도 이때 함께 설치된다.

## 2. ⚠️ 처음 30분 안에 막히는 것 — `.env` 필수 항목 하나만 빠져도 즉사

`src/configs/index.js`가 module-load 시점에 동기적으로 `./db`·`./firebase`를 require하고, `server.js`가 이 require를 `startServer()`의 try/catch **바깥**(4번째 줄)에서 실행한다. 그래서 아래 필수 항목 중 하나라도 없으면 **콘솔 로그 한 줄 없이 uncaught exception으로 프로세스가 즉시 죽는다**(RLY-20260806-199 실측 — RLY-20260806-147이 처음 발견한 것과 같은 벽).

**필수** (`.env.example`의 "필수" 절 참고):
- dev(기본값, `NODE_ENV` 미설정 포함): `PGHOST`·`PGUSER`·`PGPASSWORD`·`PGDATABASE`
- prod(`NODE_ENV=production`일 때만): `DB_HOST`·`DB_USER`·`DB_PASSWORD`·`DB_NAME`
- 공통: `FIREBASE_PROJECT_ID`

나머지는 전부 코드에 기본값이 있거나(`PORT`·`DB_PORT`·`CORS_ORIGINS`·`GCS_BUCKET_*`·`TRUST_PROXY_HOPS` 등) 특정 기능(Apple/Google 웹훅 검증·앱 버전 게이트·공휴일 배치 등)에만 쓰여 없어도 서버 자체는 뜬다 — `.env.example`에 필수/선택을 나눠 적어 뒀다.

## 3. 명령 세 개

이 워크스페이스에서 직접 실행해 확인한 수치다:

| 명령 | 결과 |
|---|---|
| `npm test` | **91/91 pass** |
| `npm run test:drift` | **PASS=3345 FAIL=0** |
| `npx eslint .` | **exit 0** |

⚠️ **`npm test`는 두 관행을 함께 돌린다** — `src/**/*.test.js`(66개, 플레인 `assert` + 헬퍼 카운터 관행)와 최상위 `tests/*.test.js`(24개, `node:test`의 네이티브 `describe`/`it` 관행)가 서로 다른 스타일로 섞여 있다. RLY-20260806-199 이전엔 `npm test`가 `echo "Error: no test specified"`뿐이었고, 고친 뒤에도 처음엔 `src/`만 글롭에 넣어 `tests/`의 24건을 놓칠 뻔했다. **한쪽만 돈다고 믿으면 24건이 조용히 빠진다** — `package.json`의 `"test"` 스크립트에 두 글롭이 모두 있는지 항상 확인한다.

## 4. 스키마 대조 장치 — `allDaoSchemaColumnRegression.test.js`

이 저장소의 핵심 안전장치다. `npm run test:drift`(= `node src/daos/allDaoSchemaColumnRegression.test.js`)로 실행한다 — **이름을 모르면 못 돌린다**(다른 66+개 회귀 파일 사이에 파묻혀 있다). 소스 코드의 SQL이 참조하는 컬럼과 `config/schema.sql`의 실제 스키마를 대조해 3345건을 단언한다.

⚠️ **`_writeGapKnownIssues`와 `_writeGapWhitelist`를 섞으면 자가검증이 깨진다**:
- `_writeGapWhitelist` = **의도적으로 안 써지는 컬럼**(결함 아님 — 사유 태그가 붙어 있다)
- `_writeGapKnownIssues` = **실제 결함인데 이번 범위 밖이라 지금 안 고친 것**

새 컬럼을 어느 쪽에 넣을지 헷갈리면 멈추고 파일 상단 주석부터 읽는다 — 잘못 넣으면 실제 결함이 "정상"으로 위장되거나, 정상 상태가 "결함"으로 계속 보고된다.

## 5. 미구현 endpoint · 죽은 코드 (RLY-20260806-199 실측)

| 위치 | 무엇 | 상태 |
|---|---|---|
| `src/services/binderService.js` | `checkBoost`·`verifyBoost`·`transferBoost`·`cancelBoost` | **501을 명시적으로 반환한다**(주석에 이유 있음 — Boost 구매 흐름 전체 미구현) |
| `src/services/specialDayService.js` | `getByCalendar(calId, userId)` | **죽은 메서드** — 이 메서드를 호출하는 controller·route가 코드베이스 어디에도 없다(grep 0건). `userId` 인자가 본문에서 인가 검사에 안 쓰이는데, 지금은 아무도 안 불러서 보안 결함은 아니다 — **나중에 라우트를 연결할 때 인가를 빠뜨리기 쉬운 자리**로 코드에 표시해 뒀다 |

## 6. 테스트가 안 도는 영역

아래는 어떤 회귀 테스트 파일에도(스키마 대조 장치 제외) 걸리지 않는다 — **여기를 고치면 무엇을 깼는지 알려줄 안전망이 없다**:

- `src/services/authService.js`
- `src/services/webhookService.js`
- `src/daos/auditDAO.js`

(측정 방법: 각 파일의 클래스명이 `allDaoSchemaColumnRegression.test.js`를 제외한 어떤 테스트 파일에도 등장하지 않음을 확인 — 이 저장소는 배럴 임포트·서비스 경유 간접 구동을 광범위하게 써서 단순 `require()` 경로 매칭은 오탐이 많다.)

## 7. ⚠️ `require()`가 로드베어링인 자리 — 정리하다 똑같이 밟는다

`src/daos/deleteCascadeRegression.test.js:309` 부근: 반환값을 쓰지 않는 `require('../services/calendarService');`가 있다. "안 쓰니 지워도 된다"고 지웠다가 테스트가 실제로 깨졌다(RLY-20260806-199) — 이 require의 진짜 역할은 반환값이 아니라 **`require.cache` 재적재라는 부작용**이다. `calendarService.js`가 내부적으로 require하는 `withTransaction.js`는 **자기 자신이 처음 로드되는 시점에 `pool`을 캡처**하고, 그 캐시가 별도로 지워지지 않는 한 재바인딩하지 않는다 — 이 저장소의 가짜 DB 테스트 관행에서는 `require()`의 반환값이 미사용이어도 호출 자체가 로드-베어링일 수 있다는 뜻이다. 비슷한 "안 쓰는 것 같은" require를 지울 땐 지우기 전후로 전체 스위트(`npm test`)를 돌려 확인한다.

## 8. `git stash` 금지

이 워크스페이스는 `git worktree`다 — worktree들은 `.git`을 공유해 **stash 스택이 저장소 전체에 하나**다. 한 worktree에서 stash한 걸 다른 worktree에서 pop하면 남의 작업을 가져온다.

## 9. 더 넓은 인계 맥락

서버 하나로 좁혀지지 않는 것(출시 전 확인 필요 항목·이유를 모르면 되돌릴 결정들·클라 포함 전체 현황)은 여기 다시 적지 않는다 — `.outbox/handover-20260808.md`(클라이언트 저장소 `rally`에 있다)가 단일 진실이다. 이 저장소와 클라 저장소가 형제 디렉터리(`Projects/application_server`·`Projects/rally`)로 있으면 `../rally/.outbox/handover-20260808.md`로 바로 찾는다 — 아니면 클라 저장소를 직접 clone한 경로에서 찾는다.
