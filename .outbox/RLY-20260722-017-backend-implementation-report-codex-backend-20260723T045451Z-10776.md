# RLY-20260722-017 Backend implementation rework report

- Role: backend
- Agent: `codex-backend-20260723T045451Z-10776`
- Base reviewed by prior implementation reviewer: `c7c5feb81fa65d416880281443c83260370c6cac`
- Status: succeeded; independent implementation re-review required

## Rework completed

- Replaced the binder-member removal path's direct `sections` tombstone with `SectionDAO.softDeleteEmptyPrivateSections`.
- Empty private sections are selected under `FOR UPDATE` and passed through the existing full `SectionDAO.softDelete` cascade.
- The cascade now consistently tombstones attachments, message children, messages, event/task relations, section members, and the section when binder departure removes the last active section member.
- Added `src/daos/sectionCascadeRegression.test.js` to guard the binder-departure cascade path.

## Verification

- `node src/daos/sectionCascadeRegression.test.js` — passed
- `node --check src/services/sectionService.js` — passed
- `node --check src/daos/sectionDAO.js` — passed
- `node --check src/daos/syncDAO.js` — passed
- `node --check src/services/syncService.js` — passed
- `node --check src/daos/binderDAO.js` — passed
- `node --check src/daos/sectionCascadeRegression.test.js` — passed
- `git diff --check` — passed

## Notes

- No dependency, standard, control-repository, package manifest, or unrelated worktree changes were made.
- Existing `.outbox/runtime` bridge artifacts were preserved unchanged.
