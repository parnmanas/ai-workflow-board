import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { emptyToNullUuid } from '../database/uuid-column';

/**
 * Per-(user, ticket) read marker. Tracks when the user last marked the
 * ticket's comment timeline as read. Comments with created_at greater
 * than this timestamp are treated as "unread" for that user — no
 * per-comment row required, which keeps the schema cheap on chatty
 * tickets where a per-comment receipts table would explode.
 *
 * Mirrors the chat-room participant.last_read_at pattern so the two
 * surfaces feel consistent.
 *
 * Composite uniqueness on (user_id, ticket_id) via the @Index decorator
 * — TypeORM synchronize:true will enforce it without a manual migration.
 */
@Entity('ticket_read_state')
@Index(['user_id', 'ticket_id'], { unique: true })
export class TicketReadState {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @Column({ type: 'uuid' })
  ticket_id: string;

  // Denormalized so a global "all unread for me in workspace W" query
  // can be answered without joining tickets.
  @Column({ type: 'uuid', nullable: true, transformer: emptyToNullUuid })
  workspace_id: string;

  // ISO-style timestamp the user last acknowledged. NULL means never read
  // — equivalent to "everything is unread", same as legacy rows that get
  // created the first time a user opens a ticket.
  @Column({ type: Date, nullable: true, default: null })
  last_read_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
