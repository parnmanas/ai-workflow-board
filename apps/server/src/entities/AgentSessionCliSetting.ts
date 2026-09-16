import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * Agent Session(CLI 직접 세션) — Runtime Host × CLI 의 "CLI 설정". 세션 **내용**은
 * 저장하지 않지만(장비의 CLI 홈이 원본), 어떤 워크스페이스 Credential 로 그 CLI 를
 * 인증할지는 설정이므로 여기 둔다. 매니저는 세션을 열 때 이 바인딩이 있는
 * credential 만 `GET /api/agent/sessions/credential/:id` 로 받아 세션 전용 cli-home
 * 에 적용한다(운영자 홈의 로그인 파일은 건드리지 않는다). docs/agent-sessions.md.
 * Auto-DDL'd by TypeORM `synchronize` (D-01).
 */
@Entity('agent_session_cli_settings')
@Index('uq_agent_session_cli_settings', ['workspace_id', 'manager_id', 'cli'], { unique: true })
export class AgentSessionCliSetting {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  /** Runtime Host identity (Agent.id, type 'manager'). */
  @Column({ type: 'varchar' })
  manager_id: string;

  @Column({ type: 'varchar' })
  cli: string;

  /** Credential.id — null 이면 장비 운영자의 CLI 로그인을 그대로 쓴다. */
  @Column({ type: 'varchar', nullable: true, default: null })
  credential_id: string | null;

  @Column({ type: 'varchar', default: '' })
  updated_by: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
