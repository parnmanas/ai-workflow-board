/**
 * 마이그레이션 테이블 순서 레지스트리 (ticket 0f638509).
 *
 * FK 위상 순서 — 부모가 자식보다 먼저 와야 삽입 시 FK 위반이 나지 않는다.
 * 전체 79개 엔티티를 전수 조사한 결과, 실제 DB 레벨 FK 제약은 정확히
 * 11개(9개 엔티티)뿐이고 나머지는 앱이 관례로 지키는 평문 id 컬럼(FK
 * 미강제)이다 — 그래서 이 순서는 그 11개 제약만 정확히 지키면 되고, 나머지
 * 63개는 "대략 의존 방향"으로만 배치했다(정확도가 필요 없음 — sqlite/dev는
 * 기본적으로 FK 자체를 강제하지 않고, Postgres도 이 63개엔 제약이 없다).
 *
 * 실제 FK 11개:
 *   Board.workspace_id → Workspace
 *   BoardColumn.board_id → Board
 *   ApiKey.agent_id → Agent (nullable)
 *   ChatRoomParticipant.room_id → ChatRoom
 *   Ticket.column_id → BoardColumn (nullable)
 *   Ticket.parent_id → Ticket (self, nullable) — ★ 아래 특별 처리 참고
 *   Comment.ticket_id → Ticket
 *   TicketAttachment.ticket_id → Ticket (nullable)
 *   TicketPrerequisite.ticket_id → Ticket
 *   TicketPrerequisite.prerequisite_ticket_id → Ticket
 *   SubagentLogLine.subagent_id → Subagent
 *
 * ★ Ticket.parent_id 자기참조: PK가 랜덤 UUID라 "id ASC" keyset pagination
 * 순서와 부모/자식 관계 사이에 아무 상관이 없다 — 그대로 페이지 단위 삽입하면
 * 자식이 부모보다 먼저 오는 페이지가 반드시 생기고, Postgres는 그 순간 FK
 * 위반으로 즉시 실패한다(반면 sqlite/dev는 기본 FK 미강제라 조용히 통과 —
 * 완료 기준 5의 sqlite→Postgres 시나리오에서만 터지는 클래스의 버그). 그래서
 * MigrationRunService는 Ticket 테이블 pull 시 매 행의 parent_id를 NULL로
 * 바꿔서 삽입한 뒤, 전체 pull이 끝나면 별도의 재개 가능한 backfill 패스로
 * 원래 parent_id 값을 UPDATE한다 — 이 파일은 그 사실만 문서화하고 실제 로직은
 * migration-run.service.ts의 backfillTicketParentIds()에 있다.
 *
 * Ontology Graph 5종(ontology_* 테이블)은 의도적으로 제외한다 — sql.js에서
 * 별도 세컨더리 DataSource로 분리되어 있어(db.ts ONTOLOGY_ENTITIES) 이
 * migration의 단일 primary DataSource pull loop로는 애초에 닿지 않고,
 * 재추출 가능한 파생 데이터라 v1 범위 밖으로 명시적으로 뺀다(완료 기준에
 * 온톨로지 그래프 이관 요구 없음). Postgres에서는 같은 단일 DataSource에
 * 있어 기술적으로는 닿지만, sqlite/Postgres 양쪽에서 동일하게 취급하기 위해
 * 백엔드와 무관하게 항상 제외한다.
 */
export const MIGRATION_EXCLUDED_TABLE_PREFIX = 'ontology_';

// migration_runs(MigrationRun)는 이관 대상 데이터가 아니라 이 기능 자신의
// 제어 테이블이다 — 소스가 자기 DataSource의 entityMetadatas를 그대로
// 보고하면 MigrationRun도 함께 잡히는데, MIGRATION_ENTITY_ORDER에는
// 의도적으로 없으므로 필터링하지 않으면 "entities_unknown_to_dest"에
// 걸려 동일 빌드끼리도 프리플라이트가 항상 실패한다(리뷰 라운드1 P1 —
// 소스/도착지 어느 쪽이든 이 이름으로 걸러야 한다).
export const MIGRATION_CONTROL_ENTITY_NAMES = new Set(['MigrationRun']);

// 완료 기준 7(스킵 플래그) 대상 — MigrationRun.phase='core' 패스에서
// skip_attachments=1이면 이 목록만 건너뛰고, 이후 pull-attachments
// 엔드포인트가 이 목록만 별도로 채운다. base64 TEXT/임베딩 벡터라 용량을
// 지배하는 두 테이블.
export const ATTACHMENT_ENTITIES = ['TicketAttachment', 'ResourceEmbedding'];

// 복합 PK 엔티티 — 전체 79개 중 유일. 제네릭 단일 컬럼 keyset pagination이
// 아니라 (ticket_id, prerequisite_ticket_id) 튜플 페이지네이션이 필요하다.
export const COMPOSITE_PK_ENTITIES = ['TicketPrerequisite'];

// 자기참조 FK 컬럼 특별 처리 대상 — entity name -> nullable self-FK column.
export const SELF_FK_BACKFILL: Record<string, string> = {
  Ticket: 'parent_id',
};

// 부모 → 자식 순서. 위 11개 실FK만 정확히 지키면 되고, 나머지는 참고용 배치.
export const MIGRATION_ENTITY_ORDER: string[] = [
  // 독립 루트
  'Workspace', 'User', 'SystemSetting', 'ClaudeBackendProfile', 'SkillTap', 'Skill',
  'WorkspaceRole', 'Channel', 'Credential', 'WorkflowFunction', 'Resource',
  'PromptTemplate', 'WorkspaceClaudeBackendProfile',

  // Workspace/Credential에 의존
  'Agent',
  'ApiKey', // FK: Agent
  'AgentErrorLog', 'AgentUsageDailyRollup',

  // Board 계열
  'Board', // FK: Workspace
  'BoardColumn', // FK: Board
  'ColumnRolePolicy', 'BoardLesson', 'UserChannel', 'Deployment',
  'OrchestrationTeam', 'Action', 'QaScenario', 'SecurityProfile', 'OutreachChannel',
  'CliLoginSession',
  'ResourceEmbedding', // (연성) Resource 의존, 위에서 이미 삽입됨

  // Skill 체인 / 배치-런
  'SkillProposal', 'SkillVersion', 'AgentSkillAssignment', 'RunSkillSnapshot',
  'QaRunBatch', 'QaSchedule', 'SecurityRunBatch', 'SecuritySchedule',

  // ChatRoom 계열
  'ChatRoom',
  'ChatRoomParticipant', // FK: ChatRoom
  'WorkspaceSchedule',
  'OrchestrationTeamMember', 'OrchestrationMission', 'OrchestrationStep', 'OrchestrationEvent',

  // Ticket 및 그 자식들
  'Ticket', // FK: BoardColumn; self-FK parent_id → 별도 backfill 패스
  'ChatRoomMessage',
  'Comment', // FK: Ticket
  'TicketAttachment', // FK: Ticket (skippable)
  'TicketPrerequisite', // FK: Ticket ×2, 복합 PK
  'TicketCompletionVerification', 'TicketCompletionVerificationAttempt',
  'TicketReadState', 'TicketRoleAssignment', 'StuckTicketAlert', 'ReviewDriftState',
  'UserMention', 'BenchmarkScore', 'CiRedAlert', 'DispatchIntent', 'ActionRun',
  'ActionApproval', 'Feature', 'WorkflowFunctionRun', 'CommentSummaryRun',
  'Subagent',
  'SubagentLogLine', // FK: Subagent
  'ChildRun', 'QaRun', 'SecurityRun', 'BuildArtifact', 'OutreachInboundItem',
  'OutreachOutboundPost', 'TicketDuplicateDecision',

  // 완전 다형적(polymorphic)/미강제 — 어디에 있어도 안전, 맨 뒤에 배치
  'ActivityLog', 'RelationTuple',
];

/**
 * 마이그레이션 대상 엔티티 클래스 해석. barrel에는 클래스 export 외에
 * `export type { ... }` 도 섞여 있는데, 그건 런타임에 아예 존재하지 않으므로
 * `typeof === 'function'` 체크만으로 자연히 걸러진다. 화이트리스트
 * (MIGRATION_ENTITY_ORDER)에 없는 이름은 거부 — export 컨트롤러가 임의
 * 엔티티명을 긁어가는 표면이 되지 않도록 막는다.
 */
const ALLOWED_ENTITY_NAMES = new Set(MIGRATION_ENTITY_ORDER);

export function resolveMigrationEntity(entitiesBarrel: Record<string, unknown>, entityName: string): Function | null {
  if (!ALLOWED_ENTITY_NAMES.has(entityName)) return null;
  const ctor = entitiesBarrel[entityName];
  return typeof ctor === 'function' ? ctor : null;
}

/**
 * export controller의 `GET meta`가 보고할 테이블 후보 목록 — 단일 정의를
 * 컨트롤러와 테스트가 함께 쓴다(리뷰 라운드1 P1). 온톨로지 테이블과
 * MigrationRun 자신을 제외하는 필터가 export 쪽과 preflight 비교 쪽
 * 두 군데서 따로 구현되어 있으면 한쪽만 고치고 잊어버리기 쉽다 — 실제로
 * 이 필터 자체가 여기 하나로 모이기 전엔 export 쪽에 MigrationRun 제외가
 * 아예 빠져 있어서 동일 빌드 소스/도착지끼리도 프리플라이트가 항상
 * 실패했다. row_count는 DB 접근이 필요해 여기 포함하지 않는다 — 호출자가
 * 필요하면 반환된 (entity, table) 목록으로 직접 채운다.
 */
export function listMigratableEntityMetadata(dataSource: { entityMetadatas: Array<{ name: string; tableName: string }> }): { entity: string; table: string }[] {
  const out: { entity: string; table: string }[] = [];
  for (const meta of dataSource.entityMetadatas) {
    if (meta.tableName.startsWith(MIGRATION_EXCLUDED_TABLE_PREFIX)) continue;
    if (MIGRATION_CONTROL_ENTITY_NAMES.has(meta.name)) continue;
    out.push({ entity: meta.name, table: meta.tableName });
  }
  return out;
}
