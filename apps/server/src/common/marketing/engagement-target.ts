/** Parse identifiers only; never fetch an arbitrary permalink or follow redirects. */
export interface EngagementTarget {
  platform: 'reddit' | 'github';
  target: string;
  ref: string;
}

export function parseEngagementPermalink(permalink: string): EngagementTarget | null {
  let url: URL;
  try { url = new URL(permalink); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
  if (['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com', 'np.reddit.com'].includes(url.hostname)) {
    const match = url.pathname.match(/^\/r\/([a-z0-9_]+)\/comments\/([a-z0-9]+)(?:\/[^/]+(?:\/([a-z0-9]+))?)?\/?$/i);
    if (!match || url.hash) return null;
    return { platform: 'reddit', target: match[1].toLowerCase(), ref: `${match[3] ? 't1' : 't3'}_${(match[3] || match[2]).toLowerCase()}` };
  }
  if (url.hostname === 'github.com') {
    const match = url.pathname.match(/^\/([a-z0-9-]+)\/([a-z0-9_.-]+)\/issues\/([1-9][0-9]*)\/?$/i);
    if (!match || !Number.isSafeInteger(Number(match[3]))) return null;
    const comment = url.hash.match(/^#issuecomment-([1-9][0-9]*)$/);
    if (url.hash && !comment) return null;
    if (comment && !Number.isSafeInteger(Number(comment[1]))) return null;
    const target = `${match[1]}/${match[2]}`.toLowerCase();
    return { platform: 'github', target, ref: comment ? `comment:${target}#${match[3]}:${comment[1]}` : `issue:${target}#${match[3]}` };
  }
  return null;
}

/** Stable selection keeps overlapping whitelists from multiplying a post's request budget. */
export function manualEngagementTarget(
  post: { account_id: string; permalink: string },
  channel: { account_id: string; kind: string } | undefined,
  outreach: readonly { id: string; account_id: string; kind: string; targets: string[] }[],
): (EngagementTarget & { outreachId: string }) | null {
  if (!channel || channel.kind !== 'manual' || channel.account_id !== post.account_id) return null;
  const parsed = parseEngagementPermalink(post.permalink);
  if (!parsed) return null;
  const match = outreach.filter((c) => c.account_id === post.account_id && c.kind === parsed.platform
    && c.targets.some((t) => t.trim().toLowerCase() === parsed.target)).sort((a, b) => a.id.localeCompare(b.id))[0];
  return match ? { ...parsed, outreachId: match.id } : null;
}
