class AuditDAO {
  async insert(conn, { binder_id, actor_id, device_uuid, action_type, target_type, target_id, metadata }) {
    const query = `
      INSERT INTO audit_logs (binder_id, actor_id, device_uuid, action_type, target_type, target_id, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
    await conn.query(query, [
      binder_id || null,
      actor_id || null,
      device_uuid || null,
      action_type,
      target_type,
      target_id,
      metadata ? JSON.stringify(metadata) : null,
    ]);
  }
}

module.exports = { AuditDAO: new AuditDAO() };
