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

/**
 * 항목(event/task) 삭제 → 그 항목에 연결된 section 링크 전파. (RLY-20260806-029)
 *
 * **항목 단위에서만 부른다 — 회차(instance) 삭제에서는 부르지 않는다.** `event_sections`/
 * `task_sections`는 owner-키 자원이라 회차가 아니라 항목에 붙는다(domain.md §426
 * "owner-키 자원(섹션 연결·첨부)", docs/calendar/SC-event.md H16 — 인스턴스만 삭제할 때는
 * participants·reminders만 전파되고 event_sections는 언급되지 않는다). H15(전체 삭제)만
 * "events.deleted_at + CASCADE (event_instances·event_participants·event_sections)"로
 * event_sections를 포함한다.
 *
 * soft delete인 이유(hard DELETE가 아닌): config/schema.sql에 두 테이블 다 `deleted_at`
 * 컬럼이 있고, cleanupJobs.js STEPS(30일 하드삭제 배치)에 둘 다 등재돼 있으며,
 * SectionDAO.softDelete()(반대 방향 캐스케이드)가 이미 둘 다 soft UPDATE로 처리하는
 * 선례이고, design_intent.md §event_sections가 "soft delete로 연결 해제 이력 유지"라고
 * 명시한다 — 네 근거 전부가 soft를 가리킨다. `EventDAO.removeSection`의 구 hard DELETE가
 * 이 근거들과 어긋나는 쪽이었다(이번에 함께 수정).
 *
 * `AND deleted_at IS NULL` 가드로 이미 해제된 연결의 시각을 덮지 않는다(참가자·리마인더
 * 전파와 동일 원칙).
 *
 * @param {object} conn
 * @param {object} opts
 * @param {'event_sections'|'task_sections'} opts.sectionTable
 * @param {'event_id'|'task_id'} opts.itemColumn
 * @param {string} opts.itemId
 */
async function cascadeDeleteItemSections(conn, { sectionTable, itemColumn, itemId }) {
  await conn.query(
    `UPDATE ${sectionTable}
     SET deleted_at = now(), updated_at = now()
     WHERE ${itemColumn} = $1 AND deleted_at IS NULL`,
    [itemId]
  );
}

module.exports = { cascadeDeleteInstanceChildren, cascadeDeleteItemSections, REMINDER_TARGET_TYPE };
