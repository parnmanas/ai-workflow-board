import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('ticket_completion_verification_attempts')
@Index('uq_completion_verification_attempt_key', ['verification_id', 'attempt_key'], { unique: true })
export class TicketCompletionVerificationAttempt {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  verification_id: string;

  @Column({ type: 'varchar' })
  attempt_key: string;

  @Column({ type: 'varchar' })
  status: 'passed' | 'failed';

  @Column({ type: 'text' })
  evidence: string;

  @CreateDateColumn()
  created_at: Date;
}
