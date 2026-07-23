const assert = require('assert');
const { BinderDAO } = require('./binderDAO');

const queries = [];
const conn = {
  async query(sql) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    queries.push(normalized);
    if (normalized.startsWith('SELECT s.id FROM sections s')) return { rows: [{ id: 'section-1' }] };
    return { rows: [], rowCount: 1 };
  },
};

async function run() {
  await BinderDAO.removeMember(conn, 'binder-1', 'user-1');

  assert(queries.some((sql) => sql.startsWith('UPDATE section_members sm SET deleted_at')));
  assert(queries.some((sql) => sql.startsWith('SELECT s.id FROM sections s') && sql.endsWith('FOR UPDATE')));
  assert(queries.some((sql) => sql.startsWith('UPDATE attachments a SET deleted_at')));
  assert(queries.some((sql) => sql.startsWith('UPDATE section_messages SET deleted_at')));
  assert(queries.some((sql) => sql.startsWith('UPDATE event_sections SET deleted_at')));
  assert(queries.some((sql) => sql.startsWith('UPDATE task_sections SET deleted_at')));
  assert(queries.some((sql) => sql.startsWith('UPDATE sections SET deleted_at')));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
