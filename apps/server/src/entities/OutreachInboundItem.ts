import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

export type OutreachClassification = 'bug' | 'feature_request' | 'question' | 'noise' | '';
// 'appended' (ticket 31e7cd24): a threaded child item (InboundItem.parent_external_item_id
// set, e.g. a new GitHub issue comment) whose parent already resolved to a
// ticket — recorded here purely for dedupe/audit, never carries ticket_id
// (see OutreachIngestService._processItem), distinct from 'ticketed' which
// means THIS item itself caused a new ticket to be created.
export type OutreachItemStatus = 'ticketed' | 'noise' | 'question' | 'held' | 'error' | 'appended';

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

  // Set when a claim (status='ticketed', ticket_id=null) is INSERTed, i.e.
  // right before OutreachIngestService starts building the ticket. A NULL
  // here means the row predates this column (pre-fix data) and is always
  // treated as expired. See OutreachIngestService's STALE_CLAIM_LEASE_MS —
  // this is what lets a later poll tell "still actively being processed"
  // apart from "the process that claimed this crashed" instead of deleting
  // an in-flight claim out from under its own owner.
  @Column({ type: Date, nullable: true, default: null })
  claimed_at: Date | null;

  @Column({ type: 'varchar', default: '' })
  permalink: string;

  @Column({ type: 'varchar', default: '' })
  author: string;

  // Source-reported creation time of the external item — the cursor
  // (OutreachChannel.since_cursor) advances to the max of this column across
  // a poll's processed items, not to the poll's wall-clock time.
  @Column({ type: Date })
  collected_at: Date;

  // sha256 hex digest of this item's body at claim time (ticket 31e7cd24
  // review round 2). Only meaningfully consulted on a top-level `issue:...`
  // row, which acts as the parent an `issue-update:...` candidate compares
  // against: GitHub bumps an issue's updated_at on ANY activity, including a
  // new comment, so GitHubConnector.fetchInbound emits an issue-update
  // candidate even when the body itself didn't change.
  // OutreachIngestService._tryAppendToParent compares that candidate's body
  // hash against this column and skips the Comment append when they match —
  // otherwise a comment-only update would append both the real new comment
  // AND a spurious "the source item was updated" duplicate. Updated whenever
  // a genuine change is confirmed (initial claim, and each accepted
  // issue-update); null on legacy rows predating this column, which the
  // comparison treats as "unknown → assume changed" rather than suppressing.
  @Column({ type: 'varchar', nullable: true, default: null })
  content_hash: string | null;

  @CreateDateColumn()
  created_at: Date;
}
