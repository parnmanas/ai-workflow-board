import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * QaScenario — a reusable, step-based QA scenario definition.
 *
 * Mirrors the `Action` entity (workspace/board scope + target_agent_id +
 * max_runs FIFO budget) but adds the scenario-specific pieces: an ordered
 * `steps[]` array (the source of the visualizer), a `qa_driver` selector and
 * its `qa_driver_config`, plus `tags`.
 *
 * JSON columns use TypeORM `simple-json` so they serialize/deserialize
 * automatically (same pattern as Agent.role_prompt_meta). A fresh entity gets
 * this for free — no manual parse/stringify touch points like the Ticket
 * JSON-string columns require. Reads still coalesce null → [] in the JSON
 * projection (qaScenarioToJson) so older rows render cleanly.
 */
@Entity('qa_scenarios')
export class QaScenario {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  // null = workspace-scoped (applies to any board); <uuid> = pinned to a board.
  @Column({ type: 'varchar', nullable: true, default: null })
  board_id: string | null;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  // Ordered step definitions — each { idx, action, expect, mcp_tool?, params? }.
  // This is what the UI renders as the step flow / stepper.
  @Column({ type: 'simple-json', nullable: true, default: null })
  steps: QaScenarioStep[] | null;

  // The QA agent that runs this scenario (dispatched via ChatRoom, like Action).
  @Column({ type: 'varchar' })
  target_agent_id: string;

  // Which driver/MCP set validates the feature, e.g. 'browser', 'game-client',
  // 'http-api'. Free-text so new drivers don't require a schema change.
  @Column({ type: 'varchar', default: '' })
  qa_driver: string;

  // Driver-specific config (start URL, executable/window title, base endpoint…).
  @Column({ type: 'simple-json', nullable: true, default: null })
  qa_driver_config: Record<string, any> | null;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'simple-json', nullable: true, default: null })
  tags: string[] | null;

  @Column({ type: 'varchar', default: '' })
  created_by: string;

  // FIFO Run budget — keep at most this many QaRun rooms per scenario.
  @Column({ type: 'int', default: 20 })
  max_runs: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}

export interface QaScenarioStep {
  idx: number;
  action: string;
  expect?: string;
  mcp_tool?: string;
  params?: Record<string, any>;
}
