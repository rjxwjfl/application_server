class SyncDAO {

  // =========================================================================
  // 권한 획득 유틸리티
  // =========================================================================
  // role >= 0 — join-request pending(role=-1, RLY-20260806-018) 바인더는 이 유저의 동기화
  // 스코프(currDIds)에 넣지 않는다. 이 함수가 sync 파이프라인 전체의 접근 스코프 뿌리이므로,
  // 여기서 빠지면 getSection·getEventsDeltaFull 등 하위 모든 델타 쿼리가 자동으로 차단된다.
  //
  // b.deleted_at IS NULL — RLY-20260806-025 방어선. binder 삭제 cascade(BinderDAO.cascadeSoftDelete)가
  // binder_members도 함께 soft delete하므로 정상 경로에서는 이 join 없이도 막힌다. 그래도 건다 —
  // cascade가 부분 실패했거나 과거(cascade 도입 전) 데이터가 남아 binder_members만 살아있는 경우의
  // 방어선이다.
  static async getBinderIdsByUserId(pool, userId) {
    const { rows } = await pool.query(
      `SELECT bm.binder_id FROM binder_members bm
       JOIN binders b ON b.id = bm.binder_id
       WHERE bm.user_id = $1 AND bm.deleted_at IS NULL AND bm.role >= 0 AND b.deleted_at IS NULL`,
      [userId]
    );
    return rows.map(r => r.binder_id);
  }

  static async getSubscribedCalIdsByUserId(pool, userId) {
    const { rows } = await pool.query(
      `SELECT calendar_id FROM calendar_subscriptions WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId]
    );
    return rows.map(r => r.calendar_id);
  }

  // =========================================================================
  // Track A: Meta Data 쿼리 (무조건 100% 최신)
  // =========================================================================
  static async getBindersForSync(pool, currDIds, currCIds) {
    const query = `
      SELECT d.* FROM binders d
      WHERE (
        d.id = ANY($1::uuid[])
        OR d.id IN (SELECT binder_id FROM calendars WHERE id = ANY($2::uuid[]))
      )
      AND d.deleted_at IS NULL
    `;
    const { rows } = await pool.query(query, [currDIds, currCIds]);
    return rows;
  }

  static async getBinderMembers(pool, currDIds) {
    if (!currDIds.length) return [];
    // role >= 0 — pending(role=-1) 신청자를 다른 멤버의 동기화 페이로드(멤버 로스터)에 노출하지
    // 않는다(RLY-20260806-018). currDIds는 이미 getBinderIdsByUserId에서 필터되므로 이 필터가
    // 실제로 걸러내는 건 "요청자는 진짜 멤버지만 같은 바인더에 다른 pending 신청자가 있는" 경우다.
    const query = `
      SELECT binder_id, user_id, role, nickname_in_binder, joined_at,
             created_at, updated_at, deleted_at
      FROM binder_members
      WHERE binder_id = ANY($1::uuid[]) AND deleted_at IS NULL AND role >= 0
    `;
    const { rows } = await pool.query(query, [currDIds]);
    return rows;
  }

  static async getBinderPreferences(pool, userId, currDIds) {
    if (!currDIds.length) return [];
    const query = `
      SELECT binder_id, user_id, role, nickname_in_binder, notification_level
      FROM binder_members
      WHERE user_id = $1 AND binder_id = ANY($2::uuid[]) AND deleted_at IS NULL
    `;
    const { rows } = await pool.query(query, [userId, currDIds]);
    return rows;
  }

  // RLY-20260806-050 — getBinderMembers와 정확히 같은 대상 인구(대응하는 user_id 집합)를
  // 다루면서도 예전엔 `ui.updated_at > oldTs`로 델타 필터를 걸었다: 기존 멤버가 자기 프로필을
  // 안 건드린 채 (내가 이미 속한) 다른 바인더에 새로 들어오면, binder_members 행은(아래
  // getBinderMembers처럼 무조건 100% 재전송이라) 실리는데 users 행은 프로필이 안 바뀌었다는
  // 이유로 빠졌다 — 클라 로컬 DB의 binder_members→users FK가 깨지는 결함(클라 조사가 직접
  // 재현). 이 함수를 감싸는 상위 주석("뼈대 데이터는 ts... 따지지 않고 무조건 현재 소속
  // 기준으로 100% 덮어씌움")이 애초에 요구하던 게 이거였다 — getBinderMembers·
  // getBindersForSync·getBinderSettings와 같은 패턴(oldTs 파라미터 자체를 없앰)으로 맞춘다.
  //
  // 판정(가) vs (나): 이 함수의 대상 인구는 getBinderMembers가 이미 매 pull마다 무조건
  // 전량 재전송하는 바로 그 user_id 집합과 동일하다(같은 WHERE 조건— binder_members
  // WHERE binder_id = ANY(currDIds) AND deleted_at IS NULL AND role >= 0). 즉 이 컬럼들을
  // 전량 재전송해도 "이미 매 pull마다 전량 재전송되는 인구"에 필드 몇 개를 얹는 것뿐이라
  // 새로운 규모의 비용이 아니다 — binder_members 대비 비교 가능한 크기의 행(문자열 필드
  // 몇 개, user_code·display_name·bio·image_url·thumbnail_url)이 이미 감내하고 있는 것과
  // 같은 인구·같은 빈도로 늘어날 뿐이다. (나)(누락분만 보강 전송)는 "이번 델타에 없는
  // user_id"를 판정하는 별도 로직이 필요해 더 복잡한데, 이미 무조건 100%인 형제
  // 함수들(getBinderMembers 등) 옆에서 굳이 다른 전략을 쓸 이유가 없다.
  static async getUsersForSync(pool, currDIds) {
    if (!currDIds.length) return [];
    const query = `
      SELECT u.id, ui.user_code, ui.display_name, ui.bio,
             ui.image_url, ui.thumbnail_url,
             u.created_at, ui.updated_at, u.deleted_at
      FROM user_infos ui
      JOIN users u ON ui.user_id = u.id
      WHERE ui.user_id IN (
        -- role >= 0 — pending(role=-1) 신청자의 프로필을 다른 멤버 동기화에 끼워 보내지 않는다
        -- (RLY-20260806-018).
        SELECT DISTINCT dm.user_id FROM binder_members dm
        WHERE dm.binder_id = ANY($1::uuid[]) AND dm.deleted_at IS NULL AND dm.role >= 0
      )
    `;
    const { rows } = await pool.query(query, [currDIds]);
    return rows;
  }

  static async getBinderSettings(pool, currDIds) {
    if (!currDIds.length) return [];
    const query = `
      SELECT * FROM binder_settings WHERE binder_id = ANY($1::uuid[])
    `;
    const { rows } = await pool.query(query, [currDIds]);
    return rows;
  }

  static async getSection(pool, userId, currDIds, oldTs, previousSectionIds) {
    if (!currDIds.length) return [];
    // role >= 0 — currDIds는 이미 getBinderIdsByUserId에서 pending 바인더를 걸러내지만, 이 JOIN과
    // "role <= 1(master·manager 전체 섹션 접근)" 비교 자체도 독립적으로 뚫려 있었다: role=-1이
    // "<= 1"을 통과해 대기 신청자가 비공개 섹션까지 전부 받아가는 경로였다(RLY-20260806-018).
    const query = `
      SELECT s.* FROM sections s
      JOIN binder_members bm ON bm.binder_id = s.binder_id
        AND bm.user_id = $1 AND bm.deleted_at IS NULL AND bm.role >= 0
      WHERE s.binder_id = ANY($2::uuid[])
        AND (
          (s.deleted_at IS NULL AND (
            bm.role BETWEEN 0 AND 1
            OR s.access_scope = 0
            OR EXISTS (
              SELECT 1 FROM section_members sm
              WHERE sm.section_id = s.id AND sm.user_id = $1 AND sm.deleted_at IS NULL
            )
          ))
          OR ($3::timestamptz IS NOT NULL
            AND s.id = ANY($4::uuid[])
            AND s.updated_at > $3)
        )
    `;
    const { rows } = await pool.query(query, [userId, currDIds, oldTs, previousSectionIds]);
    return rows;
  }

  static async fetchSectionMembers(pool, binderId, userId, since) {
    const { rows } = await pool.query(
      `SELECT sm.*
       FROM section_members sm
       JOIN sections s ON s.id = sm.section_id
       WHERE s.binder_id = $1
         AND ($3::timestamptz IS NULL OR sm.updated_at >= $3)
         AND (
           -- active rows: sections the requester can access
           (sm.deleted_at IS NULL AND s.deleted_at IS NULL AND (
             s.access_scope = 0
             OR EXISTS (
               SELECT 1 FROM section_members own_sm
               WHERE own_sm.section_id = sm.section_id
                 AND own_sm.user_id = $2
                 AND own_sm.deleted_at IS NULL
             )
           ))
           -- tombstones: self-removal OR other members removed from sections requester is still in
           OR (sm.deleted_at IS NOT NULL AND (
             sm.user_id = $2
             OR s.access_scope = 0
             OR EXISTS (
               SELECT 1 FROM section_members own_sm
               WHERE own_sm.section_id = sm.section_id
                 AND own_sm.user_id = $2
                 AND own_sm.deleted_at IS NULL
             )
           ))
         )
       ORDER BY sm.updated_at, sm.id`,
      [binderId, userId, since]
    );
    return rows;
  }

  // RLY-20260806-050 — getUsersForSync와 같은 결함. groups는 binder_id ∈ currDIds로만
  // 스코프되고(멤버십 여부와 무관 — 그 바인더의 모든 멤버가 그룹 "정의"를 본다) old/new 바인더
  // 구분 없이 단일 oldTs를 걸었다: 오래돼 안 바뀐 groups 행이 있는 바인더에 (누구든) 새로
  // 들어오면 그 groups 행이 델타에서 빠진다 — group_members가 참조하는 부모가 통째로
  // 누락되는 같은 유형의 결함. getUsersForSync와 동일 판정으로 oldTs를 없앤다(getBinderMembers·
  // getBindersForSync·getBinderSettings와 동일 패턴).
  static async getGroups(pool, currDIds) {
    if (!currDIds.length) return [];
    const { rows } = await pool.query(
      `SELECT * FROM groups WHERE binder_id = ANY($1::uuid[])`,
      [currDIds]
    );
    return rows;
  }

  // RLY-20260806-050 — 조사 결과 getGroups·getUsersForSync와 다른 부류로 판정해 안 고쳤다.
  // 이 함수는(users·groups와 달리) "정의/메타 테이블"이 아니라 내 자신의 멤버십 행 자체를
  // 반환한다 — 내가 그룹에 새로 들어가는 사건 자체가 이 행의 updated_at을 갱신하므로, 이미
  // ts 필터가 정확히 그 사건을 잡는다(binder_members 행이 자기 자신의 join으로 최신값을
  // 갖는 것과 동일 이유). "오래된, 안 바뀐 내 그룹 멤버십이 새 바인더 접근으로 뒤늦게
  // 드러나는" 시나리오는 그룹 가입이 바인더 가입보다 먼저 있을 수 없어 구조적으로 발생하지
  // 않는다(047 보고서에 조사 근거 명시).
  static async getOwnGroupMembers(pool, userId, oldTs) {
    const { rows } = await pool.query(
      `SELECT * FROM group_members WHERE user_id = $1 ${oldTs ? 'AND updated_at > $2' : ''}`,
      oldTs ? [userId, oldTs] : [userId]
    );
    return rows;
  }

  static async getCalendarsForSync(pool, currDIds, currCIds) {
    const query = `
      SELECT * FROM calendars
      WHERE (binder_id = ANY($1::uuid[]) OR id = ANY($2::uuid[]))
      AND deleted_at IS NULL
    `;
    const { rows } = await pool.query(query, [currDIds, currCIds]);
    return rows;
  }

  static async getSubscribedCalendarRecords(pool, currCIds) {
    if (!currCIds.length) return [];
    const query = `
      SELECT * FROM calendar_subscriptions WHERE calendar_id = ANY($1::uuid[]) AND deleted_at IS NULL
    `;
    const { rows } = await pool.query(query, [currCIds]);
    return rows;
  }

  // =========================================================================
  // Track B: Calendar Data 쿼리 (Delta + Full + Tombstone)
  // =========================================================================
  static async getEventsDeltaFull(pool, ctx) {
    // c.deleted_at IS NULL은 "새로 접근 가능해진 캘린더의 현재 스냅샷" 브랜치(두 번째 SELECT)에만
    // 건다(RLY-20260806-025 방어선) — 델타/tombstone 브랜치(첫 SELECT, oldDIds 스코프)에 걸면 캘린더
    // cascade로 e.deleted_at이 막 세팅된 이벤트 자체가 tombstone으로 못 나간다(다른 멤버가 삭제를
    // 통보받지 못함). 캘린더가 삭제됐다는 사실은 이벤트 자신의 deleted_at 필드로 이미 실린다.
    //
    // es.deleted_at IS NULL(LEFT JOIN의 ON절)은 반대로 두 브랜치 모두에 건다 — 이건 "행을 숨기는"
    // 필터가 아니라 "이 이벤트에 어떤 section_id를 붙일지" 결정하는 필터라 델타/스냅샷 구분이 없다.
    // WHERE가 아니라 ON에 두는 이유: WHERE에 두면 LEFT JOIN이 사실상 INNER JOIN이 되어 섹션에 안
    // 붙은 이벤트(es 매칭 자체가 없는 행)가 결과에서 통째로 사라진다 — ON에 두면 event_sections에
    // 삭제된 링크만 있어도(또는 아예 없어도) 이벤트 행 자체는 살아있고 section_id만 NULL이 된다
    // (RLY-20260806-025 후속 — RLY-20260806-029가 EventDAO.removeSection을 hard DELETE에서 soft
    // UPDATE로 바꾸면서 이 경로에 실제로 삭제된 event_sections 행이 생기기 시작한다. 지금은
    // removeSection 호출부가 0건이라 무해했다).
    const query = `
      SELECT e.*, es.section_id FROM events e
      LEFT JOIN event_sections es ON es.event_id = e.id AND es.deleted_at IS NULL
      JOIN calendars c ON e.calendar_id = c.id
      WHERE (c.binder_id = ANY($1::uuid[]) OR e.calendar_id = ANY($2::uuid[]))
        AND e.updated_at > $3

      UNION ALL

      SELECT e.*, es.section_id FROM events e
      LEFT JOIN event_sections es ON es.event_id = e.id AND es.deleted_at IS NULL
      JOIN calendars c ON e.calendar_id = c.id
      WHERE (c.binder_id = ANY($4::uuid[]) OR e.calendar_id = ANY($5::uuid[]))
        AND e.deleted_at IS NULL
        AND c.deleted_at IS NULL
        AND (e.created_at >= $6 OR e.updated_at >= $6)
    `;
    const { rows } = await pool.query(query, [
      ctx.oldDIds, ctx.oldCIds, ctx.oldTs || new Date(0),
      ctx.newDIds, ctx.newCIds, ctx.calWindowFrom
    ]);
    return rows;
  }

  static async getEventInstancesDeltaFull(pool, ctx) {
    const query = `
      SELECT i.* FROM event_instances i
      JOIN events e ON i.event_id = e.id
      JOIN calendars c ON e.calendar_id = c.id
      WHERE (
        ((c.binder_id = ANY($1::uuid[]) OR e.calendar_id = ANY($2::uuid[])) AND i.updated_at > $3)
        OR
        ((c.binder_id = ANY($4::uuid[]) OR e.calendar_id = ANY($5::uuid[])) AND i.deleted_at IS NULL AND c.deleted_at IS NULL AND i.start_date >= $6)
      )
    `;
    const { rows } = await pool.query(query, [
      ctx.oldDIds, ctx.oldCIds, ctx.oldTs || new Date(0),
      ctx.newDIds, ctx.newCIds, ctx.calWindowFrom
    ]);
    return rows;
  }

  static async getEventParticipantsDeltaFull(pool, ctx) {
    const query = `
      SELECT ep.* FROM event_participants ep
      JOIN event_instances i ON ep.instance_id = i.id
      JOIN events e ON i.event_id = e.id
      JOIN calendars c ON e.calendar_id = c.id
      WHERE (
        ((c.binder_id = ANY($1::uuid[]) OR e.calendar_id = ANY($2::uuid[])) AND ep.updated_at > $3)
        OR
        ((c.binder_id = ANY($4::uuid[]) OR e.calendar_id = ANY($5::uuid[])) AND ep.deleted_at IS NULL AND c.deleted_at IS NULL)
      )
    `;
    const { rows } = await pool.query(query, [
      ctx.oldDIds, ctx.oldCIds, ctx.oldTs || new Date(0),
      ctx.newDIds, ctx.newCIds
    ]);
    return rows;
  }

  // RLY-20260806-041 — event_sections와 대칭(getEventsDeltaFull 위 주석 참조). es.deleted_at
  // IS NULL과 동일하게 ts.deleted_at IS NULL도 WHERE가 아니라 LEFT JOIN의 ON에 건다 — WHERE에
  // 두면 LEFT JOIN이 사실상 INNER JOIN이 되어 섹션에 안 붙은 태스크(ts 매칭 자체가 없는 행)가
  // 결과에서 통째로 사라진다.
  static async getTasksDeltaFull(pool, ctx) {
    const query = `
      SELECT t.*, ts.section_id FROM tasks t
      LEFT JOIN task_sections ts ON ts.task_id = t.id AND ts.deleted_at IS NULL
      JOIN calendars c ON t.calendar_id = c.id
      WHERE (
        ((c.binder_id = ANY($1::uuid[]) OR t.calendar_id = ANY($2::uuid[])) AND t.updated_at > $3)
        OR
        ((c.binder_id = ANY($4::uuid[]) OR t.calendar_id = ANY($5::uuid[])) AND t.deleted_at IS NULL AND c.deleted_at IS NULL AND (t.created_at >= $6 OR t.updated_at >= $6))
      )
    `;
    const { rows } = await pool.query(query, [
      ctx.oldDIds, ctx.oldCIds, ctx.oldTs || new Date(0),
      ctx.newDIds, ctx.newCIds, ctx.calWindowFrom
    ]);
    return rows;
  }

  static async getTaskInstancesDeltaFull(pool, ctx) {
    const query = `
      SELECT ti.* FROM task_instances ti
      JOIN tasks t ON ti.task_id = t.id
      JOIN calendars c ON t.calendar_id = c.id
      WHERE (
        ((c.binder_id = ANY($1::uuid[]) OR t.calendar_id = ANY($2::uuid[])) AND ti.updated_at > $3)
        OR
        ((c.binder_id = ANY($4::uuid[]) OR t.calendar_id = ANY($5::uuid[])) AND ti.deleted_at IS NULL AND c.deleted_at IS NULL AND ti.due_date >= $6)
      )
    `;
    const { rows } = await pool.query(query, [
      ctx.oldDIds, ctx.oldCIds, ctx.oldTs || new Date(0),
      ctx.newDIds, ctx.newCIds, ctx.calWindowFrom
    ]);
    return rows;
  }

  static async getTaskParticipantsDeltaFull(pool, ctx) {
    const query = `
      SELECT tp.* FROM task_participants tp
      JOIN task_instances ti ON tp.instance_id = ti.id
      JOIN tasks t ON ti.task_id = t.id
      JOIN calendars c ON t.calendar_id = c.id
      WHERE (
        ((c.binder_id = ANY($1::uuid[]) OR t.calendar_id = ANY($2::uuid[])) AND tp.updated_at > $3)
        OR
        ((c.binder_id = ANY($4::uuid[]) OR t.calendar_id = ANY($5::uuid[])) AND tp.deleted_at IS NULL AND c.deleted_at IS NULL)
      )
    `;
    const { rows } = await pool.query(query, [
      ctx.oldDIds, ctx.oldCIds, ctx.oldTs || new Date(0),
      ctx.newDIds, ctx.newCIds
    ]);
    return rows;
  }

  static async getSpecialDaysDeltaFull(pool, ctx) {
    const query = `
      SELECT sd.* FROM special_days sd
      JOIN calendars c ON sd.calendar_id = c.id
      WHERE (
        ((c.binder_id = ANY($1::uuid[]) OR sd.calendar_id = ANY($2::uuid[])) AND sd.updated_at > $3)
        OR
        ((c.binder_id = ANY($4::uuid[]) OR sd.calendar_id = ANY($5::uuid[])) AND sd.deleted_at IS NULL AND c.deleted_at IS NULL)
      )
    `;
    const { rows } = await pool.query(query, [
      ctx.oldDIds, ctx.oldCIds, ctx.oldTs || new Date(0),
      ctx.newDIds, ctx.newCIds
    ]);
    return rows;
  }

  // =========================================================================
  // Track C: Messaging Data 쿼리
  // =========================================================================
  static async getMessagesDeltaFull(pool, ctx) {
    const query = `
      SELECT m.* FROM section_messages m
      JOIN sections s ON m.section_id = s.id
      WHERE (s.access_scope = 0 OR EXISTS (
        SELECT 1 FROM section_members sm
        WHERE sm.section_id = s.id AND sm.user_id = $5 AND sm.deleted_at IS NULL
      )) AND (
        (s.binder_id = ANY($1::uuid[]) AND m.updated_at > $2)
        OR
        (s.binder_id = ANY($3::uuid[]) AND m.deleted_at IS NULL AND m.created_at >= $4)
        OR
        (s.id = ANY($6::uuid[]) AND m.deleted_at IS NULL AND m.created_at >= $4)
      )
      ORDER BY m.created_at DESC
    `;
    const { rows } = await pool.query(query, [
      ctx.oldDIds, ctx.oldTs || new Date(0),
      ctx.newDIds, ctx.msgWindowFrom, ctx.userId, ctx.hydrateSectionIds
    ]);
    return rows;
  }

  /**
   * RLY-20260806-078 — 원래 이 함수는 messageIds(이번 델타에 포함된 메시지)로만 스코프됐다.
   * 메시지는 안 바뀌었는데 그 메시지에 달린 첨부만(Worker의 비동기 confirm→ready/rejected
   * 전환이 메시지 자신의 동기화보다 항상 늦게 끝나서 — 1분 폴링) 바뀐 경우, messageIds에
   * 그 메시지가 없어 그 변화가 부모가 다시 바뀌지 않는 한 영원히 델타에서 빠졌다.
   *
   * userId·currDIds가 주어지면(정상 sync 경로 — syncService._fetchTrackCMessaging) 두
   * 조건을 OR로 묶는다:
   *  (1) a.context_id = ANY(messageIds) — 이번 델타에 포함된 메시지의 첨부(신규·hydrate).
   *      원래 동작과 완전히 동일(messageIds 스코프 내에서 oldTs 있으면 그 안에서도 시간 필터).
   *  (2) a.updated_at > oldTs AND 그 섹션이 지금 접근 가능 — 부모는 안 바뀌었지만 첨부
   *      자신이 바뀐 경우. messageIds가 주던 인가 경계(부모 메시지 조회 시 이미 섹션 접근이
   *      검증돼 있었다)를 대신할 자체 검증이 필요해서, getMessagesDeltaFull과 똑같은
   *      access_scope/section_members 판정을 그대로 재사용한다(새 인가 개념을 만들지 않는다).
   *  oldTs가 없으면(hydrate 전용 델타) (2)는 적용하지 않는다 — 그 경우 (1)이 이미 해당
   *  섹션의 메시지를 window 전체 실어(getMessagesDeltaFull hydrate 분기) 그 첨부도 (1)로
   *  잡힌다. userId·currDIds가 없는 호출(이론상의 다른 호출부 대비)은 원래 쿼리 그대로 동작한다.
   */
  static async getMessageAttachments(pool, messageIds, oldTs, userId, currDIds) {
    const hasIndependentBranch = !!(oldTs && userId && currDIds && currDIds.length);
    if (!messageIds.length && !hasIndependentBranch) return [];

    if (!hasIndependentBranch) {
      const query = `
        SELECT id, context_id AS message_id, filename, file_size, content_type, storage_key, status, updated_at
        FROM attachments
        WHERE context_type = 'SECTION_MESSAGE' AND context_id = ANY($1::uuid[]) AND deleted_at IS NULL
        ${oldTs ? 'AND updated_at > $2' : ''}
      `;
      const params = oldTs ? [messageIds, oldTs] : [messageIds];
      const { rows } = await pool.query(query, params);
      return rows;
    }

    const query = `
      SELECT a.id, a.context_id AS message_id, a.filename, a.file_size, a.content_type,
             a.storage_key, a.status, a.updated_at
      FROM attachments a
      JOIN section_messages m ON m.id = a.context_id
      JOIN sections s ON s.id = m.section_id
      WHERE a.context_type = 'SECTION_MESSAGE' AND a.deleted_at IS NULL
        AND (
          (a.context_id = ANY($1::uuid[]) AND a.updated_at > $2)
          OR (
            a.updated_at > $2
            AND s.binder_id = ANY($3::uuid[])
            AND (s.access_scope = 0 OR EXISTS (
              SELECT 1 FROM section_members sm
              WHERE sm.section_id = s.id AND sm.user_id = $4 AND sm.deleted_at IS NULL
            ))
          )
        )
    `;
    const { rows } = await pool.query(query, [messageIds, oldTs, currDIds, userId]);
    return rows;
  }

  static async getMessageEmbeds(pool, messageIds, oldTs) {
    if (!messageIds.length) return [];
    const query = `
      SELECT * FROM message_embeds
      WHERE message_id = ANY($1::uuid[])
      ${oldTs ? 'AND updated_at > $2' : ''}
    `;
    const params = oldTs ? [messageIds, oldTs] : [messageIds];
    const { rows } = await pool.query(query, params);
    return rows;
  }

  static async getMessageReactions(pool, messageIds, oldTs) {
    if (!messageIds.length) return [];
    const query = `
      SELECT * FROM message_reactions
      WHERE message_id = ANY($1::uuid[])
      ${oldTs ? 'AND updated_at > $2' : ''}
    `;
    const params = oldTs ? [messageIds, oldTs] : [messageIds];
    const { rows } = await pool.query(query, params);
    return rows;
  }

  static async getMessageMentions(pool, messageIds, oldTs) {
    if (!messageIds.length) return [];
    const query = `
      SELECT * FROM message_mentions
      WHERE message_id = ANY($1::uuid[])
      ${oldTs ? 'AND updated_at > $2' : ''}
    `;
    const params = oldTs ? [messageIds, oldTs] : [messageIds];
    const { rows } = await pool.query(query, params);
    return rows;
  }

  // =========================================================================
  // Personal Data 쿼리
  // =========================================================================
  static async getNotifications(pool, userId, since) {
    const query = `
      SELECT * FROM notifications
      WHERE recipient_id = $1 AND created_at > $2
      ORDER BY created_at DESC
    `;
    const { rows } = await pool.query(query, [userId, since]);
    return rows;
  }

  static async getUserSubscriptions(pool, userId, oldTs) {
    const query = `
      SELECT * FROM user_subscriptions
      WHERE user_id = $1
      ${oldTs ? 'AND updated_at > $2' : ''}
    `;
    const params = oldTs ? [userId, oldTs] : [userId];
    const { rows } = await pool.query(query, params);
    return rows;
  }

  static async getUserAssets(pool, userId, oldTs) {
    const query = `
      SELECT * FROM user_assets
      WHERE user_id = $1
      ${oldTs ? 'AND purchased_at > $2' : ''}
    `;
    const params = oldTs ? [userId, oldTs] : [userId];
    const { rows } = await pool.query(query, params);
    return rows;
  }

  static async getUserHolidayCountries(pool, userId) {
    const query = `
      SELECT UNNEST(holidays_countries) AS country_code
      FROM user_settings
      WHERE user_id = $1 AND holidays_countries IS NOT NULL AND holidays_countries != '{}'
    `;
    const { rows } = await pool.query(query, [userId]);
    return rows.map(r => r.country_code);
  }

  static async getActivityFeedsForSync(pool, userId, currDIds, oldTs) {
    if (!currDIds.length) return [];
    const query = `
      SELECT id, binder_id, actor_id, action_type, target_type, target_id, metadata, created_at
      FROM activity_feeds
      WHERE binder_id = ANY($2::uuid[])
      ${oldTs ? 'AND created_at > $3' : ''}
        AND CASE
          WHEN target_type = 'SECTION' THEN EXISTS (
            SELECT 1 FROM sections s
            WHERE s.id = activity_feeds.target_id
              AND s.deleted_at IS NULL
              AND (s.access_scope = 0 OR EXISTS (
                SELECT 1 FROM section_members secm
                WHERE secm.section_id = s.id AND secm.user_id = $1 AND secm.deleted_at IS NULL
              ))
          )
          WHEN target_type = 'SECTION_MESSAGE' THEN EXISTS (
            SELECT 1 FROM section_messages sm
            JOIN sections s ON s.id = sm.section_id
            WHERE sm.id = activity_feeds.target_id
              -- RLY-20260806-041 — 바로 위 SECTION 분기와의 비대칭(025 담당자 의심 제기)을
              -- 오탈자로 판정해 정정한다: 섹션이 soft delete되면 그 섹션에 속한 메시지 활동도
              -- 더 이상 아무도 볼 수 없어야 한다는 게 SECTION 분기와 같은 원칙이다. 근거 문서는
              -- 없지만(api.md §10 AC4는 "⑤활동피드"의 접근 판정만 규정하고 삭제 처리는 언급 없음),
              -- 두 분기의 access_scope/section_members 절이 완전히 동일한 구조인데 이 한 줄만
              -- 빠져 있었다 — 의도된 차이라면 있어야 할 설명이 어디에도 없다.
              AND s.deleted_at IS NULL
              AND (s.access_scope = 0 OR EXISTS (
                SELECT 1 FROM section_members secm
                WHERE secm.section_id = s.id AND secm.user_id = $1 AND secm.deleted_at IS NULL
              ))
          )
          ELSE true
        END
      ORDER BY created_at DESC
      LIMIT 500
    `;
    const params = oldTs ? [userId, currDIds, oldTs] : [userId, currDIds];
    const { rows } = await pool.query(query, params);
    return rows;
  }

  static async getAccessibleSectionIds(pool, userId, binderIds) {
    if (!binderIds.length) return [];
    const { rows } = await pool.query(
      `SELECT s.id
       FROM sections s
       WHERE s.binder_id = ANY($2::uuid[]) AND s.deleted_at IS NULL
         AND (s.access_scope = 0 OR EXISTS (
           SELECT 1 FROM section_members sm
           WHERE sm.section_id = s.id AND sm.user_id = $1 AND sm.deleted_at IS NULL
         ))`,
      [userId, binderIds]
    );
    return rows.map((row) => row.id);
  }

  static async getActivityFeedCursorsForSync(pool, userId, currDIds) {
    if (!currDIds.length) return [];
    const query = `
      SELECT user_id, binder_id, last_read_feed_id, last_read_feed_at, updated_at
      FROM activity_feed_cursors
      WHERE user_id = $1 AND binder_id = ANY($2::uuid[])
    `;
    const { rows } = await pool.query(query, [userId, currDIds]);
    return rows;
  }

  static async getHolidays(pool, countryCodes, oldTs) {
    const query = `
      SELECT * FROM holidays
      WHERE country_code = ANY($1::text[])
      ${oldTs ? 'AND updated_at > $2' : ''}
    `;
    const params = oldTs ? [countryCodes, oldTs] : [countryCodes];
    const { rows } = await pool.query(query, params);
    return rows;
  }

  // =========================================================================
  // Contextual Fetch 전용 쿼리 (위젯 스크롤 시)
  // =========================================================================
  static async getCalendarDataOnlyByWindow(pool, ctx) {
    // 순수 스냅샷 쿼리(델타/tombstone 분기 없음) — c.deleted_at IS NULL 추가는 방어선일 뿐 tombstone
    // 경로를 건드리지 않는다(RLY-20260806-025).
    const query = `
      SELECT e.* FROM events e
      JOIN calendars c ON e.calendar_id = c.id
      WHERE (c.binder_id = ANY($1::uuid[]) OR e.calendar_id = ANY($2::uuid[]))
        AND e.deleted_at IS NULL
        AND c.deleted_at IS NULL
    `;
    const { rows } = await pool.query(query, [ctx.currDIds, ctx.currCIds]);
    return { events: rows };
  }
}

module.exports = { SyncDAO };
