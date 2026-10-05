import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * A project is one git repository plus what every feature needs to work on it
 * (docs/tickets.md). It replaces Resources of type='repository' — those rows
 * were migrated with the SAME id, so stored references (ticket project,
 * QA/Security/Action/Mission `repo_ref`, ontology graphs) keep resolving.
 *
 * Where the project is checked out on each Runtime Host lives in
 * ProjectHostFolder — one main clone per (project, host).
 */
@Entity('projects')
@Index('idx_projects_workspace', ['account_id'])
export class Project {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  account_id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  @Column({ type: 'varchar', default: '' })
  repo_url: string;

  // Base branch when a ticket/run names none. Empty leaves it to `origin/HEAD`.
  @Column({ type: 'varchar', default: '' })
  default_branch: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  credential_id: string | null;

  // JSON text (common/clone-policy.ts) merged key-by-key over the workspace
  // default by resolveClonePolicy. null = no override.
  @Column({ type: 'text', nullable: true, default: null })
  clone_policy: string | null;

  // Land through a pull request instead of a direct fast-forward merge.
  @Column({ type: 'boolean', default: false })
  use_pr: boolean;

  // Shown to every agent that works on the project (build/test commands, conventions).
  @Column({ type: 'text', default: '' })
  instructions: string;

  // RuntimeSpec applied to new tickets of this project that name no assignee.
  @Column({ type: 'simple-json', nullable: true, default: null })
  default_assignee: Record<string, any> | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
