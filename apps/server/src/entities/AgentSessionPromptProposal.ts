import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * operator 가 다른 Agent Session 에 시키자고 **제안한** 프롬프트(docs/voice-operator.md "작업 제안").
 *
 * operator 는 보고(다른 세션이 쓴 글)를 보고 다음 일을 떠올리지만, 그 글만으로 다른 세션을 움직이면 한 세션의
 * 문장이 다른 세션에 대한 명령이 된다. 그래서 operator 는 제안만 남기고, **사용자가 승인해야** 서버가 대상 세션에
 * 보낸다(화면의 Send, 또는 사용자가 시작한 operator 턴에서의 확인). 서버 재시작(배포마다)에도 사라지지 않게
 * 메모리가 아니라 여기 둔다.
 *
 * status: pending(승인 대기) → queued(승인됨, 대상이 턴 중이라 끝나면 보낸다) → sent | failed,
 *         또는 dismissed(사용자가 거절) · withdrawn(operator 가 거둠) · superseded(같은 대상에 새 제안).
 */
@Entity('agent_session_prompt_proposals')
@Index('idx_session_prompt_proposals_user_status', ['user_id', 'status'])
@Index('idx_session_prompt_proposals_target', ['manager_id', 'cli', 'session_id', 'status'])
export class AgentSessionPromptProposal {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  /** 대상 세션의 소유 계정 — 보낼 때 그 세션의 실행 snapshot 으로 연다. */
  @Column({ type: 'varchar' })
  account_id: string;
  /** 승인할 사람 — operator 가 그때 일하던 사용자(보고 턴이면 그 보고의 사용자). */
  @Column({ type: 'varchar' })
  user_id: string;
  @Column({ type: 'varchar' })
  operator_id: string;
  @Column({ type: 'varchar' })
  operator_name: string;
  /** 제안이 나온 operator 턴의 종류 — 'report'(AWB 보고 턴) | 'user'(사용자가 시작한 턴) | 'unknown'. */
  @Column({ type: 'varchar', default: 'unknown' })
  origin: string;
  @Column({ type: 'varchar' })
  manager_id: string;
  @Column({ type: 'varchar' })
  cli: string;
  @Column({ type: 'varchar' })
  session_id: string;
  /** 제안할 때의 대상 세션 제목 — 화면·음성에 어느 세션인지 보여 준다. */
  @Column({ type: 'varchar', default: '' })
  target_title: string;
  @Column({ type: 'text' })
  text: string;
  @Column({ type: 'text', default: '' })
  reason: string;
  @Column({ type: 'varchar', default: 'pending' })
  status: string;
  @Column({ type: 'varchar', nullable: true, default: null })
  decided_by: string | null;
  /** 'screen' | 'voice' | 'operator'(거둠). */
  @Column({ type: 'varchar', nullable: true, default: null })
  decided_via: string | null;
  @Column({ type: 'varchar', nullable: true, default: null })
  delivered_turn_id: string | null;
  @Column({ type: 'text', nullable: true, default: null })
  error: string | null;
  @Column({ type: Date, nullable: true, default: null })
  decided_at: Date | null;
  @CreateDateColumn()
  created_at: Date;
  @UpdateDateColumn()
  updated_at: Date;
}
