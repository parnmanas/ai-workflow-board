import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { nullablePassThroughUuid } from '../database/uuid-column';

@Entity('agent_error_logs')
@Index(['agent_id', 'occurred_at'])
@Index(['level'])
export class AgentErrorLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  agent_id: string;

  @Column({ type: 'uuid', nullable: true, transformer: nullablePassThroughUuid })
  workspace_id: string | null;

  @Column({ type: Date })
  occurred_at: Date;

  @Column({ type: 'varchar' })
  level: string;  // 'error' | 'warn' | 'fatal'

  @Column({ type: 'varchar' })
  category: string;  // 'crash' | 'sse' | 'presence' | 'subagent' | 'ipc' | 'misc'

  @Column({ type: 'text' })
  message: string;

  @Column({ type: 'text', nullable: true, default: null })
  raw_line: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  pid: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  plugin_version: string | null;

  @CreateDateColumn()
  created_at: Date;
}
