const { generateUUID } = require('../utils/uuid');

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

  // 일회성(Event·Task) 발송 완료 — sent_at 기록 후 종결(§2-B). 호출부는 2단계 dispatch.
  async markSent(conn, id) {
    await conn.query(
      `UPDATE reminders SET sent_at = now(), updated_at = now() WHERE id = $1`,
      [id]
    );
  }

  // SpecialDay(target_type=2) 발송 후 다음 해로 롤링 — sent_at은 영구 NULL 유지, lease 초기화(§2-B·§5A).
  // 로직 자리만 잡아 둔다(claim 판정·음력 롤링 계산은 2단계 dispatch 몫).
  async rollSpecialDay(conn, id, nextTriggerAt) {
    await conn.query(
      `UPDATE reminders
       SET trigger_at = $1, attempt_count = 0, claim_token = NULL, claimed_at = NULL,
           next_attempt_at = NULL, updated_at = now()
       WHERE id = $2`,
      [nextTriggerAt, id]
    );
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
}

module.exports = { ReminderDAO: new ReminderDAO() };
