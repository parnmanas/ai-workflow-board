import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export type OutreachChannelKind = 'reddit' | 'github';
export type OutreachPublishPolicy = 'auto' | 'approval' | 'off';
export type OutreachDeployPostMode = 'new_post' | 'reply_to_existing' | 'auto' | 'off';

/**
 * OutreachChannel — workspace-scoped registration of an external feedback
 * channel (a Reddit subreddit list, or a GitHub repo) that OutreachPollingService
 * sweeps periodically. Each due sweep calls OutreachIngestService.pollChannel,
 * which fetches inbound items via an OutreachConnector (ticket 2500fea3) and
 * classifies/tickets them.
 *
 * Cadence mirrors QaSchedule (ticket b6bb7efd): the tick loop lives in
 * OutreachPollingService, NOT here — this entity only holds the cursor state
 * a tick compares against. Unlike QaSchedule, `next_poll_at` is REQUIRED
 * (no "disabled → null" state) because a disabled channel is simply excluded
 * from the sweep query by `enabled=false`, not by clearing the cursor.
 *
 * `credential_id` is a bare FK-less pointer into the shared Credential table
 * (same pattern as Resource.credential_id) — resolved via outreach-credential.ts's
 * `resolveOutreachCredential`, which mirrors git-branches.ts's `resolveGitCredential`
 * workspace-scope guard (global credential OR same-workspace; a mismatched
 * workspace throws rather than silently resolving to no token).
 *
 * `target_board_id` is null-friendly the same way
 * agent-api.controller.ts's `operational-capability-ticket` fallback is:
 * null resolves to the workspace's earliest-created board at ticket-creation
 * time, so registering a channel never requires wiring a board id up front.
 */
@Entity('outreach_channels')
@Index(['workspace_id', 'enabled'])
export class OutreachChannel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  kind: OutreachChannelKind;

  @Column({ type: 'varchar' })
  name: string;

  // Target identifiers: subreddit names for kind='reddit', "owner/repo"
  // strings for kind='github'. TypeORM simple-json (de)serializes
  // automatically — no manual JSON.stringify/parse touch points, unlike the
  // Ticket JSON-string columns (see QaSchedule.scenario_ids docstring for the
  // same precedent on a brand-new entity).
  @Column({ type: 'simple-json', default: '[]' })
  targets: string[];

  @Column({ type: 'varchar', nullable: true, default: null })
  credential_id: string | null;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  // 'auto' | 'approval' | 'off' — governs OutreachConnector.publish/reply in
  // the follow-up channel-specific tickets. This ticket only stores the
  // policy; no publish/reply call site reads it yet.
  @Column({ type: 'varchar', default: 'approval' })
  publish_policy: OutreachPublishPolicy;

  @Column({ type: 'int', default: 0 })
  rate_limit_per_hour: number;

  // Destination board for bug/feature_request tickets. null → resolved to the
  // workspace's earliest-created board at creation time (see class docstring).
  @Column({ type: 'varchar', nullable: true, default: null })
  target_board_id: string | null;

  @Column({ type: 'int', default: 3600000 })
  poll_interval_ms: number;

  // Optional 5-field UTC cron (qa-cron.ts) overriding poll_interval_ms —
  // exactly one of the two drives computeNextPoll, same "reject both/neither"
  // contract as QaScheduleService._validateCadence.
  @Column({ type: 'varchar', nullable: true, default: null })
  poll_cron: string | null;

  @Column({ type: Date, nullable: true, default: null })
  next_poll_at: Date | null;

  @Column({ type: Date, nullable: true, default: null })
  last_poll_at: Date | null;

  // Opaque cursor OutreachConnector.fetchInbound(since) is called with —
  // typically an ISO timestamp string, advanced to the max collected_at of
  // the items processed in the most recent poll. Stored as varchar (not
  // Date) because connectors may use a non-timestamp cursor (e.g. a Reddit
  // `after` token) in the follow-up channel-specific implementations.
  @Column({ type: 'varchar', default: '' })
  since_cursor: string;

  // 0-100 scale, same as TicketDuplicateDecision.confidence. An item whose
  // classifier confidence falls below this is held (status='held') instead
  // of ticketed or discarded.
  @Column({ type: 'int', default: 70 })
  classify_threshold: number;

  // Agent dispatched to classify each new inbound item (ticket 20fa0197's
  // AgentDispatchClassifier) — a chat room is created per item and this
  // agent is asked to report category+confidence back via
  // record_outreach_classification. null (default) keeps classification
  // fully rule-based (RuleBasedClassifier) — today's behavior, unchanged;
  // this is also the fallback when the dispatched agent doesn't report back
  // in time.
  @Column({ type: 'varchar', nullable: true, default: null })
  classifier_agent_id: string | null;

  // Deploy-triggered publish behavior (ticket d86d0c24, the ticket's core
  // request). Default 'off' — an EXISTING channel must never start posting
  // on deploys just because this column appeared (backward compatibility);
  // an operator opts in explicitly per channel. See OutreachPublisherService
  // for how each mode resolves to new_post vs. reply.
  @Column({ type: 'varchar', default: 'off' })
  deploy_post_mode: OutreachDeployPostMode;

  // deploy_post_mode='reply_to_existing' only — the fixed thread every deploy
  // reply targets (a channel-native thread ref, e.g. a Reddit fullname).
  // Unused by the other three modes.
  @Column({ type: 'varchar', nullable: true, default: null })
  reply_thread_ref: string | null;

  // deploy_post_mode='auto' only — "recent" window (days) OutreachPublisherService
  // looks back across OutreachOutboundPost for a still-fresh kind='deploy'
  // published row before deciding reply vs. new_post. This is an APPROXIMATION
  // of "is our post still alive" (recency of our own publish record), not a
  // live Reddit status check — the connector interface has no such lookup
  // method (see OutreachPublisherService docstring).
  @Column({ type: 'int', default: 30 })
  auto_reuse_window_days: number;

  // Deployment-fact gate for resolution replies (ticket 31e7cd24 — "판정은
  // 컬럼 도달만으로 끝내지 말 것"). Mirrors QaScenario.target_environment: the
  // Deployment.environment name OutreachResolveNotifierService checks before
  // replying "resolved" on the backlinked external thread. '' (default)
  // preserves today's Reddit behavior exactly (reply fires on terminal-column
  // arrival alone, no gate) — an operator opts a channel into the stricter
  // evidence-gated flow explicitly. See outreach-resolve-notifier.service.ts.
  @Column({ type: 'varchar', default: '' })
  target_environment: string;

  // Whether a confirmed resolution reply also closes the native thread (e.g.
  // a GitHub issue) via OutreachConnector.close(). Default false — the
  // ticket's explicit "자동 close는 기본 off, 옵션으로만 제공" requirement
  // (an oversensitive resolve-detection wrongly closing someone else's issue
  // is a hard-to-reverse mistake). Unused by connectors that don't implement
  // close() (e.g. Reddit has no equivalent).
  @Column({ type: 'boolean', default: false })
  close_on_resolve: boolean;

  // Connector health state (ticket d86d0c24 review fix #2 — "403/차단 상태가
  // 채널 상태에 기록되지 않습니다"). Server-managed only (never part of
  // Create/UpdateChannelInput, same as next_poll_at/last_poll_at) — written by
  // outreach-channel-health.ts's recordChannelSuccess/recordChannelFailure,
  // called from every site that actually invokes a connector (poll, deploy-
  // publish, resolve-notify). Clear-on-success policy: a successful call
  // clears all five fields, so they always reflect the MOST RECENT outcome
  // rather than a sticky flag an operator would have to manually clear.
  @Column({ type: Date, nullable: true, default: null })
  blocked_at: Date | null;

  @Column({ type: 'varchar', default: '' })
  blocked_reason: string;

  @Column({ type: Date, nullable: true, default: null })
  rate_limited_until: Date | null;

  @Column({ type: 'varchar', default: '' })
  last_error: string;

  @Column({ type: Date, nullable: true, default: null })
  last_error_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
