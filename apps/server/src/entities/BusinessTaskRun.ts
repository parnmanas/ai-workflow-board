import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { RuntimeSpec } from '../common/runtime-spec';

/** One durable user request. Business execution never needs a Ticket. */
@Entity('business_task_runs')
@Index(['account_id', 'company_id', 'task_id', 'sequence'])
@Index(['status', 'created_at'])
export class BusinessTaskRun {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) account_id: string;
  @Column({ type: 'varchar' }) company_id: string;
  @Column({ type: 'varchar' }) task_id: string;
  @Column({ type: 'integer' }) sequence: number;
  @Column({ type: 'varchar' }) requested_by: string;
  @Column({ type: 'varchar' }) request_entry_id: string;
  @Column({ type: 'varchar' }) input_digest: string;
  @Column({ type: 'simple-json' }) agent_runtime: RuntimeSpec;
  @Column({ type: 'varchar', default: 'queued' }) status: 'queued' | 'running' | 'needs_input' | 'completed' | 'failed';
  @Column({ type: 'varchar', default: '' }) room_id: string;
  @Column({ type: 'varchar', default: '' }) dispatch_message_id: string;
  /**
   * 이 요청을 실행한 Agent Session(Host · CLI · 네이티브 세션 id). 비어 있으면 예전 방식(`room_id` 의
   * 실행 대화)으로 돈 요청이다. 세션은 업무 하나가 이어 쓰므로 같은 업무의 다음 요청이 같은 값을 갖는다 —
   * 화면은 이것으로 업무 상세에 세션을 띄우고, 결과 제출은 이 세션의 MCP 연결만 받아 준다.
   */
  @Column({ type: 'varchar', default: '' }) session_manager_id: string;
  @Column({ type: 'varchar', default: '' }) session_cli: string;
  @Column({ type: 'varchar', default: '' }) session_id: string;
  @Column({ type: 'varchar', default: '' }) output_digest: string;
  @Column({ type: 'text', default: '' }) summary: string;
  @Column({ type: 'text', default: '' }) question: string;
  @Column({ type: 'text', default: '' }) last_error: string;
  @Column({ type: Date, nullable: true }) started_at: Date | null;
  @Column({ type: Date, nullable: true }) completed_at: Date | null;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
