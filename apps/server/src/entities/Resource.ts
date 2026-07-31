import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

// Resource pickers list by (workspace_id, board_id IS NULL) on every open; the
// table holds large file_data/content blobs so an unindexed scan is expensive
// — perf ticket b3812637. The board_id half of the index still matches the
// query (see board_id's own comment below), even though every row now has it
// NULL.
@Entity('resources')
@Index('idx_resources_workspace_board', ['workspace_id', 'board_id'])
export class Resource {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  workspace_id: string | null;

  // Legacy compatibility column. Boot migration (65adf0b) clears it and new
  // Board-scoped Resources are rejected at create() — always NULL going
  // forward; Resources are Global/Workspace-owned only.
  @Column({ type: 'varchar', nullable: true, default: null })
  board_id: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  credential_id: string | null;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  @Column({ type: 'varchar', default: 'link' })
  type: string;

  @Column({ type: 'varchar', default: '' })
  url: string;

  // For type='repository': the branch tickets default to when no per-ticket
  // base_branch is set. Empty leaves the choice to git's `origin/HEAD`. Stored
  // alongside the repo so the same default applies across every ticket that
  // points at this resource.
  @Column({ type: 'varchar', default: '' })
  default_branch: string;

  @Column({ type: 'text', default: '' })
  content: string;

  @Column({ type: 'text', default: '' })
  file_data: string;

  @Column({ type: 'varchar', default: '' })
  file_name: string;

  @Column({ type: 'varchar', default: '' })
  file_mimetype: string;

  @Column({ type: 'varchar', default: '[]' })
  tags: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
