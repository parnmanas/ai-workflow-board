import { EngagementReading, InboundItem, OutboundPost, OutboundResult, OutreachConnector, ThreadInfo } from './types';

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
  /** describeThread 의 답 — 테스트가 채운다. 없는 ref 는 "찾을 수 없음". */
  readonly threads = new Map<string, ThreadInfo>();
  /** readEngagement 의 답 — 테스트가 채운다. 없는 ref 는 결과에서 빠진다(지워진 글 · 채널 밖). */
  readonly engagement = new Map<string, Omit<EngagementReading, 'ref'>>();
  /** readEngagement 를 부를 때마다 받은 refs. */
  readonly engagementCalls: string[][] = [];
  engagementRefsPerRequest = 100;
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

  async describeThread(threadRef: string): Promise<ThreadInfo> {
    const info = this.threads.get(threadRef);
    if (!info) throw new Error(`thread ${threadRef} was not found`);
    return info;
  }

  async readEngagement(refs: string[]): Promise<EngagementReading[]> {
    this.engagementCalls.push([...refs]);
    return refs.filter((ref) => this.engagement.has(ref)).map((ref) => ({ ref, ...this.engagement.get(ref)! }));
  }

  async reply(threadRef: string, body: string): Promise<OutboundResult> {
    this.replies.push({ threadRef, body });
    const id = `fake-reply-${this.replies.length}`;
    return { external_item_id: id, permalink: `fake://reply/${id}` };
  }
}
