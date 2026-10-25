import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { BadRequestException } from '@nestjs/common';
import { resolveMailHost } from './mail-network';
import type { MailConnector, MailContent, MailContext } from './mail.types';

const MAX_SOURCE = 2_000_000;
const addresses = (items: any[] = []) => items.map(a => a.address).filter((s): s is string => typeof s === 'string').slice(0, 100);
const header = (value: unknown) => typeof value === 'string' ? value.replace(/[\r\n\x00]/g, '').slice(0, 1000) : '';

async function smtpTransport({ config, secrets }: MailContext) {
  if (!config.smtp || !secrets.smtp_password) throw new BadRequestException('SMTP 연결·비밀번호를 설정하세요.');
  const settings = config.smtp;
  const target = await resolveMailHost(settings.host);
  return nodemailer.createTransport({ host: target.address, port: settings.port,
    secure: settings.tls === 'implicit', requireTLS: true,
    tls: { servername: target.host, rejectUnauthorized: true },
    auth: { user: settings.username, pass: secrets.smtp_password },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false });
}

export const smtpImapConnector: MailConnector = {
  descriptor: { id: 'smtp_imap', name: 'SMTP · IMAP', credential_provider: 'mail', note: '비밀번호·앱 비밀번호로 연결합니다. 발신·수신 서버를 따로 지정할 수 있습니다. 최초 수집은 최근 20건, 이후 새 메일을 순서대로 수집합니다.' },
  async sync({ config, cursor, secrets }) {
    if (!config.imap) {
      const transport = await smtpTransport({ config, secrets, cursor });
      try { await transport.verify(); return { messages: [], cursor }; } finally { transport.close(); }
    }
    const settings = config.imap;
    if (!secrets.imap_password) throw new BadRequestException('IMAP 비밀번호를 등록하세요.');
    const target = await resolveMailHost(settings.host);
    const client = new ImapFlow({ host: target.address, servername: target.host, port: settings.port,
      secure: settings.tls === 'implicit', doSTARTTLS: settings.tls === 'starttls' ? true : undefined,
      auth: { user: settings.username, pass: secrets.imap_password }, logger: false,
      tls: { rejectUnauthorized: true, servername: target.host }, disableAutoIdle: true,
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000 });
    client.on('error', () => {});
    const deadline = setTimeout(() => client.close(), 120_000); deadline.unref();
    try {
      await client.connect();
      const mailbox = await client.mailboxOpen(settings.folder, { readOnly: true });
      const validity = String(mailbox.uidValidity);
      const previous = cursor.uid_validity === validity ? Number(cursor.last_uid || 0) : null;
      const end = mailbox.uidNext - 1;
      if (!mailbox.exists || (previous !== null && previous >= end)) return { messages: [], cursor: { uid_validity: validity, last_uid: end } };
      // A bounded UID window avoids unbounded SEARCH results on large mailboxes.
      const high = previous === null ? end : Math.min(end, previous + 100);
      const range = previous === null ? `${Math.max(1, mailbox.exists - 19)}:${mailbox.exists}` : `${previous + 1}:${high}`;
      const messages: MailContent[] = [];
      for await (const message of client.fetch(range, { uid: true, envelope: true, internalDate: true, size: true, source: { maxLength: MAX_SOURCE } }, { uid: previous !== null })) {
        const oversized = (message.size || 0) > MAX_SOURCE;
        const parsed = !oversized && message.source ? await simpleParser(message.source, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true }) : null;
        const env = message.envelope;
        const body = parsed?.text || '';
        messages.push({ source_id: `${validity}:${message.uid}`, message_id: header(parsed?.messageId || env?.messageId),
          from: addresses(env?.from)[0] || '', to: addresses(env?.to), reply_to: addresses(env?.replyTo)[0],
          subject: header(parsed?.subject || env?.subject), text: body.slice(0, 100000),
          date: (message.internalDate instanceof Date ? message.internalDate : new Date()).toISOString(),
          truncated: oversized || body.length > 100000,
          attachments: (parsed?.attachments || []).slice(0, 100).map(a => ({ name: header(a.filename || 'attachment'), type: header(a.contentType), size: a.size })),
          in_reply_to: header(parsed?.inReplyTo || env?.inReplyTo),
          auto_submitted: header(parsed?.headers.get('auto-submitted')) || (parsed?.headers.has('auto-submitted') ? 'unknown' : ''), precedence: header(parsed?.headers.get('precedence')),
          list_id: parsed?.headers.has('list-id') ? 'present' : '',
          return_path: parsed?.headerLines.find(h => h.key === 'return-path')?.line.slice('Return-Path:'.length).trim(),
          auto_response_suppress: header(parsed?.headers.get('x-auto-response-suppress')),
        });
      }
      return { messages, cursor: { uid_validity: validity, last_uid: high }, has_more: high < end, baseline: previous === null };
    } finally { clearTimeout(deadline); client.close(); }
  },
  async send({ config, secrets }, content) {
    const transport = await smtpTransport({ config, secrets, cursor: {} });
    try {
      const result = await transport.sendMail({ from: content.from, to: content.to, subject: content.subject, text: content.text,
        messageId: content.message_id, inReplyTo: content.in_reply_to, references: content.references,
        ...(content.auto_submitted ? { headers: { 'Auto-Submitted': content.auto_submitted, 'X-Auto-Response-Suppress': 'All' }, envelope: { from: '', to: content.to } } : {}),
        disableFileAccess: true, disableUrlAccess: true });
      if (result.rejected?.length || !result.accepted?.length) throw new Error('Recipients not all accepted');
    } finally { transport.close(); }
  },
  async watch({ config, secrets }, onChange, signal) {
    if (!config.imap) return;
    const settings = config.imap;
    const target = await resolveMailHost(settings.host);
    if (signal.aborted) return;
    const client = new ImapFlow({ host: target.address, servername: target.host, port: settings.port,
      secure: settings.tls === 'implicit', doSTARTTLS: settings.tls === 'starttls' ? true : undefined,
      auth: { user: settings.username, pass: secrets.imap_password }, logger: false,
      tls: { rejectUnauthorized: true, servername: target.host }, maxIdleTime: 60_000,
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 120_000 });
    const stop = () => client.close();
    signal.addEventListener('abort', stop, { once: true });
    let closed = false;
    const finished = new Promise<void>(resolve => client.once('close', () => { closed = true; resolve(); }));
    client.on('error', stop);
    client.on('exists', event => { if (event.count > event.prevCount) onChange(); });
    try {
      await client.connect();
      if (signal.aborted || closed) return;
      if (!client.capabilities.has('IDLE')) throw new Error('IMAP IDLE is not supported');
      await client.mailboxOpen(settings.folder, { readOnly: true });
      onChange(); // Catch mail received between the previous sync and opening IDLE.
      await finished;
    } finally { signal.removeEventListener('abort', stop); client.close(); }
  },
};
