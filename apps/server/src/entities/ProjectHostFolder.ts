import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * The main clone folder of a Project on one Runtime Host (docs/tickets.md).
 * Ticket worktrees are cut from it and mission members are told to work in it,
 * so agents on different hosts never have to guess where the project lives.
 * `path` is an absolute path on that host; the host itself is never asked to
 * create or validate it here — the manager clones into it on first use.
 */
@Entity('project_host_folders')
@Index('uq_project_host_folder', ['project_id', 'host_id'], { unique: true })
export class ProjectHostFolder {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  project_id: string;

  // RuntimeHost.id
  @Column({ type: 'varchar' })
  host_id: string;

  @Column({ type: 'varchar' })
  path: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
