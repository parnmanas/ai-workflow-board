import { BadGatewayException, BadRequestException, ConflictException } from '@nestjs/common';
import { z } from 'zod';
import { mailSchema, parseTrademark } from '../trademark.types';
import type { PreparedTrademarkAction, TrademarkConnector, TrademarkConnectorContext, TrademarkSourceRecord } from './trademark-connector';
import { bearer, id, list, nextPage, parseConfig, text } from './trademark-http';

const GOOGLE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GRAPH = 'https://graph.microsoft.com/v1.0/me';
function header(message: any, name: string): string {
  return text(message?.payload?.headers?.find((h: any) => String(h.name).toLowerCase() === name.toLowerCase())?.value, 1000);
}
function gmailText(part: any, depth = 0): string {
  if (!part || depth > 15) return '';
  if (part.mimeType === 'text/plain' && typeof part.body?.data === 'string') return Buffer.from(part.body.data, 'base64url').toString('utf8').slice(0, 100_000);
  return (Array.isArray(part.parts) ? part.parts.slice(0, 30).map((p: any) => gmailText(p, depth + 1)).filter(Boolean).join('\n') : '').slice(0, 100_000);
}
function gmailRecord(message: any): TrademarkSourceRecord {
  return { source_id: id(message.id), kind: 'email', title: header(message, 'Subject'), status: Array.isArray(message.labelIds) && message.labelIds.includes('SENT') ? 'sent' : 'received',
    from: header(message, 'From'), to: [header(message, 'To')], date: Number.isFinite(Number(message.internalDate)) ? new Date(Number(message.internalDate)).toISOString() : '',
    text: gmailText(message.payload) || text(message.snippet, 1000), details: { thread_id: id(message.threadId), message_id: header(message, 'Message-ID') } };
}
function conversations(context: TrademarkConnectorContext, configured: string): string[] {
  let saved: string[] = [];
  try { saved = JSON.parse(context.data.cursor?.conversations || '[]'); } catch { /* An empty cursor starts from configured conversations. */ }
  return [...new Set([...saved, configured].filter(value => typeof value === 'string' && value.length > 0 && value.length < 500))].slice(-20);
}
function prepareMail(context: TrademarkConnectorContext, input: unknown, actionId: string): PreparedTrademarkAction {
  const payload = parseTrademark(mailSchema, input);
  if (payload.to.toLowerCase() !== context.trademark.attorney_email.toLowerCase()) throw new BadRequestException('상표에 지정한 변호사에게만 보낼 수 있습니다.');
  if (payload.from.toLowerCase() !== context.data.identity?.email?.toLowerCase()) throw new BadRequestException('연결한 메일 계정의 발신 주소를 사용하세요.');
  return { review: payload, request: { ...payload, message_id: `<awb-${actionId}@${payload.from.split('@')[1]}>` } };
}
export const trademarkGmail: TrademarkConnector = {
  descriptor: { id: 'gmail', name: 'Gmail', icon: 'mail', auth: 'oauth', credential_provider: 'google_oauth', secret_fields: ['client_id', 'client_secret'], action: 'mail',
    capabilities: ['검토 후 메일 발송', '대화별 회신 수집', 'OAuth 자동 갱신'],
    fields: [{ key: 'thread_id', label: '기존 Gmail 대화 ID · 선택', placeholder: '비우면 AWB에서 발송한 대화부터 수집' }],
    setup: 'Google Cloud 웹 앱에 표시된 callback URL을 등록하고 Gmail API를 켜세요. 읽기·발송 동의를 받습니다. 지정한 대화와 AWB 발송 대화만 자동 수집하며 전체 메일함을 가져오지 않습니다. Gmail 제한 범위는 Google 앱 검증이 필요할 수 있습니다.',
    docs_url: 'https://developers.google.com/workspace/gmail/api/guides/sending' },
  config: value => parseConfig(z.object({ thread_id: z.string().regex(/^[a-zA-Z0-9_-]{0,200}$/).default('') }).strict(), value),
  oauth: {
    endpoints: () => ({ authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send', pkce: true, extra: { access_type: 'offline', prompt: 'consent' } }),
    async identify(context) { const row = await context.request(`${GOOGLE}/profile`, { headers: bearer(context.data.tokens?.access_token) }); return { email: parseConfig(z.email(), row.emailAddress) }; },
  },
  async sync(context) {
    const records: TrademarkSourceRecord[] = []; const threads = conversations(context, context.data.config.thread_id);
    for (const thread of threads) {
      const row = await context.request(`${GOOGLE}/threads/${encodeURIComponent(thread)}?format=full`, { headers: bearer(context.data.tokens?.access_token) });
      if (row.id !== thread) throw new BadGatewayException('Gmail 대화 식별자가 일치하지 않습니다.');
      records.push(...list(row.messages).slice(-100).map(gmailRecord));
    }
    return { records, summary: threads.length ? `${threads.length}개 연결 대화 · 대화당 최근 100개 메시지` : '기존 대화 ID를 지정하거나 AWB에서 메일을 보내면 회신을 수집합니다.' };
  },
  async prepare(context, input, actionId) { return prepareMail(context, input, actionId); },
  async execute(context, prepared) {
    const p = prepared.request;
    const body = Buffer.from(p.text, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
    const raw = [`From: ${p.from}`, `To: ${p.to}`, `Reply-To: ${p.reply_to}`, `Subject: =?UTF-8?B?${Buffer.from(p.subject).toString('base64')}?=`, `Message-ID: ${p.message_id}`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body].join('\r\n');
    const row = await context.request(`${GOOGLE}/messages/send`, { method: 'POST', headers: bearer(context.data.tokens?.access_token), json: { raw: Buffer.from(raw).toString('base64url') } });
    return { id: id(row.id), status: 'accepted', conversation_id: id(row.threadId) };
  },
  async reconcile(context, prepared) {
    const query = new URLSearchParams({ q: `in:sent rfc822msgid:${prepared.request.message_id}`, maxResults: '10' });
    const found = await context.request(`${GOOGLE}/messages?${query}`, { headers: bearer(context.data.tokens?.access_token) });
    const rows = found.messages === undefined && found.resultSizeEstimate === 0 ? [] : list(found.messages);
    if (rows.length !== 1) throw new ConflictException('일치하는 발송 메일 한 건을 확인하지 못했습니다. 자동 재발송하지 않습니다.');
    const row = await context.request(`${GOOGLE}/messages/${encodeURIComponent(id(rows[0].id))}?format=full`, { headers: bearer(context.data.tokens?.access_token) });
    if (header(row, 'Message-ID') !== prepared.request.message_id || !list(row.labelIds).includes('SENT') || header(row, 'To').toLowerCase() !== prepared.request.to.toLowerCase() ||
      header(row, 'From').toLowerCase() !== prepared.request.from.toLowerCase() || header(row, 'Reply-To').toLowerCase() !== prepared.request.reply_to.toLowerCase() || header(row, 'Cc') || header(row, 'Bcc') ||
      header(row, 'Subject') !== prepared.request.subject || gmailText(row.payload).trim() !== prepared.request.text.trim()) throw new ConflictException('발송 원문이 검토한 내용과 다릅니다.');
    return { id: id(row.id), status: 'sent', conversation_id: id(row.threadId) };
  },
};

const graphHeaders = (context: TrademarkConnectorContext) => ({ ...bearer(context.data.tokens?.access_token), Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' });
function graphRecord(row: any): TrademarkSourceRecord {
  return { source_id: id(row.id), kind: 'email', title: text(row.subject), status: row.isDraft ? 'draft' : 'message', from: text(row.from?.emailAddress?.address),
    to: list(row.toRecipients).map(r => text(r.emailAddress?.address)), date: text(row.receivedDateTime || row.sentDateTime), text: text(row.body?.content, 100_000),
    details: { conversation_id: id(row.conversationId), message_id: text(row.internetMessageId), has_attachments: row.hasAttachments ? '첨부 있음 · 메일함에서 확인' : '' } };
}
export const trademarkMicrosoft: TrademarkConnector = {
  descriptor: { id: 'microsoft_mail', name: 'Microsoft 365', icon: 'mail', auth: 'oauth', credential_provider: 'microsoft_oauth', secret_fields: ['client_id', 'client_secret'], action: 'mail',
    capabilities: ['검토 후 메일 발송', '대화별 회신 수집', 'OAuth 자동 갱신'],
    fields: [{ key: 'tenant', label: 'Entra tenant', placeholder: 'common 또는 조직 tenant UUID' }, { key: 'conversation_id', label: '기존 대화 ID · 선택' }],
    setup: 'Entra에 Web 앱 callback URL을 등록하세요. 위임 권한 User.Read·Mail.ReadWrite·Mail.Send·offline_access가 필요합니다. 초안을 먼저 저장해 발송 결과를 대조합니다. 조직 정책에 따라 관리자 동의가 필요합니다.',
    docs_url: 'https://learn.microsoft.com/en-us/graph/api/message-send?view=graph-rest-1.0' },
  config: value => parseConfig(z.object({ tenant: z.string().regex(/^(common|organizations|consumers|[a-fA-F0-9-]{36})$/).default('common'), conversation_id: z.string().max(500).regex(/^[a-zA-Z0-9+/=_-]*$/).default('') }).strict(), value),
  oauth: {
    endpoints: config => ({ authorize: `https://login.microsoftonline.com/${config.tenant}/oauth2/v2.0/authorize`, token: `https://login.microsoftonline.com/${config.tenant}/oauth2/v2.0/token`, scope: 'offline_access User.Read Mail.ReadWrite Mail.Send', pkce: true }),
    async identify(context) { const row = await context.request(`${GRAPH}?$select=id,mail,userPrincipalName`, { headers: graphHeaders(context) }); return { id: id(row.id), email: parseConfig(z.email(), row.mail || row.userPrincipalName) }; },
  },
  async sync(context) {
    const records: TrademarkSourceRecord[] = []; const threads = conversations(context, context.data.config.conversation_id); let limited = false;
    for (const thread of threads) {
      const query = new URLSearchParams({ '$filter': `conversationId eq '${thread.replace(/'/g, "''")}'`, '$top': '50', '$select': 'id,subject,from,toRecipients,body,receivedDateTime,sentDateTime,conversationId,internetMessageId,isDraft,hasAttachments' });
      let url: string | null = `${GRAPH}/messages?${query}`; let pages = 0;
      while (url && pages++ < 2) {
        const row = await context.request(url, { headers: graphHeaders(context) });
        const messages = list(row.value); if (messages.some(m => m.conversationId !== thread)) throw new BadGatewayException('연결한 대화 외 메일이 반환되었습니다.');
        records.push(...messages.map(graphRecord)); url = nextPage(row['@odata.nextLink'], 'https://graph.microsoft.com', '/v1.0/me/messages');
      }
      limited ||= !!url;
    }
    return { records, summary: threads.length ? `${threads.length}개 연결 대화 · ${records.length}개 메시지${limited ? ' · 100개 초과 대화는 메일함에서 전체 확인' : ''}` : '기존 대화 ID를 지정하거나 AWB에서 보낸 메일의 회신을 수집합니다.' };
  },
  async prepare(context, input, actionId) { return prepareMail(context, input, actionId); },
  async execute(context, prepared, actionId, checkpoint) {
    const p = prepared.request;
    const draft = await context.request(`${GRAPH}/messages`, { method: 'POST', headers: graphHeaders(context), json: { subject: p.subject, body: { contentType: 'Text', content: p.text },
      toRecipients: [{ emailAddress: { address: p.to } }], replyTo: [{ emailAddress: { address: p.reply_to } }], internetMessageHeaders: [{ name: 'X-AWB-Trademark-Action', value: actionId }] } });
    const externalId = id(draft.id); await checkpoint(externalId);
    await context.request(`${GRAPH}/messages/${encodeURIComponent(externalId)}/send`, { method: 'POST', headers: graphHeaders(context), response: 'empty' });
    return { id: externalId, status: 'accepted', conversation_id: id(draft.conversationId) };
  },
  async reconcile(context, prepared, actionId, externalId) {
    if (!externalId) throw new ConflictException('Microsoft 메일 ID를 입력해 원문을 대조하세요.');
    const row = await context.request(`${GRAPH}/messages/${encodeURIComponent(id(externalId))}?$select=id,subject,from,toRecipients,ccRecipients,bccRecipients,replyTo,body,isDraft,internetMessageHeaders,conversationId`, { headers: graphHeaders(context) });
    if (row.isDraft !== false) throw new ConflictException('아직 초안입니다. 메일함에서 발송 여부를 확인하세요. 자동 재발송하지 않습니다.');
    if (!list(row.internetMessageHeaders).some(h => String(h.name).toLowerCase() === 'x-awb-trademark-action' && h.value === actionId) || row.subject !== prepared.request.subject ||
      row.body?.content?.trim() !== prepared.request.text.trim() || list(row.toRecipients).length !== 1 || row.toRecipients[0].emailAddress?.address?.toLowerCase() !== prepared.request.to.toLowerCase() ||
      row.from?.emailAddress?.address?.toLowerCase() !== prepared.request.from.toLowerCase() || list(row.replyTo).length !== 1 || row.replyTo[0].emailAddress?.address?.toLowerCase() !== prepared.request.reply_to.toLowerCase() ||
      list(row.ccRecipients || []).length || list(row.bccRecipients || []).length) {
      throw new ConflictException('Microsoft 메일이 검토한 발송 원문과 다릅니다.');
    }
    return { id: id(row.id), status: 'sent', conversation_id: id(row.conversationId) };
  },
};
