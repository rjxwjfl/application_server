class SpecialDayDAO {
  async findById(conn, id) {
    const result = await conn.query(
      `SELECT * FROM special_days WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    return result.rows[0] || null;
  }

  async findByCalId(conn, calId) {
    const result = await conn.query(
      `SELECT * FROM special_days WHERE calendar_id = $1 AND deleted_at IS NULL ORDER BY base_date ASC`,
      [calId]
    );
    return result.rows;
  }

  async create(conn, data) {
    const result = await conn.query(
      `INSERT INTO special_days
         (id, calendar_id, name, base_date, is_yearly, is_lunar, show_dday,
          count_from_one, show_every_day, sticker, color, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12,now()),COALESCE($13,now()))
       RETURNING *`,
      [
        data.id, data.calendar_id, data.name, data.base_date,
        data.is_yearly ?? true, data.is_lunar ?? false,
        data.show_dday ?? true, data.count_from_one ?? true,
        data.show_every_day ?? false, data.sticker || null,
        data.color ?? null, data.created_at, data.updated_at,
      ]
    );
    return result.rows[0];
  }

  async update(conn, id, data) {
    const result = await conn.query(
      `UPDATE special_days
       SET name           = COALESCE($1, name),
           base_date      = COALESCE($2, base_date),
           is_yearly      = COALESCE($3, is_yearly),
           is_lunar       = COALESCE($4, is_lunar),
           show_dday      = COALESCE($5, show_dday),
           count_from_one = COALESCE($6, count_from_one),
           show_every_day = COALESCE($7, show_every_day),
           sticker        = COALESCE($8, sticker),
           color          = COALESCE($9, color),
           updated_at     = now()
       WHERE id = $10 AND deleted_at IS NULL
       RETURNING *`,
      [
        data.name, data.base_date, data.is_yearly, data.is_lunar,
        data.show_dday, data.count_from_one, data.show_every_day,
        data.sticker, data.color, id,
      ]
    );
    return result.rows[0];
  }

  async softDelete(conn, id) {
    await conn.query(
      `UPDATE special_days SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
  }

  async findHolidays(conn, { country_code, year } = {}) {
    const params = [];
    const conditions = [];

    if (country_code) {
      params.push(country_code);
      conditions.push(`country_code = $${params.length}`);
    }
    if (year) {
      params.push(String(year));
      conditions.push(`EXTRACT(YEAR FROM holiday_date) = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await conn.query(
      `SELECT id, name, holiday_date, country_code, is_substitute
       FROM holidays ${where}
       ORDER BY holiday_date ASC`,
      params
    );
    return result.rows;
  }
}

module.exports = { SpecialDayDAO: new SpecialDayDAO() };
