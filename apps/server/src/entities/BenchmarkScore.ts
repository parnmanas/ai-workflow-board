import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, Unique } from 'typeorm';

/**
 * BenchmarkScore — one evaluator's score for one candidate on one dimension.
 *
 * Benchmark feature (ticket 684c012b) reuses the existing board/ticket/worktree
 * machinery instead of inventing a new board type. A *benchmark run* is a parent
 * ticket holding the task definition; each *candidate* is a child ticket whose
 * assignee is a distinct agent working in its own (ticket, role) worktree. When
 * candidates reach a `review`-kind column, evaluator agents score each one and
 * persist the result here — M evaluators × N candidates = M×N rows.
 *
 * Why a score table and not reviewer role assignments: `TicketRoleAssignment`
 * is unique on (ticket, role), so the reviewer slot can hold exactly one agent.
 * Modelling every evaluator's verdict as its own row sidesteps that constraint
 * and lets the leaderboard aggregate across an arbitrary evaluator pool.
 *
 * `run_ticket_id` denormalizes the candidate's parent (run) so run- and
 * agent-level leaderboard aggregations don't need a join back through Ticket.
 *
 * Both columns are indexed because the two read paths are "all scores for a
 * run" (run leaderboard) and "all scores for a candidate" (upsert dedup +
 * candidate detail). The unique constraint enforces one score per
 * (candidate, evaluator, dimension) so a re-score is an UPDATE, not a duplicate.
 */
@Entity('benchmark_scores')
@Index('idx_benchmark_scores_run', ['run_ticket_id'])
@Index('idx_benchmark_scores_candidate', ['candidate_ticket_id'])
@Unique('uq_benchmark_score_candidate_evaluator_dimension', [
  'candidate_ticket_id',
  'evaluator_agent_id',
  'dimension',
])
export class BenchmarkScore {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Parent/run ticket that defines the task. Denormalized from the candidate's
  // parent_id at write time so aggregations key off it directly.
  @Column({ type: 'varchar' })
  run_ticket_id: string;

  // The candidate (child) ticket being scored.
  @Column({ type: 'varchar' })
  candidate_ticket_id: string;

  // Agent that produced this score (the evaluator). Stored as the agent id —
  // the leaderboard resolves display names lazily, matching the rest of the
  // codebase (focus-tickets, activity log) which carry ids + late name lookup.
  @Column({ type: 'varchar' })
  evaluator_agent_id: string;

  // Scoring dimension, e.g. 'correctness' | 'quality' | 'speed'. Free-form
  // string so a run's rubric can define its own axes without a schema change.
  @Column({ type: 'varchar' })
  dimension: string;

  // Numeric score. `float` maps to REAL on sqlite and double precision on
  // Postgres — both fine for the small bounded rubric ranges we expect
  // (e.g. 0..10). The service clamps/validates the range; the column is permissive.
  @Column({ type: 'float' })
  score: number;

  // Free-text justification the evaluator wrote for this score. Surfaced in the
  // leaderboard candidate breakdown so a human can audit why a number was given.
  @Column({ type: 'text', default: '' })
  rationale: string;

  @CreateDateColumn()
  created_at: Date;
}
