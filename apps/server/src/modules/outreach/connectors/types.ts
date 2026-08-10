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
  /** Reply to an existing thread/issue on the channel. Real implementations follow. */
  reply(threadRef: string, body: string): Promise<OutboundResult>;
  /**
   * Optional: close/resolve the native thread (e.g. a GitHub issue). Reddit
   * has no equivalent concept, so this is opt-in — callers must feature-test
   * (`connector.close?.(...)`) rather than assume every connector implements
   * it (ticket 31e7cd24, GitHub's off-by-default issue-close option).
   */
  close?(threadRef: string): Promise<void>;
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
