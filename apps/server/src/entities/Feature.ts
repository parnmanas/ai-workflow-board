import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * Feature (Epic intake) — the *entry point* of the "one-stop automated
 * development" loop (ticket aae7644c).
 *
 * A Feature captures one long requirement/spec, then walks a small state
 * machine that turns it into a running board chain WITHOUT a new execution
 * engine — the generated artifacts are ordinary tickets, so the existing
 * trigger loop / prerequisites / next_ticket_id machinery drives them from
 * there.
 *
 *   draft     — created, not yet dispatched to a planner.
 *   planning  — dispatched to the board planner holder (a chat-room spawn, the
 *               same shape as WorkspaceSchedule/QA-run). Awaiting a structured
 *               chain proposal.
 *   proposed  — the planner submitted a `proposal` (tickets + prereq edges).
 *               Awaiting human/reporter approval.
 *   approved  — approval accepted (transient; the atomic chain build flips it to
 *               `running`). Kept in the union for manual/audit use.
 *   running   — the ticket chain was created + wired + the first ticket
 *               dispatched. `generated_ticket_ids` is populated.
 *   done      — every generated ticket reached a terminal column.
 *   rejected  — the reporter rejected the proposal with `feedback`; a re-plan
 *               round moves it back to `planning`.
 *
 * JSON columns use TypeORM `simple-json` (auto (de)serialize — same pattern as
 * QaScenario). Reads still coalesce null → []/null in the projection
 * (featureToJson) so older rows render cleanly.
 */
export type FeatureStatus =
  | 'draft'
  | 'planning'
  | 'proposed'
  | 'approved'
  | 'running'
  | 'done'
  | 'rejected';

@Entity('features')
export class Feature {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  // Target board the generated ticket chain lands on. null = resolved lazily
  // from the caller's context; a value pins the chain to a board.
  @Column({ type: 'varchar', nullable: true, default: null })
  board_id: string | null;

  @Column({ type: 'varchar' })
  title: string;

  // The raw requirement / spec text. TEXT — free-form, multi-line, potentially long.
  @Column({ type: 'text', default: '' })
  requirement: string;

  // State machine (see class docstring). free-text varchar so a new state does
  // not require a schema change.
  @Column({ type: 'varchar', default: 'draft' })
  status: FeatureStatus;

  // The agent the planning round is dispatched to (the board's planner holder,
  // or the submitter as a fallback). Empty = intake created without auto-plan.
  @Column({ type: 'varchar', default: '' })
  planner_agent_id: string;

  // The structured chain proposal the planner submits. null until `proposed`.
  @Column({ type: 'simple-json', nullable: true, default: null })
  proposal: FeatureChainProposal | null;

  // Ids of the tickets created when the proposal was approved. null until `running`.
  @Column({ type: 'simple-json', nullable: true, default: null })
  generated_ticket_ids: string[] | null;

  // The most recent planning dispatch room (audit / re-open the conversation).
  @Column({ type: 'varchar', default: '' })
  planning_room_id: string;

  // Reviewer feedback captured on the last rejection — threaded into the
  // re-plan dispatch prompt so the planner can revise.
  @Column({ type: 'text', default: '' })
  feedback: string;

  // Chat-promotion provenance: the chat room this Feature was promoted from
  // ("이거 기능으로 등록해줘"). Empty when created via UI/MCP directly.
  @Column({ type: 'varchar', default: '' })
  source_chat_room_id: string;

  @Column({ type: 'varchar', default: '' })
  created_by: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}

/**
 * A structured feature-chain proposal — the planner's deliverable. NOT free
 * text: the server renders a preview from it and, on approval, builds the
 * ticket chain atomically.
 */
export interface FeatureChainProposal {
  // One-line summary of the decomposition strategy (optional, shown in preview).
  summary?: string;
  // The tickets to create, in the intended reading order.
  tickets: FeatureProposedTicket[];
  // Prerequisite (dependency) edges between the proposed tickets, keyed by the
  // tickets' proposal-local `key`. `from` must finish before `to` may start.
  edges?: FeatureChainEdge[];
}

export interface FeatureProposedTicket {
  // Stable reference within THIS proposal (e.g. "t1"). Edges reference these.
  key: string;
  title: string;
  description?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  labels?: string[];
  // Abstract effort preset (resolved per-CLI at dispatch). null/'' = board default.
  effort_preset?: string | null;
  // Target column NAME on the board (case-insensitive). Defaults to the board's
  // first non-terminal column when omitted.
  column_name?: string;
  // Role holders for the generated ticket. When omitted they default to the
  // Feature's planner/creator so the chain is never born zero-holder.
  assignee_id?: string;
  reporter_id?: string;
  reviewer_id?: string;
}

export interface FeatureChainEdge {
  // proposal-local key of the prerequisite (blocker) ticket.
  from: string;
  // proposal-local key of the dependent ticket.
  to: string;
}
