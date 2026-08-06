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

  // RLY-20260806-026 — 실 스키마(config/schema.sql SECTION 6) 정합. 구 `is_yearly` 컬럼은
  // 2026-08-01 결정으로 schema에서 삭제됐다(r_rule과 이중 진실) — "매년 반복"은 client가 보낸
  // `r_rule="FREQ=YEARLY"`를 그대로 저장할 뿐 서버가 합성하지 않는다(SC-special-day.md §7-1).
  // author_id·reminder_offsets·lunar 3필드(is_lunar 외 lunar_month·lunar_day·lunar_is_leap_month)
  // 는 스키마에는 있었으나 이 DAO가 전혀 다루지 않아 기념일 생성 자체가 100% SQL 에러였다
  // (is_yearly 컬럼 부재 INSERT) — 이 함수가 그 결함의 실체다.
  async create(conn, data) {
    const result = await conn.query(
      `INSERT INTO special_days
         (id, calendar_id, author_id, name, base_date, r_rule, is_lunar, lunar_month, lunar_day,
          lunar_is_leap_month, show_dday, count_from_one, show_every_day, sticker, color,
          reminder_offsets, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,COALESCE($17,now()),COALESCE($18,now()))
       RETURNING *`,
      [
        data.id, data.calendar_id, data.author_id, data.name, data.base_date,
        data.r_rule || null,
        data.is_lunar ?? false,
        data.lunar_month ?? null,
        data.lunar_day ?? null,
        data.lunar_is_leap_month ?? null,
        data.show_dday ?? true, data.count_from_one ?? true,
        data.show_every_day ?? false, data.sticker || null,
        data.color ?? null,
        data.reminder_offsets ?? null,
        data.created_at, data.updated_at,
      ]
    );
    return result.rows[0];
  }

  async update(conn, id, data) {
    const result = await conn.query(
      `UPDATE special_days
       SET name                 = COALESCE($1, name),
           base_date            = COALESCE($2, base_date),
           r_rule               = COALESCE($3, r_rule),
           is_lunar             = COALESCE($4, is_lunar),
           lunar_month          = COALESCE($5, lunar_month),
           lunar_day            = COALESCE($6, lunar_day),
           lunar_is_leap_month  = COALESCE($7, lunar_is_leap_month),
           show_dday            = COALESCE($8, show_dday),
           count_from_one       = COALESCE($9, count_from_one),
           show_every_day       = COALESCE($10, show_every_day),
           sticker              = COALESCE($11, sticker),
           color                = COALESCE($12, color),
           reminder_offsets     = COALESCE($13, reminder_offsets),
           updated_at           = now()
       WHERE id = $14 AND deleted_at IS NULL
       RETURNING *`,
      [
        data.name, data.base_date, data.r_rule, data.is_lunar,
        data.lunar_month, data.lunar_day, data.lunar_is_leap_month,
        data.show_dday, data.count_from_one, data.show_every_day,
        data.sticker, data.color, data.reminder_offsets, id,
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
