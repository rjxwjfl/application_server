# RLY-20260722-017 Backend Implementation Report

- Role: backend
- Agent: codex-backend-20260723T025630Z-84943
- Result: succeeded

## Implemented

- Added `section_members` to the clean-install schema and migration with UUID primary key, Section/User foreign keys, timestamps, soft-delete tombstone, and the required `uq_section_members_active`, `idx_sm_user_sync`, and `idx_sm_section` indexes.
- Removed the legacy Section group gate from schema migration and all Section DAO/service queries. Groups remain only as member-addition presets.
- Made `access_scope` creation-only and Section PATCH title-only.
- Auto-added the creator for private Section creation in the same transaction.
- Added manager-only bulk member addition and member removal endpoints. Addition validates active Binder membership, restores tombstones, and ignores active duplicates. Removal tombstones membership and cascade-soft-deletes the Section when no active member remains.
- Applied direct `section_members` ACL checks to Section metadata/content consumers, including messages, attachments, search, sync-filtered content, activity feeds, and notifications.
- Added D3 manager metadata oversight with `member_count` and `canAccessContent=false` for private Sections where the manager is not an explicit Section member.
- Removed `linked_section_count` from Group list results.

## Verification

- `node --check src/services/sectionService.js` — passed.
- `node --check src/daos/sectionDAO.js` — passed.
- `find src -name '*.js' -print0 | xargs -0 -n1 node --check` — passed.
- `node --test tests/postAttachmentStatusRegression.test.js` — passed (1 test).
- `git diff --check` — passed.
- `rg` found no legacy `sections.group_id`, `s.group_id`, `linked_section_count`, or `primary_group_id` references in `src/`, `config/schema.sql`, or `migrations/`.

## Limitations

- No database-backed integration suite is available in the repository, so PostgreSQL transaction and DDL execution remain for implementation review/environment verification.
