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
}

export interface InboundItem {
  external_item_id: string;
  title: string;
  body: string;
  author: string;
  permalink: string;
  created_at: Date;
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
