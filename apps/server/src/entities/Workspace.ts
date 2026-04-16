import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { Board } from './Board';

@Entity('workspaces')
export class Workspace {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  // int type for SQLite compat (no native boolean in sql.js)
  @Column({ type: 'int', default: 0 })
  is_public: number; // 0=private, 1=public

  // URL-safe slug for workspace; nullable until backfill migration (Plan 02) sets defaults
  @Column({ type: 'varchar', unique: true, nullable: true })
  slug: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @OneToMany(() => Board, board => board.workspace, { cascade: true, eager: true })
  boards: Board[];
}
