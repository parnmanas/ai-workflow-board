import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('chat_rooms')
export class ChatRoom {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Workspace scope — plain FK per project convention (no relation decorator)
  @Column({ type: 'varchar' })
  workspace_id: string;

  // 'dm' = exactly 2 participants, 'group' = 3-50 participants (CHAT-02)
  @Column({ type: 'varchar' })
  type: string;

  // Meaningful for group rooms; DM display name is computed per-viewer at read time
  @Column({ type: 'varchar', default: '' })
  name: string;

  // Denormalized for efficient room list sort (CHAT-06); updated on every sendMessage
  @Column({ type: 'timestamp', nullable: true, default: null })
  last_message_at: Date | null;

  // Optional link to a Ticket — enables @mention role shortcuts (@reviewer/@assignee/@reporter)
  @Column({ type: 'varchar', nullable: true, default: null })
  ticket_id: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
