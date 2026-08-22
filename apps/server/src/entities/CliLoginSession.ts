import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

// ticket b2e79108 — Codex/Claude CLI device-auth 자동 로그인 세션.
//
// starting: agent-manager 에 cli_login_start 커맨드를 방금 dispatch함.
// awaiting_user: 매니저가 verification_url/user_code 를 파싱해 보고함 — 사람이
//   브라우저에서 승인하길 기다리는 중.
// completing: 매니저가 프로세스 종료(exit 0)를 감지하고 auth 파일을 읽는 중.
// succeeded/failed/timed_out/cancelled: 종료 상태.
export type CliLoginSessionStatus =
  | 'starting'
  | 'awaiting_user'
  | 'completing'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

export const TERMINAL_CLI_LOGIN_SESSION_STATUSES: readonly CliLoginSessionStatus[] = [
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
];

@Entity('cli_login_sessions')
export class CliLoginSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  // true면 완료 시 생성되는 Credential.workspace_id=null (전역 공유).
  @Column({ type: 'boolean', default: false })
  is_global: boolean;

  // 'codex' 만 자동화됨(claude는 후속 티켓 — PTY 릴레이 필요). 문자열 컬럼이라
  // 스키마 변경 없이 나중에 추가 가능.
  @Column({ type: 'varchar' })
  cli: string;

  // 성공 시 생성할 Credential.name.
  @Column({ type: 'varchar' })
  credential_name: string;

  @Column({ type: 'varchar', default: 'starting' })
  status: CliLoginSessionStatus;

  @Column({ type: 'varchar', nullable: true, default: null })
  verification_url: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  user_code: string | null;

  // 리뷰 지적(round 1): URL/코드 안내 문구가 바뀌어 구조화 파싱이 실패하면
  // 매니저가 raw stdout(redact됨, 크기 제한)을 여기에 채운다 — 사용자가
  // starting 상태에 갇혀 아무것도 못 보는 상황을 막는 폴백. 진짜 url/code가
  // 나중에라도 파싱되면 그쪽이 우선이고 이 필드는 비워진다.
  @Column({ type: 'text', nullable: true, default: null })
  raw_output_fallback: string | null;

  @Column({ type: 'text', default: '' })
  error_detail: string;

  // 성공 시 생성된 Credential.id — 클라이언트로는 이 id만 돌려주고 토큰 원문은
  // 절대 응답에 싣지 않는다.
  @Column({ type: 'varchar', nullable: true, default: null })
  created_credential_id: string | null;

  @Column({ type: 'varchar' })
  triggered_by_id: string;

  // 이 세션을 실행 중인 agent-manager 인스턴스. cli_login_start SSE 라우팅과
  // 진행상황 POST의 소유권 검증(caller manager_agent_id 일치) 둘 다에 쓰인다.
  @Column({ type: 'varchar' })
  instance_id: string;

  @Column({ type: 'varchar' })
  manager_agent_id: string;

  // agent_manager_command 상관관계 id. 매니저 쪽 격리 CODEX_HOME 디렉터리명과
  // 동일 — stale/중복 progress POST를 가려내는 데도 쓴다.
  @Column({ type: 'varchar', default: '' })
  command_id: string;

  @Column({ type: Date, nullable: true, default: null })
  started_at: Date | null;

  @Column({ type: Date, nullable: true, default: null })
  finished_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
