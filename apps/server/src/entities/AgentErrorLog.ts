import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('agent_error_logs')
@Index(['agent_id', 'occurred_at'])
@Index(['level'])
export class AgentErrorLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  agent_id: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  workspace_id: string | null;

  @Column({ type: Date })
  occurred_at: Date;

  @Column({ type: 'varchar' })
  level: string;  // 'error' | 'warn' | 'fatal'

  @Column({ type: 'varchar' })
  category: string;  // classify() in agent-manager/src/lib/error-log-uploader.ts (crash/sse/presence/subagent/ipc/hermes/agent-context/misc)
                      // + recordEvent() eventType in agent-manager/src/lib/event-dispatcher.ts (agent_trigger/board_update/chat_request/chat_room_message/comment_mention/fs_request/agent_manager_command)

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
