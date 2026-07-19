import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { Ticket } from './Ticket';

export type CommentType = 'note' | 'question' | 'answer' | 'decision' | 'chat' | 'system' | 'handoff';
export type CommentStatus = 'open' | 'resolved' | null;

export const COMMENT_TYPES: ReadonlyArray<CommentType> = ['note', 'question', 'answer', 'decision', 'chat', 'system', 'handoff'];

@Entity('comments')
@Index(['ticket_id', 'type', 'created_at'])
export class Comment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true, default: '' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  ticket_id: string;

  @Column({ type: 'varchar', default: 'user' })
  author_type: string;

  @Column({ type: 'varchar', default: '' })
  author_id: string;

  @Column({ type: 'varchar' })
  author: string;

  @Column({ type: 'varchar' })
  content: string;

  // JSON array of Resource ids (type='comment_attachment') for files uploaded
  // alongside the comment. Inline base64 is never stored on the comment row —
  // binary lives in the Resource table so the existing resource viewer,
  // download pipeline, and filtering UI can reuse their logic unchanged.
  @Column({ type: 'text', default: '[]' })
  attachment_resource_ids: string;

  // Discriminator that turns the single comments timeline into typed facets:
  // note (default), question/answer (Q&A threading via parent_id),
  // decision (curated record), chat (lightweight realtime), system (auto-generated
  // by SystemCommentService), handoff (agent->agent). Mention storage is NOT
  // duplicated here — UserMention table + comment_mention SSE remain authoritative.
  @Column({ type: 'varchar', default: 'note' })
  type: CommentType;

  // Only meaningful for type='question'. Set to 'open' on creation, flipped to
  // 'resolved' when an 'answer' child comment lands (auto-resolve in addComment).
  @Column({ type: 'varchar', nullable: true })
  status: CommentStatus;

  // Threading: 'answer' -> 'question', generic reply chains. Validated to refer
  // to a comment on the same ticket so cross-ticket linkage cannot occur.
  @Column({ type: 'varchar', nullable: true })
  parent_id: string | null;

  // Type-specific extension bag (e.g., handoff.target_agent_id, decision.references).
  // Kept open-ended on purpose so new types can ship without schema churn.
  @Column({ type: 'text', default: '{}' })
  metadata: string;

  // Idempotency key for an operational fallback recurrence source.  Nullable
  // unique lets ordinary comments coexist while making a manager retry (or a
  // create-ticket unique-key race loser) record a room/message at most once.
  @Index({ unique: true })
  @Column({ type: 'varchar', nullable: true, default: null })
  operational_recurrence_key: string | null;

  // Dedupe counters for noisy auto-generated system rows (e.g. silent-exit
  // fallback fired by a stuck retry loop). When the silent-exit endpoint sees
  // the same fingerprint as the most recent comment on the ticket, it bumps
  // these in place instead of stacking another row. NULL on a brand-new
  // comment is read as "occurred once" by the client.
  @Column({ type: 'int', nullable: true, default: null })
  repeat_count: number | null;

  @Column({ type: Date, nullable: true, default: null })
  last_repeated_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @ManyToOne(() => Ticket, ticket => ticket.comments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticket_id' })
  ticket: Ticket;
}
