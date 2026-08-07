import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

export type OutreachClassification = 'bug' | 'feature_request' | 'question' | 'noise' | '';
export type OutreachItemStatus = 'ticketed' | 'noise' | 'question' | 'held' | 'error';

/**
 * OutreachInboundItem — one row per external comment/issue an OutreachChannel
 * poll observed. Three roles in one table (mirrors TicketDuplicateDecision's
 * "decision evidence lives in a side table, the Ticket only gets a pointer"
 * shape):
 *
 *   1. Dedupe ledger — the unique (channel_id, external_item_id) index is the
 *      single source of truth that makes re-polling the same external item a
 *      no-op (OutreachIngestService looks this up before classifying).
 *   2. Audit log for items that never became a ticket — noise/question rows
 *      record the classification without a ticket ever existing; held rows
 *      record a low-confidence classification pending a human/threshold change.
 *   3. Ticket → source backlink — `ticket_id` is what a future "notify the
 *      original thread on resolve" feature reads to find the permalink/author
 *      to reply to, without needing anything on the Ticket entity itself
 *      (no Ticket schema change — see the ticket's D4 planning decision).
 */
@Entity('outreach_inbound_items')
@Index('uq_outreach_inbound_channel_item', ['channel_id', 'external_item_id'], { unique: true })
export class OutreachInboundItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  channel_id: string;

  // Connector-native id (Reddit fullname / GitHub issue+comment id, etc.).
  // Opaque to this table — only used as half of the dedupe key.
  @Column({ type: 'varchar' })
  external_item_id: string;

  @Column({ type: 'varchar', default: '' })
  classification: OutreachClassification;

  // 0-100 scale, same as TicketDuplicateDecision.confidence.
  @Column({ type: 'int', default: 0 })
  confidence: number;

  @Column({ type: 'varchar' })
  status: OutreachItemStatus;

  @Column({ type: 'varchar', nullable: true, default: null })
  ticket_id: string | null;

  @Column({ type: 'varchar', default: '' })
  permalink: string;

  @Column({ type: 'varchar', default: '' })
  author: string;

  // Source-reported creation time of the external item — the cursor
  // (OutreachChannel.since_cursor) advances to the max of this column across
  // a poll's processed items, not to the poll's wall-clock time.
  @Column({ type: Date })
  collected_at: Date;

  @CreateDateColumn()
  created_at: Date;
}
