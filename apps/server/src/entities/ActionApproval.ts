import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

// Human approval GRANT for a high-impact Action run (ticket 524bb434, scope 5).
//
// This is the trust anchor the pre-execution approval gate keys on. The problem
// it solves: an agent must NOT be able to authorise its own high-impact deploy.
// Earlier the agent passed `approved_by_user_id` on `run_action` and the server
// merely checked the id belonged to an admin — an agent could look up any
// admin's id and forge the approval + audit trail. That is fail-open.
//
// The fix is to DECOUPLE "who claims to approve" from "real approval evidence":
//   - A grant row is created ONLY through a human-authenticated path
//     (POST /api/actions/:id/approvals, session Bearer → real admin User). The
//     approver identity is taken from the authenticated session (currentUser),
//     never from request/agent input — an agent has no session token, so it
//     cannot mint a grant.
//   - The grant is BOUND to a single (action_id, source_ticket_id) pair and is
//     ONE-TIME: `dispatch` atomically flips status pending → consumed and stamps
//     the run that consumed it. A second run, a different ticket, or a different
//     action finds no usable grant and is rejected + parked.
//   - `expires_at` bounds how long a standing approval is valid.
//
// The consuming run copies its `approved_by`/`approved_at` audit attribution
// FROM this record (the real human), so the audit trail can never be forged by
// the caller. Kept as plain id columns (no FK) to mirror the other denormalised
// id columns on action_runs and survive source-ticket / action deletion.
@Entity('action_approvals')
@Index(['action_id', 'source_ticket_id', 'status'])
export class ActionApproval {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  action_id: string;

  // The ticket this grant authorises the Action to run for. A grant is only ever
  // consumed by a ticket-driven dispatch whose source_ticket_id matches — the
  // binding that stops a grant for ticket A from clearing the gate for ticket B.
  @Column({ type: 'varchar' })
  source_ticket_id: string;

  // The authenticated admin User who granted approval. Server-derived from the
  // session — the unforgeable evidence. Copied onto the consuming run's
  // `approved_by` so who-approved is reconstructable from the run alone.
  @Column({ type: 'varchar' })
  approved_by: string;

  @Column({ type: 'varchar', default: '' })
  approved_by_name: string;

  // 'pending' → 'consumed' (a run used it) | 'expired' (the gate found it past
  // expires_at and retired it). A guarded UPDATE (WHERE id=… AND status='pending')
  // flips pending→consumed exactly once, so two racing dispatches cannot both
  // consume the same grant — the one-time-use guarantee.
  @Column({ type: 'varchar', default: 'pending' })
  status: string;

  // The run that consumed this grant ('' while still pending). Together with
  // consumed_at this makes the grant→run link auditable.
  @Column({ type: 'varchar', default: '' })
  consumed_by_run_id: string;

  @Column({ type: Date, nullable: true, default: null })
  consumed_at: Date | null;

  // Standing-approval expiry. NULL = never expires. A grant past this instant is
  // treated as absent by the gate (rejected + parked) even while status='pending'.
  @Column({ type: Date, nullable: true, default: null })
  expires_at: Date | null;

  @CreateDateColumn()
  created_at: Date;
}
