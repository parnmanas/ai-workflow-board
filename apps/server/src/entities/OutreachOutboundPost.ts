import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

// 'release_report' (ticket 31e7cd24): a release-consistency check (candidate
// resolved issues / undocumented changes / CHANGELOG gaps) generated on
// deploy for a kind='github' channel. Unlike 'deploy'/'resolve' it is never
// posted through OutreachConnector — delivery is an internal ticket comment
// (release-consistency.service.ts) — so `status='published'` here means
// "the report was generated and delivered", not "an external call succeeded".
export type OutreachOutboundKind = 'deploy' | 'resolve' | 'release_report';
// 'approving' is a short-lived transient claim state (step 6): the REST
// approve endpoint atomically flips draft→approving as its single-winner
// mutex BEFORE calling the connector, so two concurrent approve calls for
// the same row can never both reach the external call. It always resolves
// to 'published' or 'failed' within the same request — no row is ever
// observed sitting in 'approving' across requests.
export type OutreachOutboundStatus = 'draft' | 'approving' | 'published' | 'rejected' | 'failed';

/**
 * OutreachOutboundPost — the idempotency ledger + approval queue for every
 * outbound publish/reply this module ever attempts (ticket d86d0c24 step 3).
 * Mirrors OutreachInboundItem's "unique index is the single source of truth"
 * shape (see that entity's docstring), but for the OUTBOUND direction:
 *
 *   1. Idempotency anchor — `@Index(['channel_id', 'dedupe_key'], {unique})`
 *      is claimed BEFORE any external HTTP call (OutreachPublisherService),
 *      the same "claim-first, let the DB unique constraint be the real guard"
 *      pattern OutreachIngestService's inbound dedupe uses (lesson d8c72715
 *      from ticket 2500fea3 — no compensating delete needed because the
 *      claim happens before the side effect, not after). This is what makes
 *      "trigger the same release twice → publish once" a DB-enforced
 *      invariant rather than a best-effort check.
 *        - kind='deploy': dedupe_key = `deploy:{environment}:{deployed_commit_sha}`
 *        - kind='resolve': dedupe_key = `resolve:{outreach_inbound_item_id}`
 *   2. Approval queue — a row lands as status='draft' when the owning
 *      channel's `publish_policy='approval'`; the REST approve/reject
 *      endpoints transition it. status='draft' rows are NEVER the product of
 *      an external call having happened — only 'published'/'failed' rows
 *      represent an attempted connector.publish/reply.
 *   3. Release-diff base — `deployed_commit_sha` on the most recent
 *      kind='deploy' published row is what OutreachPublisherService reads as
 *      "since when" for the next release's body (Deployment itself is an
 *      UPSERT with no history, so this ledger is the only place a prior
 *      release's sha survives — see the Plan comment's "릴리스 diff base"
 *      observation).
 *
 * No DDL migration (CLAUDE.md D-01/D-02 — schema sync is `synchronize: true`
 * in every branch); this table is created purely by these decorators.
 */
@Entity('outreach_outbound_posts')
@Index(['channel_id', 'dedupe_key'], { unique: true })
export class OutreachOutboundPost {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  channel_id: string;

  // See class docstring for the two `kind`-specific key shapes.
  @Column({ type: 'varchar' })
  dedupe_key: string;

  @Column({ type: 'varchar' })
  kind: OutreachOutboundKind;

  @Column({ type: 'varchar', default: 'draft' })
  status: OutreachOutboundStatus;

  // Subreddit (or other channel-native target) this post/reply is addressed to.
  @Column({ type: 'varchar', default: '' })
  target: string;

  // '' for a reply (Reddit comments have no title).
  @Column({ type: 'varchar', default: '' })
  title: string;

  @Column({ type: 'text', default: '' })
  body: string;

  // For a reply: the Reddit fullname (t3_/t1_) or other channel-native thread
  // reference being replied to. '' for a new top-level post.
  @Column({ type: 'varchar', default: '' })
  thread_ref: string;

  // Populated once the connector call actually succeeds (status→'published').
  @Column({ type: 'varchar', default: '' })
  external_item_id: string;

  @Column({ type: 'varchar', default: '' })
  permalink: string;

  // kind='deploy' only — the commit this release post/reply was generated
  // for. '' for kind='resolve'. See class docstring point 3.
  @Column({ type: 'varchar', default: '' })
  deployed_commit_sha: string;

  // kind='resolve' only — the ticket whose Done-arrival triggered this reply.
  @Column({ type: 'varchar', nullable: true, default: null })
  source_ticket_id: string | null;

  // kind='resolve' only — the OutreachInboundItem this reply answers.
  @Column({ type: 'varchar', nullable: true, default: null })
  source_item_id: string | null;

  @Column({ type: 'text', default: '' })
  error: string;

  @CreateDateColumn()
  created_at: Date;

  @Column({ type: Date, nullable: true, default: null })
  published_at: Date | null;
}
