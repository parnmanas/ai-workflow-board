import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany, ManyToOne, JoinColumn } from 'typeorm';
import { BoardColumn } from './BoardColumn';
import { Workspace } from './Workspace';

@Entity('boards')
export class Board {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true })
  workspace_id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  @Column({ type: 'varchar', default: '{}' })
  routing_config: string;  // JSON: { [columnName: string]: string[] }  e.g. { "review": ["assignee","reviewer"] }
                           // Keyed by lowercase column name. Each value is an array of roles to notify.

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @Column({ type: 'timestamp', nullable: true, default: null })
  archived_at: Date | null;

  @ManyToOne(() => Workspace, ws => ws.boards, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workspace_id' })
  workspace: Workspace;

  @OneToMany(() => BoardColumn, col => col.board, { cascade: true, eager: true })
  columns: BoardColumn[];
}
