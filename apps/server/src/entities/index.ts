export { Workspace } from './Workspace';
export { Board } from './Board';
export { BoardColumn } from './BoardColumn';
export { Ticket } from './Ticket';
export { Comment } from './Comment';
export { CommentSummaryRun } from './CommentSummaryRun';
export { User } from './User';
export { Agent } from './Agent';
export { Channel } from './Channel';
export { ActivityLog } from './ActivityLog';
export { ApiKey } from './ApiKey';
export { PromptTemplate } from './PromptTemplate';
export { RelationTuple } from './RelationTuple';
export { ChatRoom } from './ChatRoom';
export { ChatRoomParticipant } from './ChatRoomParticipant';
export { ChatRoomMessage } from './ChatRoomMessage';
export { Resource } from './Resource';
export { ResourceEmbedding } from './ResourceEmbedding';
export { SystemSetting } from './SystemSetting';
export { Credential } from './Credential';
export { AgentErrorLog } from './AgentErrorLog';
export { UserMention } from './UserMention';
export { UserChannel } from './UserChannel';
export { TicketReadState } from './TicketReadState';
export { WorkspaceRole } from './WorkspaceRole';
export { TicketRoleAssignment } from './TicketRoleAssignment';
export { TicketAttachment } from './TicketAttachment';
export { Subagent } from './Subagent';
export { SubagentLogLine } from './SubagentLogLine';
// Persistent daily usage accumulation (ticket 8d5c6f5d, follow-up to 6dd3f968) —
// survives the 48h Subagent retention sweep; see the entity docstring for the
// disjoint-with-live invariant this table depends on.
export { AgentUsageDailyRollup } from './AgentUsageDailyRollup';
export { Action } from './Action';
export { ActionRun } from './ActionRun';
export { ActionApproval } from './ActionApproval';
export { StuckTicketAlert } from './StuckTicketAlert';
// CI red-streak dedup + delivery-state row (ticket cc1c494e) — sibling of
// StuckTicketAlert, see that entity's docstring for the durable-delivery
// contract. Auto-DDL'd by TypeORM `synchronize` (D-01) exactly like the other
// tables in this comment block; no hand-written migration needed.
export { CiRedAlert } from './CiRedAlert';
// Durable dispatch outbox (ticket e7c87517) — one row per owed agent_trigger,
// driven to `resolved` only by real forward progress. The table is auto-DDL'd
// on EVERY backend (sqlite + Postgres) by TypeORM `synchronize`, which db.ts
// hardcodes ON in all branches (D-01, never NODE_ENV-gated) — so no hand-written
// migration is needed, exactly like the sibling StuckTicketAlert (`stuck_alerts`).
export { DispatchIntent } from './DispatchIntent';
// Review-episode drift tracking (ticket 59efbde9) — one row per ticket while a
// Review episode is open. Auto-DDL'd by TypeORM `synchronize` (D-01) exactly
// like the two sibling tables above; no hand-written migration needed.
export { ReviewDriftState } from './ReviewDriftState';
export type { DriftClassification } from './ReviewDriftState';
export { ColumnRolePolicy } from './ColumnRolePolicy';
export { TicketPrerequisite } from './TicketPrerequisite';
export { TicketDuplicateDecision } from './TicketDuplicateDecision';
export { BenchmarkScore } from './BenchmarkScore';
export { BuildArtifact } from './BuildArtifact';
export { QaScenario } from './QaScenario';
export { QaRun } from './QaRun';
export { QaRunBatch } from './QaRunBatch';
export { QaSchedule } from './QaSchedule';
export { SecurityProfile } from './SecurityProfile';
export { SecurityRun } from './SecurityRun';
export { SecurityRunBatch } from './SecurityRunBatch';
export { SecuritySchedule } from './SecuritySchedule';
export { WorkspaceSchedule } from './WorkspaceSchedule';
export { WorkflowFunction } from './WorkflowFunction';
export { WorkflowFunctionRun } from './WorkflowFunctionRun';
// Deployment awareness (ticket 8ce72b18) — the current live commit per environment.
export { Deployment } from './Deployment';
export { Feature } from './Feature';
// Board knowledge base (ticket 9d0d6ac4) — per-board Lessons/Runbook entries
// injected into dispatch prompts.
export { BoardLesson } from './BoardLesson';
export { ClaudeBackendProfile } from './ClaudeBackendProfile';
export { WorkspaceClaudeBackendProfile } from './WorkspaceClaudeBackendProfile';
export { Skill } from './Skill';
export { SkillVersion } from './SkillVersion';
export { AgentSkillAssignment } from './AgentSkillAssignment';
export { RunSkillSnapshot } from './RunSkillSnapshot';
export { SkillProposal } from './SkillProposal';
export { ChildRun } from './ChildRun';
// External-channel outreach intake pipeline (ticket 2500fea3) — OutreachChannel
// (poll config + cursor) and OutreachInboundItem (dedupe ledger + noise/held
// audit + ticket backlink). Auto-DDL'd by TypeORM `synchronize` (D-01) exactly
// like DispatchIntent/ReviewDriftState; no hand-written migration needed.
export { OutreachChannel } from './OutreachChannel';
export type { OutreachChannelKind, OutreachPublishPolicy } from './OutreachChannel';
export { OutreachInboundItem } from './OutreachInboundItem';
export type { OutreachClassification, OutreachItemStatus } from './OutreachInboundItem';
// Outbound idempotency ledger + approval queue (ticket d86d0c24) — see that
// entity's docstring for the claim-before-side-effect dedupe contract.
export { OutreachOutboundPost } from './OutreachOutboundPost';
export type { OutreachOutboundKind, OutreachOutboundStatus } from './OutreachOutboundPost';
