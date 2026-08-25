import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type CompletionVerificationStatus = 'pending' | 'passed' | 'failed';

@Entity('ticket_completion_verifications')
@Index('uq_ticket_completion_verification_key', ['ticket_id', 'dedupe_key'], { unique: true })
@Index('idx_ticket_completion_verification_status', ['ticket_id', 'status'])
export class TicketCompletionVerification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  ticket_id: string;

  @Column({ type: 'varchar' })
  dedupe_key: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'varchar', default: 'pending' })
  status: CompletionVerificationStatus;

  @Column({ type: 'int', default: 0 })
  attempt_count: number;

  @Column({ type: 'text', default: '[]' })
  evidence: string;

  @Column({ type: Date, nullable: true, default: null })
  not_before: Date | null;

  @Column({ type: Date, nullable: true, default: null })
  completed_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
