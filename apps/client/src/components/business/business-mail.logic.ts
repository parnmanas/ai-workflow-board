import type { BusinessMailMessage, MailConnection } from '../../business-mail.types';

/** Conversation view helpers: pure, so the rules are testable without rendering. */

export type MailComposeMode = 'reply' | 'reply_all' | 'forward';
/** `send_business_mail` accepts at most this many recipients. */
export const MAX_MAIL_RECIPIENTS = 10;
const MAX_SUBJECT = 500;
const MAX_TEXT = 100_000;

export const ownMailAddresses = (connections: Pick<MailConnection, 'config'>[]) =>
  new Set(connections.flatMap(c => c.config.addresses.map(a => a.toLowerCase())));

const unique = (addresses: string[]) => {
  const seen = new Set<string>();
  return addresses.filter(a => { const key = a.trim().toLowerCase(); if (!key || seen.has(key)) return false; seen.add(key); return true; });
};

export function composeRecipients(message: BusinessMailMessage, mode: MailComposeMode, own: Set<string>): string[] {
  if (mode === 'forward') return [];
  const isOwn = (a: string) => own.has(a.toLowerCase());
  // Answering our own sent mail follows up with the same recipients.
  const primary = message.direction === 'outbound' ? message.to : [message.reply_to || message.from];
  const everyone = mode === 'reply_all' ? [...primary, message.from, ...message.to] : primary;
  return unique(everyone.filter(a => !isOwn(a))).slice(0, MAX_MAIL_RECIPIENTS);
}

/** The address this mail reached (or was sent from), when it belongs to the connection. */
export function composeFrom(message: BusinessMailMessage, connection?: Pick<MailConnection, 'config' | 'automation'>): string {
  const addresses = connection?.config.addresses || [];
  const mine = (a: string) => addresses.find(b => b.toLowerCase() === a.toLowerCase());
  const used = message.direction === 'outbound' ? mine(message.from) : message.to.map(mine).find(Boolean);
  return used || (connection?.automation?.from && mine(connection.automation.from)) || addresses[0] || '';
}

const REPLY_PREFIX = /^\s*(?:re|답장|회신)\s*:/i;
const FORWARD_PREFIX = /^\s*(?:fwd?|전달)\s*:/i;
export const isForwardSubject = (subject: string) => FORWARD_PREFIX.test(subject.slice(0, MAX_SUBJECT));

export function composeSubject(subject: string, mode: MailComposeMode): string {
  const base = subject.trim();
  if (mode === 'forward') return (FORWARD_PREFIX.test(base) ? base : `Fwd: ${base}`).trim().slice(0, MAX_SUBJECT);
  return (REPLY_PREFIX.test(base) ? base : `Re: ${base}`).trim().slice(0, MAX_SUBJECT);
}

/** Reply body: room to write, then the original quoted under an attribution line. */
export function composeReplyText(message: BusinessMailMessage, attribution: string): string {
  const quoted = (message.text || '').split('\n').map(line => line ? `> ${line}` : '>').join('\n');
  return `\n\n${attribution}\n${quoted}`.slice(0, MAX_TEXT);
}

/** Forward body: the original header block and text, like mail clients write it. */
export function composeForwardText(message: BusinessMailMessage, header: string[]): string {
  return `\n\n${header.join('\n')}\n\n${message.text || ''}`.slice(0, MAX_TEXT);
}

export function parseRecipients(value: string): string[] {
  return unique(value.split(/[,;\s]+/));
}

// Lines that start a quoted original in replies — plain string checks on one bounded line (mail is untrusted input).
const ORIGINAL_MESSAGE = /^-{2,}\s*(?:original message|원본 메시지|원래 메시지)\s*-{2,}$/i;
const isAttribution = (line: string) => {
  const lower = line.toLowerCase();
  return (lower.startsWith('on ') && lower.endsWith(' wrote:'))
    || (line.includes('@') && /님이\s*작성\s*[:：]$/.test(line.slice(-12)))
    || (line.includes('@') && /(?:写道|書きました)[:：]$/.test(line.slice(-6)))
    || ORIGINAL_MESSAGE.test(line);
};
const OUTLOOK_FROM = /^(?:from|보낸 사람)\s*:/i;
const OUTLOOK_SENT = /^(?:sent|보낸 날짜)\s*:/i;

/**
 * Splits a reply into what the sender wrote and the quoted original, so the conversation shows new text first.
 * Forwards are not split: the forwarded text is their content.
 */
export function splitQuoted(text: string, subject = ''): { body: string; quoted: string } {
  if (!text || isForwardSubject(subject)) return { body: text, quoted: '' };
  const lines = text.split('\n');
  const trimmed = lines.map(line => line.slice(0, 400).trim());
  let cut = -1;
  for (let i = 1; i < lines.length && cut < 0; i++) {
    const line = trimmed[i];
    if (isAttribution(line)) cut = i;
    else if (/^_{10,}$/.test(line) && OUTLOOK_FROM.test(trimmed[i + 1] || '')) cut = i;
    else if (OUTLOOK_FROM.test(line) && OUTLOOK_SENT.test(trimmed[i + 1] || '')) cut = i;
  }
  if (cut < 0) {
    // A trailing block of "> " lines, with its attribution line if one precedes it.
    let start = lines.length;
    while (start > 0 && (trimmed[start - 1] === '' || trimmed[start - 1].startsWith('>'))) start--;
    if (start < lines.length && trimmed.slice(start).some(line => line.startsWith('>'))) cut = start > 0 && trimmed[start - 1].endsWith(':') ? start - 1 : start;
  }
  const body = cut > 0 ? lines.slice(0, cut).join('\n').replace(/\s+$/, '') : text;
  if (cut <= 0 || !body.trim()) return { body: text, quoted: '' };
  return { body, quoted: lines.slice(cut).join('\n') };
}

/** Collapsed by default except the latest, the opened one and mail still waiting for processing. */
export function defaultExpanded(messages: BusinessMailMessage[], focusId: string): Set<string> {
  const open = new Set(messages.filter(m => m.direction === 'inbound' && !m.confirmed).map(m => m.id));
  if (messages.length) open.add(messages[messages.length - 1].id);
  if (focusId) open.add(focusId);
  return open;
}
