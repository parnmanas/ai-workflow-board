import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('prompt_templates')
export class PromptTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', default: '' })
  workspace_id: string;

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
