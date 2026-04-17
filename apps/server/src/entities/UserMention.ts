import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * Records an @-mention targeting a specific user. Persisted so we can power
 * an unread badge + inbox drop-down in the web UI.
 *
 * Agent mentions do NOT live here — they are consumed once by the SSE
 * `comment_mention` / `chat_request` event and never need re-reading.
 */
@Entity('user_mentions')
@Index(['user_id', 'read_at'])
export class UserMention {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Mentioned user
  @Column({ type: 'varchar' })
  user_id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  // Where the mention lives
  @Column({ type: 'varchar' })
  source_type: string; // 'comment' | 'chat_message'

  @Column({ type: 'varchar' })
  source_id: string; // comment.id or chat_room_messages.id

  @Column({ type: 'varchar', nullable: true, default: null })
  ticket_id: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  room_id: string | null;

  // Who did the mentioning
  @Column({ type: 'varchar' })
  actor_id: string;

  @Column({ type: 'varchar', default: 'user' })
  actor_type: string; // 'user' | 'agent'

  @Column({ type: 'varchar', default: '' })
  actor_name: string;

  // Snapshot of the surrounding message (trimmed). Rendered in the inbox drop-down.
  @Column({ type: 'text', default: '' })
  preview: string;

  @CreateDateColumn()
  created_at: Date;

  @Column({ type: 'timestamp', nullable: true, default: null })
  read_at: Date | null;
}
