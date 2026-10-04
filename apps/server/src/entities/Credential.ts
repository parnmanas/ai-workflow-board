import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('credentials')
export class Credential {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Nullable: a NULL workspace_id marks a GLOBAL (instance-level) credential
  // shared across every workspace. Non-NULL pins the credential to one
  // workspace (the original behaviour). Mirrors the Agent.workspace_id
  // nullable pattern used for manager rows (migrations 018/019).
  @Column({ type: 'varchar', nullable: true, default: null })
  workspace_id: string | null;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  @Column({ type: 'varchar' })
  provider: string;

  @Column({ type: 'text' })
  encrypted_data: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
