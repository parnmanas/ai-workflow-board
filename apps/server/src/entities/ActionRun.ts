import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

// One row per dispatch of an Action. The chat conversation that the agent
// holds with the user lives in the linked ChatRoom (room_id) — ActionRun is
// just the metadata: who triggered it, when, with what rendered prompt, and
// the room where the back-and-forth happened.
@Entity('action_runs')
@Index(['action_id', 'created_at'])
export class ActionRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  action_id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  // The ChatRoom hosting the agent ↔ user conversation for this Run.
  @Column({ type: 'varchar' })
  room_id: string;

  // 'user' | 'system' (scheduler) | 'agent' (future: agent-triggered runs)
  @Column({ type: 'varchar', default: 'user' })
  triggered_by_type: string;

  // user_id when triggered_by_type='user'; '' for 'system'.
  @Column({ type: 'varchar', default: '' })
  triggered_by_id: string;

  // The actual prompt sent to the agent after `{{var}}` interpolation.
  // Stored verbatim so the history view can show what the agent received,
  // even after the Action's prompt template has been edited.
  @Column({ type: 'text', default: '' })
  prompt_rendered: string;

  // ── Auto-resume linkage (ticket 524bb434) ────────────────────────────────
  // The ticket that dispatched this run because it hit an Action-resolvable
  // blocker (a deploy, a publish, …) instead of parking for a human. '' when
  // the run came from cron / manual / on-ticket-done and has no ticket to
  // resume. On completion, `complete_action_run` uses this to re-dispatch the
  // source ticket's current-column role holders — the "동일 티켓에서 계속"
  // completion criterion. Kept as a plain id (no FK) to mirror the other
  // denormalized id columns on this table and survive source-ticket deletion.
  @Column({ type: 'varchar', default: '' })
  source_ticket_id: string;

  // Run lifecycle: 'running' (dispatched, agent working) → 'succeeded' |
  // 'failed', set once by `complete_action_run`. The terminal transition is
  // idempotent — a second completion is a no-op so a re-invoked agent can't
  // double-resume the source ticket or double-count a retry. Legacy rows
  // predating this column read as 'running'; they are never auto-completed,
  // so the default is inert for historical data.
  @Column({ type: 'varchar', default: 'running' })
  status: string;

  // Free-text result the completing agent hands back: a success summary or a
  // failure reason. Mirrored into the source ticket's audit comment so the
  // outcome is reconstructable from the ticket alone.
  @Column({ type: 'text', default: '' })
  result_summary: string;

  // 1-based attempt counter. A failed run under the retry cap re-dispatches a
  // fresh run with attempt+1; the cap (ActionsService.MAX_RUN_ATTEMPTS) bounds
  // the loop so a persistently-failing high-impact Action can't retry forever.
  @Column({ type: 'int', default: 1 })
  attempt: number;

  // Run-level idempotency key (ticket 524bb434, scope 5). Minted once at the
  // first ticket-driven dispatch and carried VERBATIM across every bounded
  // retry re-dispatch of the same source-ticket→action chain, so the target
  // operation can dedupe repeated external effects (a redelivered deploy under
  // the same key is a no-op on the target side). Surfaced in the completion
  // contract appended to the run prompt. '' for cron / manual / on-ticket-done
  // runs that carry no ticket linkage.
  @Column({ type: 'varchar', default: '' })
  idempotency_key: string;

  // Set when status leaves 'running'. NULL while the run is still in flight.
  @Column({ type: Date, nullable: true, default: null })
  completed_at: Date | null;

  @CreateDateColumn()
  created_at: Date;
}
