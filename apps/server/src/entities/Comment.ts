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

  @Column({ type: 'text', default: '[]' })
  images: string;

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

  @CreateDateColumn()
  created_at: Date;

  @ManyToOne(() => Ticket, ticket => ticket.comments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticket_id' })
  ticket: Ticket;
}
