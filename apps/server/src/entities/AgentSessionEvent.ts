import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * Agent Session 트랜스크립트의 한 줄. append-only — 세션당 `seq` 가 단조 증가하고
 * UI 는 seq 순으로 그린다. `type` 별 payload 모양은
 * common/types/agent-sessions.ts 의 AgentSessionEventPayloadMap 참조.
 *
 * 스트리밍 텍스트는 매니저가 ~150ms 단위로 합친 청크 한 줄당 한 행이다. 같은
 * turn_id 의 연속된 'text' 행을 UI 가 하나의 말풍선으로 이어 붙인다.
 */
@Entity('agent_session_events')
@Index('idx_agent_session_events_session_seq', ['session_id', 'seq'])
export class AgentSessionEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  session_id: string;

  @Column({ type: 'int' })
  seq: number;

  /** 한 프롬프트 턴을 묶는 id (user_prompt 가 시작, turn(finished) 가 끝). */
  @Column({ type: 'varchar', default: '' })
  turn_id: string;

  /** AGENT_SESSION_EVENT_TYPES 중 하나. */
  @Column({ type: 'varchar' })
  type: string;

  /** JSON 직렬화된 payload. */
  @Column({ type: 'text', default: '{}' })
  payload: string;

  @CreateDateColumn()
  created_at: Date;
}
