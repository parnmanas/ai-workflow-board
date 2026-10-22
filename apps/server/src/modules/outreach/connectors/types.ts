/**
 * OutreachConnector — the channel-agnostic surface OutreachIngestService and
 * OutreachPollingService drive. Reddit/GitHub implementations are follow-up
 * tickets (this ticket's scope stops at the interface + FakeOutreachConnector);
 * a future implementation resolves its own auth from an already-decrypted
 * token (see outreach-credential.ts) — connectors never see a credential_id
 * or touch the Credential table themselves, which keeps the decrypt boundary
 * (and therefore the log-exposure surface) at one call site.
 */
export interface OutreachConnector {
  /** Items observed strictly after `since` (an opaque cursor — typically an
   *  ISO timestamp; '' means "from the beginning"), oldest first. */
  fetchInbound(since: string): Promise<InboundItem[]>;
  /** Publish a new top-level post to the channel. Real implementations follow. */
  publish(post: OutboundPost): Promise<OutboundResult>;
  /** Reply to an existing thread/issue on the channel. Real connectors refuse a
   *  thread outside the channel's `targets` themselves, whatever the caller
   *  checked — GitHub reads the repo off the ref, Reddit looks the thread up. */
  reply(threadRef: string, body: string): Promise<OutboundResult>;
  /**
   * Optional: close/resolve the native thread (e.g. a GitHub issue). Reddit
   * has no equivalent concept, so this is opt-in — callers must feature-test
   * (`connector.close?.(...)`) rather than assume every connector implements
   * it (ticket 31e7cd24, GitHub's off-by-default issue-close option).
   */
  close?(threadRef: string): Promise<void>;
  /**
   * Optional: where a thread lives — `target` is the same whitelist identifier
   * `publish` takes (subreddit name / "owner/repo"). Marketing replies call this
   * before drafting so a reply can never land in a thread outside its channel
   * (docs/marketing.md "커뮤니케이션"). `title` is outsider text — display only.
   */
  describeThread?(threadRef: string): Promise<ThreadInfo>;
  /**
   * Optional: how things this channel published are doing — `refs` are the
   * `OutboundResult.external_item_id`s `publish`/`reply` returned. Read-only.
   * A ref outside the channel's `targets`, or one the platform no longer
   * returns without a definite status, is left out of the result. Definite
   * removal/deletion/lock or access loss is reported as availability. Marketing
   * collects engagement with it (docs/marketing.md "참여 지표 자동 수집").
   */
  readEngagement?(refs: string[]): Promise<EngagementReading[]>;
  /**
   * How many refs one `readEngagement` request covers — reddit's /api/info
   * takes 100 fullnames at once, GitHub has no batch read (1). Each request
   * counts against the channel's rate cap, so callers size their batches
   * with it.
   */
  readonly engagementRefsPerRequest?: number;
}

export interface EngagementReading {
  ref: string;
  /** Fixed platform status only; no external removal reason or post text. */
  availability?: 'removed' | 'deleted' | 'locked' | 'unavailable';
  /** The platform's reaction count: reddit's score (net votes), GitHub's
   *  total reactions. null = the platform is hiding it for now. */
  reactions: number | null;
  /** Comment count, or null for a thing that has none of its own (a comment). */
  comments: number | null;
}

export interface ThreadInfo {
  target: string;
  permalink: string;
  title: string;
}

export interface InboundItem {
  external_item_id: string;
  title: string;
  body: string;
  author: string;
  permalink: string;
  created_at: Date;
  /**
   * Opt-in threading (ticket 31e7cd24): when set AND the referenced parent's
   * OutreachInboundItem already resolved to a ticket, OutreachIngestService
   * appends this item as a ticket COMMENT instead of running it through
   * classify/ticket-creation — e.g. a new comment on an already-ticketed
   * GitHub issue. Unset (the FakeOutreachConnector/RedditConnector default)
   * preserves today's "every item is a standalone classify candidate"
   * behavior exactly — purely additive, no existing connector is affected.
   */
  parent_external_item_id?: string;
}

export interface OutboundPost {
  target: string;
  title: string;
  body: string;
}

export interface OutboundResult {
  external_item_id: string;
  permalink: string;
}
