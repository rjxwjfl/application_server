const { generateUUID } = require('../utils/uuid');

// 【결정 63】 리마인더는 notification_level <= 1(모두·관련만)까지 수신한다(SC-reminder §2-A-2).
// notificationDAO가 알림 종류 전반에 쓰는 것과 같은 값 체계(0=모두·1=관련만·2=멘션만·
// 3=수신거부) — 신규 필터가 아니다.
// ⚠️ RLY-20260806-190 — sendAlert는 "가시성(항상 인앱 기록)"과 "선호(notification_level,
// 푸시만)"를 분리했다(notificationDAO.getActiveMemberIds·filterUserIdsByNotificationLevel
// 참조, 예전 getMembersForAlert는 삭제됨). 이 파일의 getRecipients는 그 분리를 적용받지
// 않은 채 아래에서 여전히 notification_level을 리마인더 발송 대상 조회 SQL에 직접 걸어
// 대상 자체를 좁힌다 — 리마인더 인앱 기록도 이 파일이 함께 만든다면(reminderJobs.js가
// insertNotificationsBulk를 재사용) 같은 부류(가시성·선호 미분리)의 결함일 수 있다.
// 이번 태스크(sendAlert 두 채널 분리) 범위 밖이라 여기는 손대지 않았다 — 구현 보고서에
// 별도 발견으로 남겼다.
const MAX_NOTIFICATION_LEVEL_FOR_REMINDER = 1;

// RLY-20260806-026 — reminders는 발송 원장(schema.md §10-4, 13컬럼, [확정] 2026-08-03)이다.
// "누가 언제 받을지"가 아니라 "무엇을 언제 발화할지"의 원장이며, 오프셋은 항목
// (events|tasks|special_days).reminder_offsets가 갖고 수신자는 발송 시점에 구한다(2단계 몫).
// 이 파일은 그 13컬럼만 다룬다 — user_id·base_time·is_sent(구 컬럼, 폐기)는 참조하지 않는다.
class ReminderDAO {
  async findById(conn, id) {
    const result = await conn.query(
      `SELECT id, target_type, target_id, trigger_offset, trigger_at, timezone,
              claim_token, claimed_at, attempt_count, next_attempt_at, sent_at,
              created_at, updated_at
       FROM reminders
       WHERE id = $1`,
      [id]
    );
    return result.rows[0] || null;
  }

  // 부모(회차·기념일) 하나에 달린 모든 발송 원장 행. user_id 축이 폐지돼 필터가 없다 —
  // 수신자는 저장하지 않으므로 "이 유저의 리마인더"라는 조회 자체가 성립하지 않는다.
  async findByTarget(conn, targetType, targetId) {
    const result = await conn.query(
      `SELECT id, target_type, target_id, trigger_offset, trigger_at, timezone,
              claim_token, claimed_at, attempt_count, next_attempt_at, sent_at,
              created_at, updated_at
       FROM reminders
       WHERE target_type = $1 AND target_id = $2
       ORDER BY trigger_offset ASC`,
      [targetType, targetId]
    );
    return result.rows;
  }

  // 2단계(발송 dispatch) 전용 조회 — 이번 Task는 저장만 다루므로 호출부는 아직 없다.
  // lease 4컬럼(claim_token 등)의 claim 로직은 여기서 만들지 않는다(2단계 범위).
  async findPending(conn, beforeTime, limit = 100) {
    const result = await conn.query(
      `SELECT id, target_type, target_id, trigger_offset, trigger_at, timezone,
              claim_token, claimed_at, attempt_count, next_attempt_at
       FROM reminders
       WHERE trigger_at <= $1 AND sent_at IS NULL
       ORDER BY trigger_at ASC
       LIMIT $2`,
      [beforeTime, limit]
    );
    return result.rows;
  }

  // due 리마인더 + 대상 회차 요약. system.md §10-13이 요구하는 "대상 회차 INNER JOIN
  // (deleted_at IS NULL)" 방어를 쿼리에 반영한다 — 원장 단독 조회로 발송하면 삭제된 회차의
  // 알림이 나간다. 2단계 dispatch가 이 형태를 그대로 가져다 쓸 수 있도록 미리 맞춰 둔다(호출부는 아직 없음).
  async findPendingWithDetails(conn, beforeTime, limit = 100) {
    const result = await conn.query(
      `SELECT r.id, r.target_type, r.target_id, r.trigger_offset, r.trigger_at, r.timezone,
        CASE r.target_type
          WHEN 0 THEN COALESCE(ei.summary, e.summary, '일정')
          WHEN 1 THEN COALESCE(ti.summary, t.summary, '할 일')
          WHEN 2 THEN sd.name
        END AS summary
      FROM reminders r
      LEFT JOIN event_instances ei ON r.target_type = 0 AND r.target_id = ei.id AND ei.deleted_at IS NULL
      LEFT JOIN events e           ON ei.event_id = e.id
      LEFT JOIN task_instances ti  ON r.target_type = 1 AND r.target_id = ti.id AND ti.deleted_at IS NULL
      LEFT JOIN tasks t            ON ti.task_id = t.id
      LEFT JOIN special_days sd    ON r.target_type = 2 AND r.target_id = sd.id AND sd.deleted_at IS NULL
      WHERE r.trigger_at <= $1 AND r.sent_at IS NULL
        AND (
          (r.target_type = 0 AND ei.id IS NOT NULL) OR
          (r.target_type = 1 AND ti.id IS NOT NULL) OR
          (r.target_type = 2 AND sd.id IS NOT NULL)
        )
      ORDER BY r.trigger_at ASC
      LIMIT $2`,
      [beforeTime, limit]
    );
    return result.rows;
  }

  // 일회성(Event·Task) 발송 완료 — sent_at 기록 후 종결(§2-B). RLY-20260806-032(2단계 dispatch)
  // 호출부. claim_token 일치를 WHERE에 건다 — lease(5분) 만료 후 다른 워커가 이미 재claim했으면
  // (claim_token이 바뀌었으면) 이 UPDATE는 0행 매칭으로 조용히 무효화된다. 그게 바로
  // schema.md §10-4가 말하는 "claim_token이 막는 대상"이다: 만료 후 재claim된 행에 원래
  // 워커(느리게 응답한 워커)가 뒤늦게 sent_at을 써서 중복 발송 판정을 흐리는 것.
  async markSent(conn, id, claimToken) {
    const result = await conn.query(
      `UPDATE reminders SET sent_at = now(), updated_at = now()
       WHERE id = $1 AND claim_token = $2
       RETURNING id`,
      [id, claimToken]
    );
    return result.rows.length > 0;
  }

  // SpecialDay(target_type=2) 발송 후 다음 해로 롤링 — sent_at은 영구 NULL 유지, lease 초기화(§2-B·§5A).
  // markSent와 동일하게 claim_token 일치를 요구한다.
  async rollSpecialDay(conn, id, nextTriggerAt, claimToken) {
    const result = await conn.query(
      `UPDATE reminders
       SET trigger_at = $1, attempt_count = 0, claim_token = NULL, claimed_at = NULL,
           next_attempt_at = NULL, updated_at = now()
       WHERE id = $2 AND claim_token = $3
       RETURNING id`,
      [nextTriggerAt, id, claimToken]
    );
    return result.rows.length > 0;
  }

  // 발송 실패 — 지수 백오프로 next_attempt_at을 미루고 lease를 놓는다(claim_token=NULL 해야
  // 다음 tick의 claimDueBatch WHERE claim_token IS NULL 조건에 다시 걸린다 — 5분 만료를
  // 기다릴 이유가 없다, 이미 실패로 확정됐으므로 즉시 재claim 가능하게 놓아준다).
  // attempt_count는 claimDueBatch가 claim 시점에 이미 올려 뒀다(아래 참조) — 여기서 다시
  // 올리지 않는다.
  async markFailed(conn, id, claimToken, nextAttemptAt) {
    const result = await conn.query(
      `UPDATE reminders
       SET claim_token = NULL, claimed_at = NULL, next_attempt_at = $1, updated_at = now()
       WHERE id = $2 AND claim_token = $3
       RETURNING id`,
      [nextAttemptAt, id, claimToken]
    );
    return result.rows.length > 0;
  }

  // ── dispatch(2단계) — due 배치를 원자적으로 claim한다 ──────────────────────────────
  //
  // FOR UPDATE SKIP LOCKED로 후보를 잠그고, 그 잠긴 행만 UPDATE...RETURNING으로 claim한다
  // (system.md §10-13). "조회 후 갱신"이 아니라 단일 UPDATE 문 안에서 후보 선정과 claim이
  // 함께 일어나므로, 두 워커가 동시에 이 함수를 불러도 같은 행을 두 번 claim할 수 없다 —
  // SKIP LOCKED가 이미 다른 트랜잭션이 잠근 행을 후보에서 제외하기 때문이다.
  //
  // WHERE 절 4개 조건:
  //   trigger_at <= now() AND sent_at IS NULL         — due & 미발송(§10-4 idx_rem_dispatch)
  //   claim_token IS NULL OR claimed_at < 5분 전        — 미claim 이거나 lease 만료
  //   next_attempt_at IS NULL OR next_attempt_at <= now() — 백오프 대기 중이 아님
  //   attempt_count < maxAttempts                       — 재시도 상한 초과 행은 더 이상 안 건드림
  //     (상한 도달 행의 최종 처리는 호출부 dispatch 루프가 giveUp으로 명시 종결한다)
  //
  // 대상 회차 INNER JOIN은 여기서 하지 않는다 — claim은 reminders 단독으로 하고(락 범위를
  // 최소로 유지), 삭제된 회차 방어는 findClaimedWithDetails가 그 claim된 id 집합에 대해서만
  // 별도 조회로 수행한다(락을 오래 들고 있지 않기 위한 분리).
  async claimDueBatch(conn, { claimToken, limit = 500, leaseMinutes = 5, maxAttempts = 5 }) {
    const result = await conn.query(
      `UPDATE reminders
       SET claim_token = $1, claimed_at = now(), attempt_count = attempt_count + 1, updated_at = now()
       WHERE id IN (
         SELECT id FROM reminders
         WHERE trigger_at <= now() AND sent_at IS NULL
           AND (claim_token IS NULL OR claimed_at < now() - ($2 || ' minutes')::interval)
           AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           AND attempt_count < $3
         ORDER BY trigger_at ASC
         LIMIT $4
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, target_type, target_id, trigger_offset, trigger_at, timezone, attempt_count`,
      [claimToken, leaseMinutes, maxAttempts, limit]
    );
    return result.rows;
  }

  // claim된 행을 대상 회차와 INNER JOIN(효과상 — LEFT JOIN + NOT NULL 가드, findPendingWithDetails와
  // 동일 패턴)해 발송 본문에 필요한 정보를 채운다. 삭제된 회차의 claim은 여기서 걸러진다
  // (deleted_at IS NULL) — system.md §10-13 "원장 단독 조회로 발송하면 삭제된 회차의 알림이
  // 나간다"의 실제 방어선.
  async findClaimedWithDetails(conn, ids) {
    if (!ids || ids.length === 0) return [];
    const result = await conn.query(
      `SELECT r.id, r.target_type, r.target_id, r.trigger_offset, r.trigger_at, r.timezone,
              r.claim_token, r.attempt_count,
        CASE r.target_type
          WHEN 0 THEN COALESCE(ei.summary, e.summary, '일정')
          WHEN 1 THEN COALESCE(ti.summary, t.summary, '할 일')
          WHEN 2 THEN sd.name
        END AS summary,
        ei.event_id, ei.start_date AS event_start_date,
        ti.task_id, ti.due_date AS task_due_date,
        sd.author_id AS special_day_author_id, sd.base_date AS special_day_base_date,
        sd.r_rule AS special_day_r_rule, sd.is_lunar AS special_day_is_lunar,
        sd.lunar_month AS special_day_lunar_month, sd.lunar_day AS special_day_lunar_day,
        sd.lunar_is_leap_month AS special_day_lunar_is_leap_month
      FROM reminders r
      LEFT JOIN event_instances ei ON r.target_type = 0 AND r.target_id = ei.id AND ei.deleted_at IS NULL
      LEFT JOIN events e           ON ei.event_id = e.id
      LEFT JOIN task_instances ti  ON r.target_type = 1 AND r.target_id = ti.id AND ti.deleted_at IS NULL
      LEFT JOIN tasks t            ON ti.task_id = t.id
      LEFT JOIN special_days sd    ON r.target_type = 2 AND r.target_id = sd.id AND sd.deleted_at IS NULL
      WHERE r.id = ANY($1::uuid[])
        AND (
          (r.target_type = 0 AND ei.id IS NOT NULL) OR
          (r.target_type = 1 AND ti.id IS NOT NULL) OR
          (r.target_type = 2 AND sd.id IS NOT NULL)
        )`,
      [ids]
    );
    return result.rows;
  }

  // 재시도 상한(attempt_count >= maxAttempts) 도달 후 최종 포기 — sent_at을 세워 종결시킨다.
  // "무한 재시도 금지" 지시의 실행부: 계속 claim 후보로 남기면 매 tick 헛돌기만 하고,
  // sent_at을 안 세우면 GC(30일, sent_at 기준) 대상에도 못 들어 영원히 고아 행으로 남는다.
  // 포기도 "종결"의 한 형태로 보고 정상 발송과 같은 방식(sent_at)으로 마감한다 — 별도
  // "실패" 상태 컬럼을 스키마에 두지 않았으므로(13컬럼 확정) 이 갈림도 sent_at 하나로 표현한다.
  async giveUp(conn, id, claimToken) {
    const result = await conn.query(
      `UPDATE reminders SET sent_at = now(), updated_at = now()
       WHERE id = $1 AND claim_token = $2
       RETURNING id`,
      [id, claimToken]
    );
    return result.rows.length > 0;
  }

  async deleteById(conn, id) {
    await conn.query(`DELETE FROM reminders WHERE id = $1`, [id]);
  }

  // 부모(회차·기념일) 삭제 시 원장 정리(SC-reminder 액션D). 호출부는 아직 없다 — event/task/special_day
  // 삭제 흐름에 cascade로 엮는 것은 이번 Task(저장 계약 수리) 범위 밖이라 별도 보고한다.
  async deleteByTarget(conn, targetType, targetId) {
    await conn.query(
      `DELETE FROM reminders WHERE target_type = $1 AND target_id = $2`,
      [targetType, targetId]
    );
  }

  // ── 파생(derive) — 이벤트·태스크·기념일 세 축이 공유하는 단일 진입점 ─────────────────
  //
  // 항목(회차 하나 또는 기념일 row)의 오프셋 집합(`{events|tasks|special_days}.reminder_offsets`)
  // 으로부터 reminders 행을 upsert한다. UNIQUE(target_type, target_id, trigger_offset)를 upsert
  // key로 재사용한다 — 오프셋이 안 바뀐 행은 id·lease 상태가 보존되고(삭제 후 재생성 아님),
  // 더 이상 없는 오프셋의 행만 지운다. offsets가 비었거나 null이면 이 대상의 행을 전부 지운다
  // (알림 전량 해제와 동치).
  //
  // 반복 항목(회차 여러 개)은 호출부가 회차마다 이 함수를 반복 호출한다 — eventDAO.createEvent가
  // 이미 인스턴스마다 루프를 도는 것과 같은 패턴이라 여기서 배열을 받지 않는다.
  //
  // ⚠️ `offsets`는 항상 호출부가 `{events|tasks|special_days}.reminder_offsets`(owner row에
  // 저장된 값)를 명시적으로 읽어 넘긴다 — 오프셋의 출처는 이 컬럼 하나뿐이다. 회차 시각만
  // 바뀐 갱신도 예외가 아니다: 호출부가 항목 row를 다시 조회해 그 `reminder_offsets`를 그대로
  // 넘기고, 이 함수는 baseTime만 새 값으로 트리거를 재계산한다(같은 오프셋이면 결과적으로
  // no-op에 가깝지만, 오프셋이 그 사이 바뀌었어도 항상 정확하다). 기존 `reminders` 행의
  // trigger_offset으로 역산하는 경로는 두지 않는다 — 저장이 깨져 있던 이력 때문에 애초에
  // 행이 없는 항목이 있었고, 그 경우 역산은 아무것도 복구하지 못했다(RLY-20260806-026 구현보고서).
  async syncTarget(conn, { targetType, targetId, baseTime, offsets, timezone = null }) {
    const list = Array.isArray(offsets)
      ? [...new Set(offsets.filter((o) => Number.isInteger(o) && o >= 0))]
      : [];

    if (list.length === 0) {
      await conn.query(
        `DELETE FROM reminders WHERE target_type = $1 AND target_id = $2`,
        [targetType, targetId]
      );
      return [];
    }

    const rows = [];
    for (const offset of list) {
      const triggerAt = new Date(new Date(baseTime).getTime() - offset * 1000);
      const { rows: upserted } = await conn.query(
        `INSERT INTO reminders (id, target_type, target_id, trigger_offset, trigger_at, timezone, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now(), now())
         ON CONFLICT (target_type, target_id, trigger_offset)
         DO UPDATE SET trigger_at = EXCLUDED.trigger_at, timezone = EXCLUDED.timezone, updated_at = now()
         RETURNING id, target_type, target_id, trigger_offset, trigger_at, timezone, sent_at, created_at, updated_at`,
        [generateUUID(), targetType, targetId, offset, triggerAt, timezone]
      );
      rows.push(upserted[0]);
    }

    // 더 이상 요청되지 않은 오프셋의 행 제거(§ 항목 재수정 시 원장 재파생).
    await conn.query(
      `DELETE FROM reminders WHERE target_type = $1 AND target_id = $2 AND trigger_offset != ALL($3::int[])`,
      [targetType, targetId, list]
    );

    return rows;
  }

  // ── 수신자 — 접근권 × 수신 선호(SC-reminder §2-A) ────────────────────────────────
  //
  // "그 사용자의 캘린더 조회 결과에 그 회차가 포함되면 그 사용자는 후보다"(§2-A-1)를 §2-A-1
  // 표 그대로 구현한다. **포함을 나열하지 않고 제외만 나열한다** — team-lead 승인(2026-08-06):
  // 상태가 나중에 추가되면 기본이 "포함"이라야 안전하다(포함 열거였다면 새 상태 추가 시 아무도
  // 모르게 알림이 조용히 안 나가는 쪽으로 깨진다). 대응표:
  //
  //   §2-A-1 표 행                          → 이 메서드의 조건
  //   Event 참가자: confirm·accept·tentative·invite·apply 포함, decline·rejected 제외
  //                                          → event_participants.state NOT IN (5,6)
  //   Task 참여자: ready·inProgress·onHold 포함, done 제외
  //                                          → task_participants.state != 3
  //   SpecialDay: 소유자(author_id)          → special_days.author_id = 해당 유저(참가자 테이블 없음)
  //
  // 멤버십(대기 신청자 자동 배제, binder_join_requests가 별도 테이블이라 binder_members JOIN
  // 자체로 걸러진다 — RLY-20260806-018/024)과 notification_level<=1(§2-A-2, 결정 63)은
  // notificationDAO가 다른 곳에서 쓰는 것과 동일 조건(dm.deleted_at IS NULL AND dm.role >= 0
  // AND dm.notification_level <= N)을 재사용한다 — 새 필터를 만들지 않는다. (파일 상단
  // MAX_NOTIFICATION_LEVEL_FOR_REMINDER 주석 참조 — RLY-20260806-190 이후 notificationDAO
  // 쪽은 이 세 조건을 한 메서드에서 합쳐 걸지 않는다, 이 파일은 그대로 합쳐 건다.)
  async getRecipients(conn, targetType, targetId) {
    if (targetType === 2) {
      const result = await conn.query(
        `SELECT bm.user_id
         FROM special_days sd
         JOIN calendars c ON c.id = sd.calendar_id
         JOIN binder_members bm ON bm.binder_id = c.binder_id AND bm.user_id = sd.author_id
           AND bm.deleted_at IS NULL AND bm.role >= 0 AND bm.notification_level <= $2
         WHERE sd.id = $1`,
        [targetId, MAX_NOTIFICATION_LEVEL_FOR_REMINDER]
      );
      return result.rows.map((row) => row.user_id);
    }

    if (targetType === 0) {
      const result = await conn.query(
        `SELECT bm.user_id
         FROM event_participants ep
         JOIN event_instances ei ON ei.id = ep.instance_id
         JOIN events e ON e.id = ei.event_id
         JOIN calendars c ON c.id = e.calendar_id
         JOIN binder_members bm ON bm.binder_id = c.binder_id AND bm.user_id = ep.user_id
           AND bm.deleted_at IS NULL AND bm.role >= 0 AND bm.notification_level <= $2
         WHERE ep.instance_id = $1 AND ep.deleted_at IS NULL
           AND ep.state NOT IN (5, 6)`,
        [targetId, MAX_NOTIFICATION_LEVEL_FOR_REMINDER]
      );
      return result.rows.map((row) => row.user_id);
    }

    // targetType === 1 (task_instance)
    const result = await conn.query(
      `SELECT bm.user_id
       FROM task_participants tp
       JOIN task_instances ti ON ti.id = tp.instance_id
       JOIN tasks t ON t.id = ti.task_id
       JOIN calendars c ON c.id = t.calendar_id
       JOIN binder_members bm ON bm.binder_id = c.binder_id AND bm.user_id = tp.user_id
         AND bm.deleted_at IS NULL AND bm.role >= 0 AND bm.notification_level <= $2
       WHERE tp.instance_id = $1 AND tp.deleted_at IS NULL
         AND tp.state != 3`,
      [targetId, MAX_NOTIFICATION_LEVEL_FOR_REMINDER]
    );
    return result.rows.map((row) => row.user_id);
  }
}

module.exports = { ReminderDAO: new ReminderDAO() };
