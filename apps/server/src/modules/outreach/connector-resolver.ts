/**
 * Shared `OutreachChannel.kind` → live OutreachConnector resolution (ticket
 * d86d0c24). Every caller that needs a real connector — OutreachPollingService
 * (inbound polling), OutreachPublisherService (deploy-triggered publish),
 * OutreachResolveNotifierService (resolution replies) — goes through this one
 * function so the kind→class mapping and the Reddit User-Agent convention
 * live in exactly one place instead of being copy-pasted three times.
 *
 * Credential resolution stays OUTSIDE the connector (same D1 contract as the
 * pre-existing polling code): this function resolves the credential, then
 * hands the connector an already-decrypted token — a connector never sees a
 * credential_id or touches the Credential table itself.
 */
import { Repository } from 'typeorm';
import { Credential } from '../../entities/Credential';
import { OutreachChannel } from '../../entities/OutreachChannel';
import { resolveOutreachCredential } from './outreach-credential';
import { FakeOutreachConnector } from './connectors/fake.connector';
import { RedditConnector } from './connectors/reddit.connector';
import { OutreachConnector } from './connectors/types';

// Reddit requires a descriptive, non-default User-Agent identifying the
// client (ticket risk item: "봇 계정 규약 — User-Agent 명시"). Kept as a single
// constant (not per-channel-configurable) since every AWB-operated Reddit
// channel is the same bot software, regardless of which subreddits/workspace
// it's configured for.
export const REDDIT_USER_AGENT = 'AwbOutreachBot/1.0 (by /u/awb-outreach-bot; automated release notes + feedback triage; github.com/parnmanas/ai-workflow-board)';

export async function resolveChannelConnector(
  channel: OutreachChannel,
  credentialRepo: Repository<Credential>,
): Promise<OutreachConnector> {
  const credential = await resolveOutreachCredential(credentialRepo, channel.credential_id, channel.workspace_id);
  if (channel.kind === 'reddit') {
    if (!credential) throw new Error(`outreach channel ${channel.id} (reddit) has no credential configured`);
    // Fail-closed (ticket risk item: whitelist-only, never auto-expand) —
    // an explicit throw here (surfaced as a failed poll/publish) instead of
    // silently constructing a connector that would just no-op forever, so an
    // empty whitelist is visible to an operator rather than looking healthy.
    if (!Array.isArray(channel.targets) || channel.targets.length === 0) {
      throw new Error(`outreach channel ${channel.id} (reddit) has no target subreddit whitelist configured — refusing to poll/publish (fail-closed)`);
    }
    return new RedditConnector(credential, {
      targets: channel.targets,
      userAgent: REDDIT_USER_AGENT,
      channelId: channel.id,
      rateLimitPerHour: channel.rate_limit_per_hour,
    });
  }
  // kind='github' real connector is a separate follow-up ticket (31e7cd24) —
  // every other kind keeps using the in-memory fake, same as before this
  // ticket.
  return new FakeOutreachConnector();
}
