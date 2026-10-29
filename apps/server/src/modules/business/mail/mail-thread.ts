import { In, MoreThanOrEqual, Not, type EntityManager } from 'typeorm';
import { BusinessMailMessage } from '../../../entities/BusinessMailMessage';
import { decryptStrict, keyedDigest } from '../../../services/encryption.service';
import { mailIds, mailParticipants, mailReferenceChain, mailSubjectBase } from './mail-headers';
import type { MailContent } from './mail.types';

/**
 * Conversation grouping (docs/business.md → 대화 보기). Mail content is encrypted at rest, so each row carries
 * keyed digests of its Message-ID, conversation and subject instead of plaintext headers.
 *
 * 1. A known ancestor (In-Reply-To, then References from the nearest) decides the conversation.
 * 2. Otherwise the first References entry is the conversation root (RFC 5322 3.6.4), so siblings agree
 *    without having seen each other.
 * 3. A reply/forward without a usable chain joins a recent same-subject conversation with a shared party
 *    (or whose party appears in a forwarded body). Subjects alone never merge unrelated mail.
 * 4. Otherwise the message starts a conversation anchored on its parent or its own Message-ID.
 */
export const MAIL_THREAD_SUBJECT_WINDOW_MS = 60 * 86_400_000;
const MAX_PARENTS = 30;
const SUBJECT_CANDIDATES = 20;

export interface MailThreadKeys { message_key: string; thread_key: string; subject_key: string }

const key = (purpose: string, accountId: string, value: string) => keyedDigest(`business-mail-${purpose}`, `${accountId}\n${value}`).slice(0, 40);
const anchor = (accountId: string, value: string) => key('thread', accountId, value);
export const mailMessageKey = (accountId: string, messageId: string) => key('message', accountId, messageId);

/** References for an outgoing reply or forward: the parent's chain plus the parent (RFC 5322 3.6.4). */
export function mailReferences(parent: Pick<MailContent, 'message_id' | 'references' | 'in_reply_to'>): string[] {
  const chain = mailIds(parent.references);
  const own = mailIds(parent.message_id)[0];
  const base = chain.length ? chain : mailIds(parent.in_reply_to);
  return mailReferenceChain([...base, ...(own ? [own] : [])], MAX_PARENTS);
}

export async function assignMailThread(manager: EntityManager, input: {
  accountId: string; rowId: string; content: MailContent; own: Set<string>; at: Date; parentThread?: string;
}): Promise<MailThreadKeys> {
  const { accountId, content } = input;
  const repo = manager.getRepository(BusinessMailMessage);
  const self = mailIds(content.message_id)[0] || '';
  const references = mailIds(content.references);
  const parents = [...new Set([...mailIds(content.in_reply_to), ...[...references].reverse()])].filter(id => id !== self).slice(0, MAX_PARENTS);
  const { base, prefixed } = mailSubjectBase(content.subject);
  const keys = { message_key: self ? mailMessageKey(accountId, self) : '', subject_key: base ? key('subject', accountId, base) : '' };
  let thread = input.parentThread || '';
  if (!thread && parents.length) {
    const parentKeys = parents.map(id => mailMessageKey(accountId, id));
    const known = await repo.find({ where: { account_id: accountId, message_key: In(parentKeys), thread_key: Not('') }, select: ['id', 'message_key', 'thread_key'] });
    thread = parentKeys.map(k => known.find(row => row.message_key === k)?.thread_key).find(Boolean) || '';
  }
  if (!thread && references.length) thread = anchor(accountId, references[0]);
  if (!thread && keys.subject_key && (prefixed || parents.length)) {
    const recent = await repo.find({ where: { account_id: accountId, subject_key: keys.subject_key, thread_key: Not(''),
      created_at: MoreThanOrEqual(new Date(input.at.getTime() - MAIL_THREAD_SUBJECT_WINDOW_MS)) }, order: { created_at: 'DESC' }, take: SUBJECT_CANDIDATES });
    const mine = mailParticipants(content, input.own);
    const body = (content.text || '').slice(0, 200_000).toLowerCase();
    const parties = (row: BusinessMailMessage) => { try { return [...mailParticipants(JSON.parse(decryptStrict(row.encrypted_data)) as MailContent, input.own)]; } catch { return []; } };
    thread = recent.find(row => parties(row).some(address => mine.has(address) || body.includes(address)))?.thread_key || '';
  }
  thread ||= anchor(accountId, parents[0] || self || `row:${input.rowId}`);
  // Replies that arrived first anchored on this Message-ID; they belong wherever this message went.
  if (self && anchor(accountId, self) !== thread) await repo.update({ account_id: accountId, thread_key: anchor(accountId, self) }, { thread_key: thread });
  return { ...keys, thread_key: thread };
}

