import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Index(['workspace_id', 'created_at'])
@Index(['room_id', 'type', 'created_at'])
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

  // Message discriminator:
  //   'message'  — real chat turn (user input or agent's final reply via
  //                send_chat_room_message). Included when chat history is
  //                replayed into an agent session.
  //   'progress' — ephemeral heartbeat the agent-manager posts when the
  //                spawned CLI fires a non-`send_chat_room_message` tool
  //                (e.g. Read, Edit, mcp__awb__*). Visible to humans so they
  //                can tell the agent is working, but stripped from history
  //                replay so the model doesn't condition on its own past
  //                tool-call narration.
  // Default 'message' so existing rows + clients that omit the field keep
  // their pre-discriminator semantics.
  @Column({ type: 'varchar', default: 'message' })
  type: string;

  // Markdown text content
  @Column({ type: 'text' })
  content: string;

  // JSON array of image attachments: Array<{data: string, filename: string, mimetype: string}>
  @Column({ type: 'text', default: '[]' })
  images: string;

  // 구조화 메시지 메타데이터 (JSON 문자열, nullable). F-1 (ticket 24694916):
  // agent-manager 가 mcp__awb__* tool result 에서 기계적으로 캡처한 티켓 액션 참조
  // (`ticket_refs`) 를 담아 신뢰성 있는 티켓 카드를 렌더한다. 기존 행·평범한 채팅
  // 턴은 NULL 로 남아 wire/렌더가 그대로다. 읽을 때 JSON.parse, 쓸 때 JSON.stringify.
  // SQLite(dev)는 synchronize=true 로 컬럼이 생기고, Postgres(운영)는 방어 마이그레이션
  // 1760000000058 이 `ADD COLUMN IF NOT EXISTS` 로 추가한다.
  @Column({ type: 'text', nullable: true })
  metadata: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
