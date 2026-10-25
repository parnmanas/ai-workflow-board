import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { simpleParser } from 'mailparser';
import { mailEvents, mailJson, mailUrl } from './mail-network';
import type { MailConnector, MailContext, MailContent } from './mail.types';

const CORE = 'urn:ietf:params:jmap:core';
const MAIL = 'urn:ietf:params:jmap:mail';
const SUBMISSION = 'urn:ietf:params:jmap:submission';
const clean = (value: unknown, max = 1000) => typeof value === 'string' ? value.replace(/[\r\n\x00]/g, '').slice(0, max) : '';

async function session(context: MailContext) {
  const url = mailUrl(context.config.jmap_url || '');
  const info = await mailJson(url.toString(), context.secrets.jmap_token);
  const accountId = context.config.jmap_account_id || info.primaryAccounts?.[MAIL];
  if (!accountId || !info.accounts?.[accountId]?.accountCapabilities?.[MAIL]) throw new BadRequestException('JMAP Mail 계정을 확인하세요.');
  const api = mailUrl(info.apiUrl, url.origin).toString();
  const call = async (method: string, args: Record<string, any>, send = false) => {
    if (send && !info.accounts[accountId].accountCapabilities[SUBMISSION]) throw new BadRequestException('JMAP Submission을 지원하지 않는 계정입니다.');
    const result = await mailJson(api, context.secrets.jmap_token, {
      using: [CORE, MAIL, ...(send ? [SUBMISSION] : [])], methodCalls: [[method, { accountId, ...args }, 'm']],
    });
    const response = result.methodResponses?.find((r: any) => r[2] === 'm');
    if (!response || response[0] !== method || response[1]?.accountId !== accountId) throw new BadGatewayException('JMAP 요청이 거부되었습니다. 권한과 동기화 상태를 확인하세요.');
    return response[1];
  };
  return { call, accountId, info, origin: url.origin };
}

export const jmapConnector: MailConnector = {
  descriptor: { id: 'jmap', name: 'JMAP', credential_provider: 'mail', note: 'HTTPS Session URL과 Bearer API 토큰을 사용합니다. 발신에는 Mail·Submission 권한이 필요합니다. 최초 받은편지함 최근 20건을 수집합니다.' },
  async sync(context) {
    const { call, accountId } = await session(context);
    const folders = await call('Mailbox/get', { properties: ['id', 'role'] });
    const inbox = folders.list?.find((f: any) => f.role === 'inbox')?.id;
    if (!inbox) throw new BadRequestException('JMAP 받은편지함을 찾을 수 없습니다.');
    let ids: string[]; let state: string; let more = false;
    if (context.cursor.state) {
      if (context.cursor.account_id !== accountId) throw new BadRequestException('메일 계정이 변경되었습니다. 새 연결을 등록하세요.');
      const changes = await call('Email/changes', { sinceState: context.cursor.state, maxChanges: 20 });
      ids = changes.created; state = changes.newState; more = changes.hasMoreChanges === true;
    } else {
      // Snapshot before the initial query: arrivals during bootstrap are replayed and deduplicated.
      state = (await call('Email/get', { ids: [], properties: ['id'] })).state;
      ids = (await call('Email/query', { filter: { inMailbox: inbox }, sort: [{ property: 'receivedAt', isAscending: false }], limit: 20 })).ids;
    }
    if (!Array.isArray(ids) || ids.length > 100 || typeof state !== 'string') throw new BadGatewayException('JMAP 수집 상태를 확인하지 못했습니다.');
    const messages: MailContent[] = [];
    if (ids.length) {
      const result = await call('Email/get', { ids, properties: ['id', 'messageId', 'from', 'to', 'replyTo', 'subject', 'receivedAt', 'textBody', 'htmlBody', 'bodyValues', 'attachments', 'mailboxIds', 'inReplyTo', 'header:Auto-Submitted:asText', 'header:Precedence:asText', 'header:List-Id:asText', 'header:Return-Path:asText', 'header:X-Auto-Response-Suppress:asText'], fetchTextBodyValues: true, fetchHTMLBodyValues: true, maxBodyValueBytes: 100000 });
      if (!Array.isArray(result.list)) throw new BadGatewayException('JMAP 메일 목록을 확인하지 못했습니다.');
      for (const email of result.list) {
        if (typeof email.id !== 'string' || !ids.includes(email.id)) throw new BadGatewayException('JMAP 메일 식별자가 요청과 다릅니다.');
        if (!email.mailboxIds?.[inbox]) continue;
        const parts = email.textBody?.length ? email.textBody : email.htmlBody || [];
        let body = parts.map((p: any) => email.bodyValues?.[p.partId]?.value || '').join('\n');
        const truncated = parts.some((p: any) => email.bodyValues?.[p.partId]?.isTruncated) || body.length > 100000;
        body = body.slice(0, 100000);
        if (!email.textBody?.length && body) body = (await simpleParser(Buffer.from(`Content-Type: text/html; charset=utf-8\r\n\r\n${body}`), { skipTextToHtml: true, skipImageLinks: true })).text || '';
        messages.push({ source_id: clean(email.id), message_id: email.messageId?.[0] ? `<${clean(email.messageId[0])}>` : '',
          from: clean(email.from?.[0]?.email), to: (email.to || []).slice(0, 100).map((a: any) => clean(a.email)), reply_to: clean(email.replyTo?.[0]?.email),
          subject: clean(email.subject), date: clean(email.receivedAt), text: body.slice(0, 100000), truncated,
          in_reply_to: email.inReplyTo?.[0] ? `<${clean(email.inReplyTo[0])}>` : '',
          auto_submitted: clean(email['header:Auto-Submitted:asText']), precedence: clean(email['header:Precedence:asText']),
          list_id: clean(email['header:List-Id:asText']), return_path: clean(email['header:Return-Path:asText']), auto_response_suppress: clean(email['header:X-Auto-Response-Suppress:asText']),
          attachments: (email.attachments || []).slice(0, 100).map((a: any) => ({ name: clean(a.name), type: clean(a.type), size: Number(a.size) || 0 })),
        });
      }
    }
    return { messages, cursor: { state, account_id: accountId }, has_more: more };
  },
  async send(context, content) {
    const { call } = await session(context);
    const identities = await call('Identity/get', {}, true);
    const identity = identities.list?.find((i: any) => i.email?.toLowerCase() === content.from.toLowerCase());
    if (!identity) throw new BadRequestException('이 발신 주소의 JMAP Identity를 찾을 수 없습니다.');
    const folders = await call('Mailbox/get', { properties: ['id', 'role'] });
    const draft = folders.list?.find((f: any) => f.role === 'drafts')?.id;
    const sent = folders.list?.find((f: any) => f.role === 'sent')?.id;
    if (!draft) throw new BadRequestException('JMAP 임시보관함을 찾을 수 없습니다.');
    const created = await call('Email/set', { create: { message: { mailboxIds: { [draft]: true }, keywords: { '$draft': true },
      from: [{ email: content.from }], to: content.to.map(email => ({ email })), subject: content.subject,
      messageId: [content.message_id.replace(/^<|>$/g, '')],
      ...(content.auto_submitted ? { 'header:Auto-Submitted:asText': content.auto_submitted, 'header:X-Auto-Response-Suppress:asText': 'All' } : {}),
      ...(content.in_reply_to ? { inReplyTo: [content.in_reply_to.replace(/^<|>$/g, '')] } : {}),
      textBody: [{ partId: 'body', type: 'text/plain' }], bodyValues: { body: { value: content.text } },
    } } });
    const emailId = created.created?.message?.id;
    if (!emailId) throw new BadGatewayException('JMAP 발신 메일을 생성하지 못했습니다.');
    const submitted = await call('EmailSubmission/set', { create: { send: { emailId, identityId: identity.id } },
      ...(sent ? { onSuccessUpdateEmail: { '#send': { mailboxIds: { [sent]: true }, keywords: {} } } } : {}),
    }, true);
    if (!submitted.created?.send?.id) throw new BadGatewayException('JMAP 발신 접수를 확인하지 못했습니다.');
  },
  async watch(context, onChange, signal) {
    const { info, accountId, origin } = await session(context);
    if (typeof info.eventSourceUrl !== 'string') throw new BadRequestException('JMAP EventSource가 없습니다.');
    const endpoint = info.eventSourceUrl.replaceAll('{types}', 'Email').replaceAll('{closeafter}', 'no').replaceAll('{ping}', '30');
    await mailEvents(mailUrl(endpoint, origin).toString(), context.secrets.jmap_token, signal, state => {
      if (state?.changed?.[accountId]?.Email) onChange();
    }, onChange);
  },
};
