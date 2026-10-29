/**
 * Conversation headers — pure helpers shared by the connectors and threading (mail-thread.ts).
 * Inputs are received mail: every pattern is anchored and runs over bounded header values, never the body.
 */

const BRACKETED_ID = /<[^<>\s]{1,990}>/g;
const BARE_ID = /^[^<>\s]{1,990}$/;

/** Message-ID tokens in header order. JMAP strips the angle brackets, so bare ids are wrapped. */
export function mailIds(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const ids: string[] = [];
  for (const item of values.slice(0, 200)) {
    if (typeof item !== 'string') continue;
    const text = item.slice(0, 20_000);
    const found = text.match(BRACKETED_ID);
    if (found) ids.push(...found);
    else if (BARE_ID.test(text.trim())) ids.push(`<${text.trim()}>`);
  }
  return [...new Set(ids)];
}

/** References trimmed like mail clients do: the conversation root stays first, then the nearest ancestors. */
export function mailReferenceChain(value: unknown, max = 30): string[] {
  const ids = mailIds(value);
  return ids.length > max ? [ids[0], ...ids.slice(-(max - 1))] : ids;
}

// Reply/forward markers in the languages mail clients actually emit, with optional counters (`Re[2]:`).
const SUBJECT_PREFIX = /^\s*(?:\[(?:fwd?|re)\]|(?:re|fwd?|aw|wg|sv|vs|antw|tr|rif|res|enc|답장|회신|전달|返信|転送|回复|答复|转发|回覆|轉寄)(?:\s*(?:\[\d{1,4}\]|\(\d{1,4}\)))?\s*[:：])/i;

/** Subject without reply/forward prefixes, compared case-insensitively. `prefixed` marks a reply or forward. */
export function mailSubjectBase(subject: string): { base: string; prefixed: boolean } {
  let text = String(subject || '').slice(0, 1000);
  let prefixed = false;
  for (let i = 0; i < 20; i++) {
    const next = text.replace(SUBJECT_PREFIX, '');
    if (next === text) break;
    text = next; prefixed = true;
  }
  return { base: text.replace(/\s+/g, ' ').trim().toLowerCase(), prefixed };
}

/** Other parties of a message. Mail only among the connected addresses keeps them all. */
export function mailParticipants(content: { from?: string; reply_to?: string; to?: string[] }, own: Set<string>): Set<string> {
  const all = [content.from, content.reply_to, ...(content.to || [])].filter((a): a is string => !!a).map(a => a.toLowerCase());
  const others = all.filter(a => !own.has(a));
  return new Set(others.length ? others : all);
}
