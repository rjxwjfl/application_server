class UserSettingsDAO {
  async get(conn, userId) {
    const { rows } = await conn.query(
      `SELECT language_code, holidays_countries, timezone,
              first_day_of_week, show_lunar_calendar, show_week_numbers,
              blue_saturday, is_push_enabled, is_notice_enabled,
              font_size, theme_preference, created_at, updated_at
       FROM user_settings WHERE user_id = $1`,
      [userId]
    );
    return rows[0] || null;
  }

  async createDefault(conn, userId) {
    const { rows } = await conn.query(
      `INSERT INTO user_settings (user_id)
       VALUES ($1)
       RETURNING user_id, language_code, holidays_countries, timezone,
               first_day_of_week, show_lunar_calendar, show_week_numbers,
               blue_saturday, is_push_enabled, is_notice_enabled,
               font_size, theme_preference, created_at, updated_at`,
      [userId]
    );
    return rows[0];
  }

  async updatePartial(conn, userId, settings) {
    // 1. DB에 존재하는 실제 컬럼명들만 허용 (SQL 인젝션 방지 및 쓰레기 데이터 필터링)
    const allowedColumns = [
      'language_code', 'holidays_countries', 'timezone',
      'first_day_of_week', 'show_lunar_calendar', 'show_week_numbers',
      'blue_saturday', 'is_push_enabled', 'is_notice_enabled',
      'font_size', 'theme_preference'
    ];

    const setClauses = [];
    const values = [userId]; // $1은 항상 userId로 사용
    let paramIndex = 2;      // 동적 파라미터는 $2부터 시작

    // 2. 넘어온 settings 객체를 순회하며 쿼리 조각 만들기
    for (const [key, value] of Object.entries(settings)) {
      // 허용된 컬럼이면서 값이 undefined가 아닌 경우만 추가 (null은 허용하여 값을 지울 수 있게 함)
      if (allowedColumns.includes(key) && value !== undefined) {
        setClauses.push(`${key} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    }

    // 3. 업데이트할 내용이 없으면 조기 종료 (DB 부하 방지)
    if (setClauses.length === 0) {
      return this.get(conn, userId); // 변경사항이 없으면 기존 데이터 그대로 반환
    }

    // 4. 업데이트 시간 갱신 추가
    setClauses.push('updated_at = NOW()');

    // 5. 동적 쿼리 조립 및 실행
    const query = `
      UPDATE user_settings 
      SET ${setClauses.join(', ')}
      WHERE user_id = $1
      RETURNING language_code, holidays_countries, timezone,
                first_day_of_week, show_lunar_calendar, show_week_numbers,
                blue_saturday, is_push_enabled, is_notice_enabled,
                font_size, theme_preference, updated_at
    `;

    const { rows } = await conn.query(query, values);
    return rows[0] || null;
  }
}

module.exports = { UserSettingsDAO: new UserSettingsDAO() };
