import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * Agent Session — 한 사용자가 한 CLI 에이전트(Claude Code / Codex / Hermes …)의
 * 세션을 **직접** 모는 표면. 기존 ChatRoom(다자간 대화, 보드 컨시어지, run
 * dispatch 버스)과는 계약이 다르다:
 *
 *   - 세션은 (owner_user, agent) 소유의 1:1 이고 참여자 개념이 없다.
 *   - 에이전트 답변은 MCP 툴 호출이 아니라 CLI 의 ACP 스트림(text/tool/permission)
 *     그대로 `agent_session_events` 로 흘러온다 — 프롬프트 래핑·히스토리 재조립 없음.
 *   - cwd 는 방에서 파생되는 값이 아니라 세션의 1급 필드다.
 *
 * 그래서 ChatRoom 엔티티를 재사용하지 않는다 — 방 종류 9개가 다중화된 버스에
 * 열 번째 분기를 얹으면 orchestration/action/QA 의존 모듈 전부가 그 분기를 만난다.
 * TypeORM `synchronize`(D-01)로 자동 DDL 되므로 별도 마이그레이션은 없다.
 */
@Entity('agent_sessions')
@Index('idx_agent_sessions_owner_ws', ['owner_user_id', 'workspace_id'])
@Index('idx_agent_sessions_agent', ['agent_id'])
export class AgentSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  /** 세션을 실행하는 CLI 에이전트 identity (Agent.id). 매니저 라우팅은
   *  Agent.manager_agent_id 로 서버 SSE 필터가 해석한다. */
  @Column({ type: 'varchar' })
  agent_id: string;

  /** 세션 소유자. 세션은 소유자에게만 보이고 소유자만 프롬프트할 수 있다. */
  @Column({ type: 'varchar' })
  owner_user_id: string;

  /** 생성 시점의 Agent.type 스냅샷 ('claude' | 'codex' | 'hermes' | …).
   *  agent-manager 가 이 값으로 ACP 어댑터 명령을 고른다. */
  @Column({ type: 'varchar', default: 'claude' })
  runtime: string;

  /** 사용자 지정 제목. 비어 있으면 UI 가 첫 프롬프트 발췌로 보여준다. */
  @Column({ type: 'varchar', default: '' })
  title: string;

  /** 요청 작업 디렉터리. '' 이면 매니저가 Agent.working_dir 를 쓴다. */
  @Column({ type: 'text', default: '' })
  cwd: string;

  /** 'starting' | 'ready' | 'busy' | 'awaiting_permission' | 'suspended'
   *  | 'closed' | 'error' — AGENT_SESSION_STATUSES 참조. */
  @Column({ type: 'varchar', default: 'starting' })
  status: string;

  /** ACP `session/new` 가 돌려준 에이전트 측 세션 id. 매니저 재시작 뒤
   *  `session/load` 로 이어 붙일 때 쓴다. */
  @Column({ type: 'varchar', nullable: true, default: null })
  native_session_id: string | null;

  /** initialize 응답 agentCapabilities.loadSession — 0/1 (SQLite 호환 int). */
  @Column({ type: 'int', default: 0 })
  resume_supported: number;

  /** ACP session mode id (예: 'default' | 'acceptEdits' | 'plan'). */
  @Column({ type: 'varchar', nullable: true, default: null })
  current_mode: string | null;

  /** JSON [{ id, name, description }] — session/new 가 돌려준 modes.availableModes. */
  @Column({ type: 'text', nullable: true, default: null })
  available_modes: string | null;

  /** 'ask'(권한 요청을 사용자에게 릴레이) | 'auto_allow'(허용 옵션 자동 선택). */
  @Column({ type: 'varchar', default: 'ask' })
  permission_policy: string;

  @Column({ type: 'text', nullable: true, default: null })
  last_error: string | null;

  /** 마지막으로 부여한 이벤트 seq — 세션 단위 단조 증가. */
  @Column({ type: 'int', default: 0 })
  last_event_seq: number;

  @Column({ type: Date, nullable: true, default: null })
  last_activity_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
