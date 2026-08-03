import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('prompt_templates')
export class PromptTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  workspace_id: string | null;

  // Legacy compatibility column. Boot migration (65adf0b) clears it and new
  // Board-scoped templates are rejected at create() — always NULL going
  // forward; templates are Global/Workspace-owned only.
  @Column({ type: 'varchar', nullable: true, default: null })
  board_id: string | null;

  @Column({ type: 'varchar', default: '' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  @Column({ type: 'text', default: '' })
  content: string;

  @Column({ type: 'varchar', default: '' })
  category: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
