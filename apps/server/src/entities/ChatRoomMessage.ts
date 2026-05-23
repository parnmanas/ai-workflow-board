import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Index(['workspace_id', 'created_at'])
@Entity('chat_room_messages')
export class ChatRoomMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // FK to chat_rooms.id — plain varchar per project convention
  @Column({ type: 'varchar' })
  room_id: string;

  // Redundant but stored for direct workspace-scoped queries (matches ChatMessage pattern)
  @Column({ type: 'varchar' })
  workspace_id: string;

  // 'user' | 'agent' — Phase 8 @mention routing compatible
  @Column({ type: 'varchar' })
  sender_type: string;

  // User.id or Agent.id; agent must be a room participant to send
  @Column({ type: 'varchar' })
  sender_id: string;

  // Markdown text content
  @Column({ type: 'text' })
  content: string;

  // JSON array of image attachments: Array<{data: string, filename: string, mimetype: string}>
  @Column({ type: 'text', default: '[]' })
  images: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
