import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * Runtime Host — Agent 없는 greenfield의 유일한 정체성 (P0).
 *
 * 현 `agents WHERE type='manager'` 행이 하던 역할(페어링으로 생성, heartbeat
 * 수신, CLI spawn 소유)을 그대로 넘겨받는다. 실행 선언(RuntimeSpec)의
 * `manager_agent_id`가 가리키는 대상이 앞으로는 이 테이블이다.
 *
 * 라이브 presence(heartbeat, available_models, cli_installs)는 기존처럼
 * 인메모리 InstanceRegistry가 들고 있다 — 여기에는 영속 식별자 + 표시명 +
 * 페어링 bookkeeping만 둔다. P0에서는 `agents`의 manager 행과 dual-write
 * (같은 페어링에서 양쪽 다 생성)하고, P4에서 manager 행을 제거한다.
 */
@Entity('runtime_hosts')
export class RuntimeHost {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  hostname: string;

  // 페어링 당시 workspace — ApiKey 스탬프와 같은 bookkeeping 용도이며 권한
  // 경계가 아니다. Host 키는 AgentAuthGuard에서 full-scope로 취급한다.
  @Column({ type: 'varchar', nullable: true, default: null })
  workspace_id: string | null;

  @Column({ type: 'int', default: 1 })
  is_active: number;

  @Column({ type: Date, nullable: true, default: null })
  last_seen_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
