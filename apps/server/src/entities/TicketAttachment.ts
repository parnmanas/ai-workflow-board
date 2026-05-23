import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { Ticket } from './Ticket';

/**
 * Files attached directly to a Ticket. Distinct from Comment attachments —
 * those go through the Resource table (type='comment_attachment'), this one
 * stores the binary inline against the ticket so file lifecycle stays bound
 * to the ticket itself (cascade-deletes with the ticket, no Resource indirection).
 */
@Entity('ticket_attachments')
@Index(['ticket_id', 'created_at'])
export class TicketAttachment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true, default: '' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  ticket_id: string;

  @Column({ type: 'varchar' })
  file_name: string;

  @Column({ type: 'varchar', default: '' })
  file_mimetype: string;

  // Base64-encoded payload. Sized via MAX_TICKET_ATTACHMENT_SIZE in
  // common/constants/upload.ts; identical storage strategy to
  // Resource.file_data so existing data-url rendering continues to work.
  @Column({ type: 'text', default: '' })
  file_data: string;

  // Decoded byte count, recorded once on upload so list responses can show
  // size without decoding base64 on every read.
  @Column({ type: 'int', default: 0 })
  file_size: number;

  @Column({ type: 'varchar', default: 'user' })
  uploaded_by_type: string;

  @Column({ type: 'varchar', default: '' })
  uploaded_by_id: string;

  @Column({ type: 'varchar', default: '' })
  uploaded_by: string;

  @CreateDateColumn()
  created_at: Date;

  @ManyToOne(() => Ticket, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticket_id' })
  ticket: Ticket;
}
