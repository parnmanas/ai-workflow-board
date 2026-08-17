import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * Append-only timeline of everything that happened inside a Mission.
 *
 * This is the observability surface the feature exists for: the operator's
 * question is never "what is the final status" but "what did the orchestrator
 * decide, who did it hand the work to, and where is it stuck right now". The
 * step rows carry current state; this table carries the history that produced
 * it, including the orchestrator's own reasoning as it submits/revises a plan.
 *
 * Deliberately NOT reusing ActivityLog: that table is ticket-scoped
 * (entity_type/ticket_id) and is read by the board activity feed, the stuck-
 * ticket detector, and the dispatch reconciler. Mixing a non-ticket mission
 * timeline into it would either pollute those consumers' queries or force a
 * synthetic ticket id onto every row.
 */
@Entity('orchestration_events')
@Index('idx_orch_events_mission', ['mission_id'])
@Index('idx_orch_events_created', ['created_at'])
export class OrchestrationEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  mission_id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  /** Null for mission-level events (plan submitted, mission completed). */
  @Column({ type: 'varchar', nullable: true, default: null })
  step_id: string | null;

  /**
   * One of ORCHESTRATION_EVENT_TYPES (orchestration.constants.ts). Stored as a
   * plain varchar rather than an enum so adding a type never needs a schema
   * migration on either backend.
   */
  @Column({ type: 'varchar' })
  type: string;

  /** 'user' | 'agent' | 'system' */
  @Column({ type: 'varchar', default: 'system' })
  actor_type: string;

  @Column({ type: 'varchar', default: '' })
  actor_id: string;

  @Column({ type: 'varchar', default: '' })
  actor_name: string;

  /** Human-readable one-liner rendered in the timeline. */
  @Column({ type: 'text', default: '' })
  message: string;

  /** Type-specific extras (step_key, from/to status, counts, artifacts). */
  @Column({ type: 'simple-json', nullable: true, default: null })
  data: Record<string, any> | null;

  @CreateDateColumn()
  created_at: Date;
}
