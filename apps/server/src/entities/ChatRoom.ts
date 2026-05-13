import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { nullablePassThroughUuid } from '../database/uuid-column';

@Entity('chat_rooms')
export class ChatRoom {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Workspace scope — plain FK per project convention (no relation decorator)
  @Column({ type: 'uuid' })
  workspace_id: string;

  // 'dm' = exactly 2 participants, 'group' = 3-50 participants (CHAT-02)
  @Column({ type: 'varchar' })
  type: string;

  // Meaningful for group rooms; DM display name is computed per-viewer at read time
  @Column({ type: 'varchar', default: '' })
  name: string;

  // Denormalized for efficient room list sort (CHAT-06); updated on every sendMessage
  @Column({ type: Date, nullable: true, default: null })
  last_message_at: Date | null;

  // Optional link to a Ticket — enables @mention role shortcuts (@reviewer/@assignee/@reporter).
  //
  // VESTIGIAL after Phase-9 unified-comment migration:
  //   No code path currently sets this field — every room is created via
  //   room-crud.service.createRoom() which never assigns ticket_id (only
  //   workspace_id/type/name/last_message_at). ChatRoom now serves DM and
  //   group conversations only; ticket-scoped discussion lives on Comment
  //   (note/question/answer/decision/chat/handoff types) so there is no
  //   "ticket-bound chat" surface to migrate.
  //
  // The column stays for now because:
  //   1. No write path exists, so all rows already store NULL — dropping it
  //      requires a data migration (D-02) we haven't scheduled.
  //   2. room-messaging.service.ts:379 still reads it as a defensive lookup
  //      for legacy data; removing the field would force code churn for no
  //      runtime benefit until the migration ships.
  //
  // To remove: write a data migration that drops the column, then strip
  // the read site in room-messaging.service.ts.
  @Column({ type: 'uuid', nullable: true, transformer: nullablePassThroughUuid })
  ticket_id: string | null;

  // When non-null, this room hosts a Run of the Actions feature (one room per
  // Run, FIFO-pruned to Action.max_runs). Lets the regular chat list filter
  // these out so they don't pile up next to user-initiated DMs / groups, and
  // lets the Action detail view surface the room without joining through
  // ActionRun.
  @Column({ type: 'uuid', nullable: true, transformer: nullablePassThroughUuid })
  action_id: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
