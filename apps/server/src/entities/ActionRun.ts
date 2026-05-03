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

  @CreateDateColumn()
  created_at: Date;
}
