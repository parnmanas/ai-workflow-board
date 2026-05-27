import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { ChatRoom } from './ChatRoom';

@Entity('chat_room_participants')
export class ChatRoomParticipant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // FK to chat_rooms.id
  @Column({ type: 'varchar' })
  room_id: string;

  @ManyToOne(() => ChatRoom)
  @JoinColumn({ name: 'room_id' })
  room: ChatRoom;

  // 'user' | 'agent'
  @Column({ type: 'varchar' })
  participant_type: string;

  // User.id or Agent.id depending on participant_type
  @Column({ type: 'varchar' })
  participant_id: string;

  // Server-side unread count: use m.created_at > p.last_read_at (CHAT-12, CHAT-13)
  // NOTE: Do NOT use UUID comparison for unread detection — UUIDs are not monotonic
  @Column({ type: Date, nullable: true, default: null })
  last_read_at: Date | null;

  // Soft-delete for leave (CHAT-16); null = active participant
  @Column({ type: Date, nullable: true, default: null })
  left_at: Date | null;

  // Per-viewer "Clear conversation" cutoff (ticket 1ae77f55). When set, this
  // user's own getMessages / listRooms preview / unread query treat messages
  // with created_at <= cleared_at as if they don't exist. The underlying rows
  // are NOT deleted — other participants are unaffected, and re-joining
  // (left_at set then cleared) creates a fresh row whose cleared_at starts
  // at NULL again.
  @Column({ type: Date, nullable: true, default: null })
  cleared_at: Date | null;

  @CreateDateColumn()
  joined_at: Date;
}
