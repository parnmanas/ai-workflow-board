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
  @Column({ type: 'varchar', nullable: true, default: null })
  ticket_id: string | null;

  // When non-null, this room hosts a Run of the Actions feature (one room per
  // Run, FIFO-pruned to Action.max_runs). Lets the regular chat list filter
  // these out so they don't pile up next to user-initiated DMs / groups, and
  // lets the Action detail view surface the room without joining through
  // ActionRun.
  @Column({ type: 'varchar', nullable: true, default: null })
  action_id: string | null;

  // Orchestration mode. Exactly one of these two shapes when non-null:
  //   - mission room:  orchestration_mission_id set, orchestration_step_id null
  //                    (the orchestrator's own conversation for the Mission)
  //   - step room:     BOTH set (one room per delegated Step, per member agent)
  // Same rationale as action_id: the regular chat list filters these out so
  // machine-driven run rooms don't pile up next to user DMs/groups, and the
  // Mission detail view resolves its rooms without joining through the step
  // table. Also drives the `is_action_room` SSE marker (see room-messaging) —
  // an orchestration room is task execution, not conversation, so the subagent
  // must get "do the work directly" instructions rather than the chat
  // "file a ticket" rule.
  @Column({ type: 'varchar', nullable: true, default: null })
  orchestration_mission_id: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  orchestration_step_id: string | null;

  // 이 방이 QA 또는 security의 scenario/profile Run(또는 security
  // checklist-refresh Run)을 호스팅할 때 채워지며, 방 생성 시점에
  // qa-run.service.ts / security-run.service.ts가 찍어 넣는다(ticket
  // 9fd27487 리뷰 후속). 이 디스패처들은 방을 여는 최초 전송에서만 자체
  // `run_provision`(kind:'qa'|'security')을 실어 보낸다 —
  // room-messaging.service.ts의 chat_workspace_folder_enabled 폴백이 같은
  // 방에서 이후에 오는 메시지를, 무관한 `.awb/chat/<room>` 폴더를 가리키는
  // 가짜 kind:'chat' provision으로 덮어써서는 절대 안 되므로, action_id /
  // orchestration_mission_id를 이미 제외하는 것과 같은 방식으로 이 값이
  // 설정된 방도 제외한다.
  @Column({ type: 'varchar', nullable: true, default: null })
  run_kind: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
