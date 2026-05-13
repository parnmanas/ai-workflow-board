import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { nullablePassThroughUuid } from '../database/uuid-column';

@Entity('resources')
export class Resource {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  workspace_id: string;

  @Column({ type: 'uuid', nullable: true, transformer: nullablePassThroughUuid })
  board_id: string | null;

  @Column({ type: 'uuid', nullable: true, transformer: nullablePassThroughUuid })
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
