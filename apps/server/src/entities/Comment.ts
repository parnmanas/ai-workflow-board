import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { Ticket } from './Ticket';
import { emptyToNullUuid, nullablePassThroughUuid } from '../database/uuid-column';

export type CommentType = 'note' | 'question' | 'answer' | 'decision' | 'chat' | 'system' | 'handoff';
export type CommentStatus = 'open' | 'resolved' | null;

export const COMMENT_TYPES: ReadonlyArray<CommentType> = ['note', 'question', 'answer', 'decision', 'chat', 'system', 'handoff'];

@Entity('comments')
@Index(['ticket_id', 'type', 'created_at'])
export class Comment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true, transformer: emptyToNullUuid })
  workspace_id: string;

  @Column({ type: 'uuid' })
  ticket_id: string;

  @Column({ type: 'varchar', default: 'user' })
  author_type: string;

  @Column({ type: 'uuid', nullable: true, transformer: emptyToNullUuid })
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
  @Column({ type: 'uuid', nullable: true, transformer: nullablePassThroughUuid })
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
