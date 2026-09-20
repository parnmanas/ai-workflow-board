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

  /**
   * 이 호스트×CLI 세션을 열 때마다 다시 적용할 설정 — `{ [configId]: string | boolean }` JSON.
   * approval 모드·모델 같은 선택은 어댑터 프로세스 안에만 살아서, 세션이 유휴로 회수되거나
   * 화면을 옮겼다 돌아오면 어댑터 기본값으로 되돌아간다. 여기 기억해 두고 open 마다 다시 건다.
   * 레거시 `session/set_mode` 전용 어댑터를 위해 예약 키 `__mode` 를 쓴다.
   */
  @Column({ type: 'text', default: '{}' })
  default_config: string;

  /**
   * 마지막으로 본 설정 목록(`AgentSessionConfigOption[]` JSON). 선택지는 어댑터가 살아 있어야
   * 알 수 있는데, 새 세션 모달은 세션이 열리기 **전에** 골라야 한다 — 그래서 마지막 목록을 남긴다.
   * 표시용 캐시일 뿐이라 비어 있으면 모달이 그 선택기를 감춘다.
   */
  @Column({ type: 'text', default: '[]' })
  known_config_options: string;

  @Column({ type: 'varchar', default: '' })
  updated_by: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
