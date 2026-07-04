import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * BoardLesson — board-scoped knowledge base entry (ticket 9d0d6ac4).
 *
 * A "Lesson/Runbook" is a short, imperative note captured from a past
 * incident ("빌드 전 worktree node_modules 심링크 확인", "red-run 은 먼저
 * 분류 프리플라이트") so that the NEXT subagent spawned on the board sees it
 * automatically, instead of the lesson dying in one ticket's comment thread.
 *
 * Injection rides the existing harness plumbing: at dispatch time
 * (`TriggerLoopService._emitTrigger` — the single chokepoint every dispatch
 * flows through) the board's active lessons are composed into a block and
 * appended onto the resolved `harness_config.system_prompt_append`, right
 * after the board-language instruction. So a board with ZERO lessons ships
 * byte-identical prompts to before (regression guard, DoD).
 *
 * Scoping:
 *  - `board_id` is the primary scope — the injection query is
 *    `WHERE board_id = :id AND active = true` (indexed).
 *  - `workspace_id` is carried for workspace-scoped listing / future
 *    workspace-level lessons and for cheap cascade cleanup reasoning; it is
 *    NOT part of the injection filter.
 *
 * Abuse guard: title/body length + total injected-byte caps live in
 * `common/board-lessons.ts`, enforced on the write path (MCP/REST reject an
 * over-long lesson) and again at compose time (belt-and-suspenders so a
 * legacy over-long row can never bloat a prompt).
 */
@Entity('board_lessons')
// Injection reads active lessons for one board on every dispatch — keep it indexed.
@Index('idx_board_lessons_board_active', ['board_id', 'active'])
export class BoardLesson {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Workspace the lesson belongs to (carried for scoped listing; not part of
  // the board-level injection filter).
  @Column({ type: 'varchar', nullable: true })
  workspace_id: string | null;

  // Owning board. The injection filter is board_id + active.
  @Column({ type: 'varchar' })
  board_id: string;

  // Short human-readable headline (e.g. "worktree node_modules 부재").
  @Column({ type: 'varchar', default: '' })
  title: string;

  // The imperative runbook body — kept short by a length cap (see
  // common/board-lessons.ts). This is what actually lands in the prompt.
  @Column({ type: 'text', default: '' })
  body: string;

  // JSON array string of free-form tags (build/QA/git/env…). Stored as text
  // (JSON-array-as-text convention). Tag→context matching is v2; for now tags
  // are metadata surfaced in the UI only.
  @Column({ type: 'text', nullable: true, default: null })
  tags: string | null;

  // Optional deep-link back to the ticket the lesson was learned on.
  @Column({ type: 'varchar', nullable: true, default: null })
  source_ticket_id: string | null;

  // Deactivated lessons are retained for audit but never injected/listed-active.
  @Column({ type: 'boolean', default: true })
  active: boolean;

  // Incremented (best-effort) each time this lesson is injected into a
  // dispatch prompt — a cheap "is this lesson still earning its keep?" signal
  // surfaced in the UI.
  @Column({ type: 'int', default: 0 })
  hit_count: number;

  // Attribution — display name of the agent/user who filed the lesson.
  @Column({ type: 'varchar', default: '' })
  created_by: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
