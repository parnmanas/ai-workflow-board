import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * A mission runtime asked for permission to use a tool (docs/orchestration.md → "실행 승인").
 *
 * A member whose slot runs at `approve` trust cannot run a gated tool (shell, file edit, …) on
 * its own. Its CLI raises the request, the Runtime Host relays it here and waits, and the
 * answer comes from one of two deciders:
 *
 *   - `orchestrator` — the mission's orchestrator, when its own slot is `trusted`. It already
 *     acts on the account without asking, so approving a member's tool call grants nothing it
 *     doesn't hold itself.
 *   - `user` — everyone else: requests from a member whose orchestrator is not `trusted`, the
 *     orchestrator's own requests, and anything the orchestrator escalates or leaves unanswered.
 *
 * The row is the durable wait: the requester's CLI blocks until `status` leaves `pending`. The
 * Runtime Host long-polls it, and each poll stamps `last_polled_at` — a request nobody waits on
 * any more (process exited, attempt superseded) is cancelled by the reaper instead of lingering
 * as an approval the user can never usefully give.
 */
@Entity('orchestration_approvals')
@Index('idx_orch_approvals_mission_status', ['mission_id', 'status'])
@Index('idx_orch_approvals_status_route', ['status', 'route'])
@Index('uq_orch_approvals_request', ['requester_agent_id', 'request_key'], { unique: true })
export class OrchestrationApproval {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  account_id: string;

  @Column({ type: 'varchar' })
  mission_id: string;

  /** The step whose room raised it; null for the orchestrator's own requests (mission room). */
  @Column({ type: 'varchar', nullable: true, default: null })
  step_id: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  step_key: string | null;

  /** The room the requesting CLI session belongs to — a step attempt's room, or the mission room. */
  @Column({ type: 'varchar' })
  room_id: string;

  /** 'member' | 'orchestrator' */
  @Column({ type: 'varchar' })
  requester_role: string;

  /** Execution identity (runtime key) of the requesting session. */
  @Column({ type: 'varchar' })
  requester_agent_id: string;

  @Column({ type: 'varchar', default: '' })
  requester_name: string;

  /** The CLI's own request id — makes a re-sent request (manager retry) land on the same row. */
  @Column({ type: 'varchar' })
  request_key: string;

  @Column({ type: 'varchar' })
  tool_name: string;

  @Column({ type: 'text', default: '' })
  title: string;

  @Column({ type: 'text', default: '' })
  description: string;

  /** JSON of the tool input, truncated to a readable size. Display only — never executed. */
  @Column({ type: 'text', default: '' })
  input: string;

  /** The CLI offered a rule to remember the answer for the rest of its session. */
  @Column({ type: 'boolean', default: false })
  can_allow_session: boolean;

  /** 'pending' | 'approved' | 'denied' | 'cancelled' */
  @Column({ type: 'varchar', default: 'pending' })
  status: string;

  /** Who is asked right now: 'orchestrator' | 'user'. */
  @Column({ type: 'varchar' })
  route: string;

  /** Why a request is with the user (orchestrator not trusted, escalated, timed out, …). */
  @Column({ type: 'text', default: '' })
  route_reason: string;

  /** When the current route started — the orchestrator's answer window runs from here. */
  @Column({ type: Date })
  routed_at: Date;

  /** 'allow' | 'allow_session' | 'deny' — null while pending or cancelled. */
  @Column({ type: 'varchar', nullable: true, default: null })
  decision: string | null;

  /** 'orchestrator' | 'user' | 'system' */
  @Column({ type: 'varchar', nullable: true, default: null })
  decided_by_type: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  decided_by: string | null;

  @Column({ type: 'varchar', default: '' })
  decided_by_name: string;

  /** The decider's reason; a denial's note is handed back to the requesting agent. */
  @Column({ type: 'text', default: '' })
  decision_note: string;

  @Column({ type: Date, nullable: true, default: null })
  decided_at: Date | null;

  /** The requester is still waiting — refreshed by every long-poll. */
  @Column({ type: Date })
  last_polled_at: Date;

  /** Claim marker for the out-of-app notice to the user (one per request). */
  @Column({ type: Date, nullable: true, default: null })
  user_notified_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
