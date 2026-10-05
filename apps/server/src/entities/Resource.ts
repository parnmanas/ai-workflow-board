import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

// Resource pickers list by account_id on every open; the table holds large
// file_data/content blobs so an unindexed scan is expensive — perf ticket
// b3812637.
//
// Repositories are no longer Resources: `type='repository'` rows were migrated
// to Projects (entities/Project.ts) with the same id, and the controller/MCP
// reject new ones.
@Entity('resources')
@Index('idx_resources_workspace', ['account_id'])
export class Resource {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  account_id: string | null;

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
