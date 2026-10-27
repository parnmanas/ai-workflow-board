import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type BusinessTaskEntryKind = 'progress' | 'result' | 'decision' | 'request' | 'resolution' | 'change';

/** A task's journal survives edits to its current description, notes and status. */
@Entity('business_task_entries')
@Index(['account_id', 'company_id', 'task_id', 'revision'])
@Index(['task_id', 'resolves_entry_id'], { unique: true })
export class BusinessTaskEntry {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) account_id: string;
  @Column({ type: 'varchar' }) company_id: string;
  @Column({ type: 'varchar' }) task_id: string;
  @Column({ type: 'varchar' }) kind: BusinessTaskEntryKind;
  @Column({ type: 'text' }) content: string;
  @Column({ type: 'varchar' }) actor_id: string;
  @Column({ type: 'varchar' }) author: string;
  @Column({ type: 'varchar' }) author_type: string;
  @Column({ type: 'integer' }) revision: number;
  @Column({ type: 'varchar', nullable: true }) resolves_entry_id: string | null;
  @Column({ type: 'simple-json', nullable: true }) changes: Record<string, { before: unknown; after: unknown }> | null;
  @CreateDateColumn() created_at: Date;
}
