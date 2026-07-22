# RLY-20260722-012 Backend Implementation Report

- Agent: `codex-backend-20260722T100226Z-39711`
- Role: Backend writer
- Base: `b6ef445`

## Implemented

- Added reversible SQL migration for `groups`, `group_members`, `section_groups`, `binder_members.primary_group_id`, and removal of `sections.required_grade`.
- Added group DAO/service/routes with binder membership checks, manager-or-higher mutation authorization, target-role ordering checks, roster management, tombstones, and primary-label cleanup.
- Reworked Section persistence and service paths for the two-value access model, ACL-aware listing, transactional private grants, manager metadata oversight, grant connect/disconnect, and grant-0 protection.
- Added server-side private Section content authorization to message, poll, reaction, cursor, pinned-message, file-list, upload-presign, and signed-download paths.
- Added ACL-filtered message search and notification-recipient filtering.
- Added ACL delta collections to sync: `groups` and `section_groups` in binder scope, `group_members` in `user_id=me` scope; message delta hydration is ACL-filtered.
- Binder departure/kick now tombstones the user's active group memberships and clears `primary_group_id` in the same transaction.

## Verification

- Required `node --check` commands passed for group and section route/service/DAO files.
- Additional `node --check` passed for all modified JavaScript files.
- `git diff --check` passed.
- Confirmed `required_grade` remains only in migration UP/DOWN statements, not runtime Section DAO/service code.

## Verification limits

- No database integration test was run because the task environment does not provide an approved disposable PostgreSQL database or migration runner.
- The repository's `npm test` command is the documented failing placeholder and was not treated as verification.
- Revoke ordering is represented in the response with ACL collections produced before messaging fetch/merge; the client-side recalculate/hydrate/purge application sequence belongs to later lockstep client phases.
