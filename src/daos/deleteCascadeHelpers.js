/**
 * src/daos/deleteCascadeHelpers.js
 * =========================================
 * EventDAO·TaskDAO가 공유하는 "회차 삭제 → 하위(참가자·리마인더) 전파" 로직.
 * (RLY-20260806-027)
 *
 * 이벤트·태스크는 각자 자기 인스턴스 테이블(event_instances/task_instances)과
 * 참가자 테이블(event_participants/task_participants) 이름이 달라 완전히 같은
 * SQL을 쓸 수 없지만, "회차 id 집합이 주어지면 그 참가자를 soft delete하고
 * 그 리마인더를 hard delete한다"는 로직 자체는 동일하다. 이 함수 하나를 양쪽
 * DAO(softDeleteEvent·softDeleteEventInstance·softDeleteTask·softDeleteTaskInstance)가
 * 호출한다 — 두 벌로 쪼개면 한쪽만 고쳐지는 날이 온다(팀리드 지시).
 *
 * 참가자: soft delete. `AND deleted_at IS NULL` 가드로 이미 지워진 행의 삭제
 *   시각을 덮지 않는다(30일 정리 cron의 기준 시각을 밀지 않기 위함).
 *
 * 리마인더: hard delete. `reminders`는 13컬럼 스키마([확정] 2026-08-03,
 *   config/schema.sql·docs/database/schema.md §10-4)로 재설계되며 `deleted_at`
 *   컬럼이 제거됐다 — soft delete할 컬럼이 없다. 설계상 발송 방어의 **주 방어선**은
 *   dispatch 쿼리의 INNER JOIN(`deleted_at IS NULL`)이고, 이 delete는 **보조**
 *   (행 누적 방지)다 — schema.md 10-4 절 "⚠️ 발송 방어(주 방어선)"·"행 누적 방지(보조)"
 *   참조. 즉 이 delete가 실패해도 오발송으로 이어지진 않지만, 안 하면 sent_at 30일
 *   경과 GC가 올 때까지 고아 행이 쌓인다.
 *
 * participantTable은 항상 이 파일 내부(eventDAO.js/taskDAO.js)에서만 하드코딩
 * 리터럴로 전달되는 신뢰 값이다 — 사용자 입력이 SQL에 보간되지 않는다.
 */

// reminders.target_type (SMALLINT, config/schema.sql 956행) — 0=event_instance 1=task_instance 2=special_day
const REMINDER_TARGET_TYPE = Object.freeze({
  EVENT_INSTANCE: 0,
  TASK_INSTANCE: 1,
});

/**
 * @param {object} conn - pg client/pool
 * @param {object} opts
 * @param {'event_participants'|'task_participants'} opts.participantTable
 * @param {number} opts.reminderTargetType - REMINDER_TARGET_TYPE 값
 * @param {string[]} opts.instanceIds - 대상 회차 id 목록(빈 배열이면 no-op)
 */
async function cascadeDeleteInstanceChildren(conn, { participantTable, reminderTargetType, instanceIds }) {
  if (!instanceIds || instanceIds.length === 0) return;

  await conn.query(
    `UPDATE ${participantTable}
     SET deleted_at = now(), updated_at = now()
     WHERE instance_id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [instanceIds]
  );

  await conn.query(
    `DELETE FROM reminders
     WHERE target_type = $1 AND target_id = ANY($2::uuid[])`,
    [reminderTargetType, instanceIds]
  );
}

module.exports = { cascadeDeleteInstanceChildren, REMINDER_TARGET_TYPE };
