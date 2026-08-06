# RLY-20260806-002 Backend Implementation Report

- Role: Backend Writer
- Agent: `/root/f_s8b_backend_writer`
- Branch: `agent/codex/RLY-20260806-002-backend`
- Base: `1ba0d0ad36d5451ec33c5b92cdb7bb653e039941`
- Result: implementation and narrow regression verification succeeded

## Implemented

- Changed `CastService.create` to collect every distinct `calendar_id` in the request and validate all of them before opening the INSERT transaction.
- Reused `CalendarDAO.findById`, `BinderDAO.findById`, and `BinderDAO.getMember` to require an active Calendar, active parent Binder, and active membership for `context.sender_id`.
- Kept all four active Binder roles (`master`, `manager`, `editor`, `member`; numeric roles 0 through 3) authorized to create Casts.
- Preserved the existing batch contract: every request item still produces one independent `CastDAO.create` call inside one transaction.
- Recorded the validated Binder for each distinct Calendar and used the created Cast's own `calendar_id` to select the `binder_id` of each post-commit sync event.
- Added a focused regression test covering later foreign/missing items, deleted Calendar/Binder/membership, all member roles, single/repeated creation behavior, distinct-calendar validation, zero preauthorization writes, and multi-Binder event mapping.

## Acceptance-Criteria Evidence

- **AC-S8B-1:** `rejects a foreign second calendar before the transaction with zero writes` and `rejects an invalid second calendar before the transaction with zero writes` both pass. Each asserts `transactionCalls === 0`, `CastDAO.create` calls `=== 0`, and emitted sync events `=== 0`; the observed service errors are respectively 403 and 404.
- **AC-S8B-2:** `rejects deleted calendar, binder, and membership parents before writing` passes for all three inactive-parent cases. The create-path implementation performs all distinct-calendar checks before `withTransaction` is invoked.
- **AC-S8B-3:** `keeps repeated casts independent while validating their calendar once` passes with two create calls and two same-Binder events after one distinct-calendar authorization. `maps each created cast sync event to its own calendar binder` passes with the exact target/Binder pairs `cast-a→binder-a`, `cast-b→binder-b`, and `cast-a-2→binder-a`. `allows every active binder member role to create a cast` passes for roles 0, 1, 2, and 3.

## Verification

- `node --test tests/castBatchAuthorizationRegression.test.js` — passed: 13 tests, 0 failures.
- `node --check src/services/castService.js` — passed.
- `node --check tests/castBatchAuthorizationRegression.test.js` — passed.
- `git diff --check` — passed.
- The repository's `npm test` script is a documented failing placeholder and was not used as success evidence.

## Verification Limits

- No approved disposable PostgreSQL database was provided, so live transaction rollback/commit behavior and real DAO SQL round trips were not exercised.
- No authenticated HTTP environment was provided, so live `POST /casts` 403/404 response envelopes and FCM/EventBus delivery were not exercised.
- `application_server/AGENTS.md` is absent from both the designated worktree and `/Users/rjxwjfl/Projects/application_server`; the Rally Backend role source and packet-required standards/design references were read directly instead.
