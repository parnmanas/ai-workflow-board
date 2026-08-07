import { InboundItem, OutboundPost, OutboundResult, OutreachConnector } from './types';

/**
 * In-memory OutreachConnector for tests and for this ticket's scope cut (real
 * Reddit/GitHub connectors are follow-up tickets). `fetchInbound` filters
 * strictly-after `since`, parsed as a Date; an empty/unparseable `since`
 * (a channel's first poll) behaves as "beginning of time" — everything seeded
 * is returned.
 */
export class FakeOutreachConnector implements OutreachConnector {
  readonly published: OutboundPost[] = [];
  readonly replies: Array<{ threadRef: string; body: string }> = [];
  private items: InboundItem[];

  constructor(items: InboundItem[] = []) {
    this.items = items.slice();
  }

  /** Add more items after construction (simulates new activity arriving between polls). */
  seed(items: InboundItem[]): void {
    this.items.push(...items);
  }

  async fetchInbound(since: string): Promise<InboundItem[]> {
    const sinceMs = since ? new Date(since).getTime() : 0;
    const threshold = Number.isFinite(sinceMs) ? sinceMs : 0;
    return this.items
      .filter((item) => item.created_at.getTime() > threshold)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  }

  async publish(post: OutboundPost): Promise<OutboundResult> {
    this.published.push(post);
    const id = `fake-post-${this.published.length}`;
    return { external_item_id: id, permalink: `fake://post/${id}` };
  }

  async reply(threadRef: string, body: string): Promise<OutboundResult> {
    this.replies.push({ threadRef, body });
    const id = `fake-reply-${this.replies.length}`;
    return { external_item_id: id, permalink: `fake://reply/${id}` };
  }
}
