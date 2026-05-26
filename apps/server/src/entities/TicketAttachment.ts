import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { Ticket } from './Ticket';

/**
 * Generic binary attachment storage. The original ticket attachment surface
 * owns rows with owner_type='ticket'; chat uploads reuse the same table with
 * owner_type='chat_message' and owner_id set once the message is sent.
 */
@Entity('ticket_attachments')
@Index(['ticket_id', 'created_at'])
@Index(['owner_type', 'owner_id', 'created_at'])
@Index(['room_id', 'created_at'])
export class TicketAttachment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true, default: '' })
  workspace_id: string;

  @Column({ type: 'varchar', default: 'ticket' })
  owner_type: string;

  @Column({ type: 'varchar', default: '' })
  owner_id: string;

  @Column({ type: 'varchar', nullable: true })
  ticket_id: string | null;

  @Column({ type: 'varchar', nullable: true })
  room_id: string | null;

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

  @ManyToOne(() => Ticket, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'ticket_id' })
  ticket: Ticket;
}
