import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, LessThanOrEqual } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { BusinessMailConnection } from '../../entities/BusinessMailConnection';
import { BusinessMailMessage } from '../../entities/BusinessMailMessage';
import { BusinessMailTask } from '../../entities/BusinessMailTask';
import { BusinessCompany } from '../../entities/BusinessCompany';
import { Credential } from '../../entities/Credential';
import { Account } from '../../entities/Account';
import { User } from '../../entities/User';
import { flushSqljs } from '../../db';
import { encrypt, decryptStrict } from '../../services/encryption.service';
import { hasPermission, PERMISSIONS } from '../../common/types/permissions';
import { MAIL_CONNECTORS, mailConnector } from './mail/mail-registry';
import { mailConfigSchema, mailConnectionSchema, mailConfirmSchema, mailFiltersSchema, mailSendSchema, parseMail, type MailContent, type MailData, type MailContext } from './mail/mail.types';
import { mailUrl } from './mail/mail-network';
import { activityEvents } from '../../services/activity.service';
import { automationFingerprint, mailAutomation, validateMailRuntime, type MailTaskData } from './mail/mail-automation';
import { assignMailThread, mailReferences } from './mail/mail-thread';

const now = () => new Date().toISOString();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read = <T>(value: string): T => JSON.parse(decryptStrict(value));
const SAFE_ERROR = '메일 연결·인증·서비스 한도를 확인하세요. 기존 수집 기록은 유지됩니다.';
const UNCERTAIN = '발신 결과를 확정하지 못했습니다. 서버의 발신 기록을 확인하세요. 같은 요청은 다시 전송하지 않습니다.';
const THREAD_PAGE = 50;
const THREAD_PREVIEW_ROWS = 20;
// Rows collected before conversation keys existed stay single-message conversations until the backfill reaches them.
const THREAD_EXPR = "COALESCE(NULLIF(m.thread_key, ''), 'id:' || CAST(m.id AS varchar))";

@Injectable()
export class BusinessMailService implements OnModuleInit, OnModuleDestroy {
  readonly watchStates = new Map<string, { mode: 'idle' | 'push' | 'polling'; error?: string }>();
  private timer?: ReturnType<typeof setInterval>;
  private backfillTimer?: ReturnType<typeof setTimeout>;
  private ticking = false;
  private backfilling?: Promise<number>;
  constructor(@InjectDataSource() private readonly ds: DataSource) {}
  onModuleInit() {
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 30_000); this.timer.unref();
    this.backfillTimer = setTimeout(() => { void this.backfillThreads().catch(() => {}); }, 1000); this.backfillTimer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); if (this.backfillTimer) clearTimeout(this.backfillTimer); }

  async connection(id: string, accountIds: string[]) {
    const row = accountIds.length ? await this.ds.getRepository(BusinessMailConnection).findOneBy({ id, account_id: In(accountIds) }) : null;
    if (!row) throw new NotFoundException('메일 연결을 찾을 수 없습니다.');
    return row;
  }
  private async credential(id: string, accountId: string) {
    const row = await this.ds.getRepository(Credential).findOneBy({ id, account_id: accountId, provider: 'mail', agent_env: false });
    if (!row) throw new BadRequestException('같은 소유 계정의 서버 전용 Mail credential을 선택하세요.');
    return read<Record<string, string>>(row.encrypted_data);
  }
  async activeOwner(accountId: string) {
    const account = await this.ds.getRepository(Account).findOneBy({ id: accountId });
    const user = account?.owner_user_id ? await this.ds.getRepository(User).findOneBy({ id: account.owner_user_id, status: 'active' }) : null;
    if (!user || !hasPermission(user.role, JSON.parse(user.permissions || '[]'), PERMISSIONS.MANAGE_BUSINESS)) throw new UnauthorizedException('메일 소유자의 비즈니스 권한을 확인하세요.');
    return user;
  }
  private publicConnection(row: BusinessMailConnection) {
    const { encrypted_data, lease_token, lease_until, ...safe } = row;
    const data = read<MailData>(encrypted_data);
    return { ...safe, config: data.config, notify_incoming: data.notify_incoming !== false, automation: mailAutomation(data),
      receiving: this.watchStates.get(row.id) || { mode: 'polling' }, busy: lease_until > now() };
  }
  private publicMessage(row: BusinessMailMessage, full = false) {
    const { encrypted_data, source_key, address_keys, payload_digest, message_key, thread_key, subject_key, ...safe } = row;
    const { text, ...content } = read<MailContent>(encrypted_data);
    // A dead process cannot safely retry SMTP. Viewing a stale attempt makes that ambiguity explicit.
    const stale = row.status === 'sending' && Date.now() - new Date(row.created_at).getTime() > 10 * 60_000;
    return { ...safe, ...(stale ? { status: 'uncertain' as const, last_error: UNCERTAIN } : {}),
      ...content, ...(full ? { text } : { preview: text.slice(0, 180) }) };
  }

  async connections(accountIds: string[]) {
    const [rows, credentials] = accountIds.length ? await Promise.all([
      this.ds.getRepository(BusinessMailConnection).find({ where: { account_id: In(accountIds) }, order: { created_at: 'ASC' } }),
      this.ds.getRepository(Credential).find({ where: { account_id: In(accountIds), provider: 'mail', agent_env: false }, select: ['id', 'name', 'account_id'] }),
    ]) : [[], []];
    return { connectors: MAIL_CONNECTORS.map(c => c.descriptor), connections: rows.map(r => this.publicConnection(r)), credentials };
  }

  async configure(accountIds: string[], body: unknown) {
    const input = parseMail(mailConnectionSchema, body);
    const previous = input.id ? await this.connection(input.id, accountIds) : null;
    const credential = accountIds.length ? await this.ds.getRepository(Credential).findOneBy({ id: input.credential_id, account_id: In(accountIds), provider: 'mail', agent_env: false }) : null;
    if (!credential || (previous && previous.account_id !== credential.account_id)) throw new BadRequestException('소유한 서버 전용 Mail credential을 선택하세요.');
    const accountId = credential.account_id!;
    if (input.company_id && !await this.ds.getRepository(BusinessCompany).existsBy({ id: input.company_id, account_id: accountId })) throw new BadRequestException('메일 연결과 같은 소유 계정의 회사를 선택하세요.');
    if (input.provider === 'jmap') {
      mailUrl(input.config.jmap_url || '');
      if (input.config.smtp || input.config.imap) throw new BadRequestException('JMAP 연결에는 Session URL을 사용하세요.');
    } else if ((!input.config.smtp && !input.config.imap) || input.config.jmap_url) throw new BadRequestException('SMTP 또는 IMAP 서버를 설정하세요.');
    const secrets = await this.credential(input.credential_id, accountId);
    const required = input.provider === 'jmap' ? ['jmap_token'] : [...(input.config.smtp ? ['smtp_password'] : []), ...(input.config.imap ? ['imap_password'] : [])];
    if (required.some(k => typeof secrets[k] !== 'string' || !secrets[k])) throw new BadRequestException('메일 credential의 필수 비밀번호·토큰을 등록하세요.');
    const automation = input.automation || mailAutomation(previous ? read<MailData>(previous.encrypted_data) : { config: input.config });
    if (automation.mode !== 'off') {
      if (!automation.objective) throw new BadRequestException('자동 답장 업무 목적을 입력하세요.');
      automation.agent_runtime = { ...await validateMailRuntime(this.ds, automation.agent_runtime, accountId) };
      if (input.provider === 'smtp_imap' && (!input.config.smtp || !input.config.imap)) throw new BadRequestException('답장 자동화에는 SMTP와 IMAP이 모두 필요합니다.');
      automation.from ||= input.config.addresses[0];
      if (!input.config.addresses.some(a => a.toLowerCase() === automation.from!.toLowerCase())) throw new BadRequestException('등록된 자동 답장 발신 주소를 선택하세요.');
    }
    return this.ds.transaction(async manager => {
      const repo = manager.getRepository(BusinessMailConnection);
      let current = previous;
      let data: MailData = { config: input.config };
      if (previous) {
        if (previous.revision !== input.revision) throw new ConflictException('연결이 변경되었습니다. 새로고침하세요.');
        // Reserve the settings revision before reading the cursor. A sync may
        // have completed while credentials/runtime were being validated.
        const reserved = await repo.update({ id: previous.id, revision: input.revision, lease_until: LessThanOrEqual(now()) }, { revision: previous.revision + 1 });
        if (reserved.affected !== 1) throw new ConflictException('연결을 사용 중이거나 변경되었습니다. 잠시 후 다시 저장하세요.');
        current = await repo.findOneByOrFail({ id: previous.id });
        const old = read<MailData>(current.encrypted_data);
        const { addresses: _old, ...oldServer } = old.config;
        const { addresses: _new, ...newServer } = input.config;
        if (input.provider !== previous.provider || digest(oldServer) !== digest(newServer)) throw new BadRequestException('메일 서버·로그인 변경은 새 연결로 등록하세요. 기존 메일의 출처를 보존합니다.');
        data = { ...old, config: input.config };
      }
      data.automation = automation;
      data.notify_incoming = input.notify_incoming ?? data.notify_incoming ?? true;
      const patch = { account_id: accountId, company_id: input.company_id, name: input.name, provider: input.provider, purpose: input.purpose,
        credential_id: input.credential_id, encrypted_data: encrypt(JSON.stringify(data)), enabled: input.enabled, interval_minutes: input.interval_minutes,
        next_sync_at: now(), lease_token: '', lease_until: '', revision: (previous?.revision ?? -1) + 1 };
      if (previous) {
        await repo.update({ id: previous.id }, patch);
        if (!input.enabled || automationFingerprint(read<MailData>(current!.encrypted_data)) !== automationFingerprint(data)) {
          await manager.getRepository(BusinessMailTask).update({ connection_id: previous.id, status: In(['queued', 'drafting', 'review']) }, {
            status: 'cancelled', last_error: '연결 또는 자동화 설정이 변경되어 이전 답장 작업을 취소했습니다.', review_notification_state: 'none', revision: () => 'revision + 1',
          });
        }
        return this.publicConnection({ ...current!, ...patch });
      }
      return this.publicConnection(await repo.save(repo.create(patch)));
    });
  }

  async locked<T>(row: BusinessMailConnection, work: (data: MailData, context: MailContext) => Promise<T>): Promise<T> {
    if (!row.enabled) throw new ConflictException('중지된 메일 연결입니다.');
    await this.activeOwner(row.account_id);
    const secrets = await this.credential(row.credential_id, row.account_id);
    const lease = randomUUID(); const repo = this.ds.getRepository(BusinessMailConnection);
    // Background work uses a fenced lease, not the user-facing settings revision.
    const result = await repo.update({ id: row.id, revision: row.revision, lease_until: LessThanOrEqual(now()) },
      { lease_token: lease, lease_until: new Date(Date.now() + 10 * 60_000).toISOString() });
    if (result.affected !== 1) throw new ConflictException('다른 메일 작업이 진행 중입니다. 잠시 후 다시 확인하세요.');
    try {
      // Another worker may have advanced the cursor since this row was loaded.
      Object.assign(row, await repo.findOneByOrFail({ id: row.id, lease_token: lease }));
      const data = read<MailData>(row.encrypted_data);
      return await work(data, { config: parseMail(mailConfigSchema, data.config), cursor: data.cursor || {}, secrets });
    } finally { await repo.update({ id: row.id, lease_token: lease }, { lease_token: '', lease_until: '' }); }
  }

  /** Every connected address of the Account: conversation matching compares the other parties only. */
  private async ownAddresses(accountId: string, manager: EntityManager = this.ds.manager) {
    const rows = await manager.getRepository(BusinessMailConnection).find({ where: { account_id: accountId }, select: ['id', 'encrypted_data'] });
    // An unreadable connection only loses its addresses here; it must not stop collecting or grouping other mail.
    return new Set(rows.flatMap(r => { try { return read<MailData>(r.encrypted_data).config.addresses.map(a => a.toLowerCase()); } catch { return []; } }));
  }

  async watchContext(row: BusinessMailConnection): Promise<MailContext> {
    await this.activeOwner(row.account_id);
    const data = read<MailData>(row.encrypted_data);
    return { config: parseMail(mailConfigSchema, data.config), cursor: data.cursor || {}, secrets: await this.credential(row.credential_id, row.account_id) };
  }

  async sync(accountIds: string[], id: string) {
    const row = await this.connection(id, accountIds);
    return this.locked(row, async (data, context) => {
      try {
        const result = await mailConnector(row.provider).sync(context);
        const own = await this.ownAddresses(row.account_id);
        let collected = 0;
        await this.ds.transaction(async manager => {
          // The cursor and every collected record commit together, with a fenced connection lease.
          const saved = await manager.getRepository(BusinessMailConnection).update({ id, lease_token: row.lease_token }, {
            encrypted_data: encrypt(JSON.stringify({ ...data, cursor: result.cursor })), synced_at: now(), status: 'connected', last_error: '',
            next_sync_at: new Date(Date.now() + (result.has_more ? 30_000 : row.interval_minutes * 60_000)).toISOString(),
          });
          if (saved.affected !== 1) throw new ConflictException('메일 수집 작업이 만료되었습니다.');
          const repo = manager.getRepository(BusinessMailMessage);
          for (const message of result.messages) {
            const key = `in:${digest(message.source_id)}`;
            if (await repo.existsBy({ connection_id: id, source_key: key })) continue;
            const messageId = randomUUID();
            const thread = await assignMailThread(manager, { accountId: row.account_id, rowId: messageId, content: message, own, at: new Date() });
            await repo.insert({ id: messageId, account_id: row.account_id, connection_id: id, source_key: key, direction: 'inbound',
              encrypted_data: encrypt(JSON.stringify(message)), status: 'received', ...thread,
              address_keys: '\n' + context.config.addresses.filter(a => message.to.some(to => to.toLowerCase() === a.toLowerCase())).map(a => a.toLowerCase()).join('\n') + '\n' });
            // A first import (or UIDVALIDITY reset) is history, not a fresh arrival.
            if (data.cursor && Object.keys(data.cursor).length && !result.baseline) {
              const automation = mailAutomation(data);
              const taskData: MailTaskData = { automation, fingerprint: automationFingerprint(data), from: automation.from || data.config.addresses[0],
                to: message.reply_to || message.from, subject: /^re:/i.test(message.subject) ? message.subject.slice(0, 500) : `Re: ${message.subject || '(제목 없음)'}`.slice(0, 500), text: '', note: '' };
              await manager.getRepository(BusinessMailTask).insert({ account_id: row.account_id, connection_id: id, message_id: messageId,
                status: automation.mode === 'off' ? 'skipped' : 'queued', notification_state: data.notify_incoming === false ? 'disabled' : 'pending',
                encrypted_data: encrypt(JSON.stringify(taskData)) });
            }
            collected++;
          }
        });
        await flushSqljs(this.ds, true);
        if (collected) activityEvents.emit('business_mail_intake', { account_id: row.account_id, connection_id: id });
        return { collected, has_more: !!result.has_more };
      } catch {
        await this.ds.getRepository(BusinessMailConnection).update({ id, lease_token: row.lease_token }, { status: 'error', last_error: SAFE_ERROR,
          next_sync_at: new Date(Date.now() + row.interval_minutes * 60_000).toISOString() });
        throw new BadRequestException(SAFE_ERROR);
      }
    });
  }

  private filtered(accountIds: string[], input: ReturnType<typeof mailFiltersSchema.parse>) {
    const query = this.ds.getRepository(BusinessMailMessage).createQueryBuilder('m')
      // PostgreSQL stores generated IDs as uuid, but plain references as varchar.
      .innerJoin(BusinessMailConnection, 'c', 'CAST(c.id AS varchar) = m.connection_id AND c.account_id = m.account_id')
      .where('m.account_id IN (:...accounts)', { accounts: accountIds });
    if (input.company_id) query.andWhere('c.company_id = :company', { company: input.company_id });
    if (input.connection_id) query.andWhere('c.id = :connection', { connection: input.connection_id });
    if (input.purpose) query.andWhere('c.purpose = :purpose', { purpose: input.purpose });
    if (input.direction) query.andWhere('m.direction = :direction', { direction: input.direction });
    const staleAt = new Date(Date.now() - 10 * 60_000);
    if (input.status === 'uncertain') query.andWhere('(m.status = :uncertain OR (m.status = :sending AND m.created_at < :staleAt))', { uncertain: 'uncertain', sending: 'sending', staleAt });
    else if (input.status === 'sending') query.andWhere('m.status = :sending AND m.created_at >= :staleAt', { sending: 'sending', staleAt });
    else if (input.status) query.andWhere('m.status = :status', { status: input.status });
    if (input.address) query.andWhere("m.address_keys LIKE :address ESCAPE '!'", { address: `%\n${input.address.toLowerCase().replace(/[!%_]/g, c => '!' + c)}\n%` });
    if (input.confirmation) query.andWhere('m.confirmed = :confirmed', { confirmed: input.confirmation === 'confirmed' });
    if (input.reply_status) query.andWhere('EXISTS (SELECT 1 FROM business_mail_tasks t WHERE t.message_id = CAST(m.id AS varchar) AND t.account_id = m.account_id AND t.status = :replyStatus)', { replyStatus: input.reply_status });
    return query;
  }
  private async replyTasks(accountIds: string[], ids: string[]): Promise<BusinessMailTask[]> {
    return ids.length ? this.ds.getRepository(BusinessMailTask).find({ where: { message_id: In(ids), account_id: In(accountIds) }, select: ['id', 'message_id', 'status'] }) : [];
  }

  async list(accountIds: string[], filters: unknown) {
    const input = parseMail(mailFiltersSchema, filters);
    if (input.view === 'threads') return this.threads(accountIds, input);
    if (!accountIds.length) return { messages: [], total: 0, offset: input.offset, limit: input.limit };
    const [rows, total] = await this.filtered(accountIds, input).orderBy('m.created_at', 'DESC').addOrderBy('m.id', 'DESC').skip(input.offset).take(input.limit).getManyAndCount();
    const tasks = await this.replyTasks(accountIds, rows.map(r => r.id));
    return { messages: rows.map(r => ({ ...this.publicMessage(r), reply: tasks.find(t => t.message_id === r.id) || null })), total, offset: input.offset, limit: input.limit };
  }

  /**
   * Conversations, newest activity first. A conversation is listed when any of its mail matches the filters,
   * and its summary covers all of its mail (like a mail client's conversation view).
   */
  private async threads(accountIds: string[], input: ReturnType<typeof mailFiltersSchema.parse>) {
    const empty = { view: 'threads' as const, threads: [], total: 0, offset: input.offset, limit: input.limit };
    if (!accountIds.length) return empty;
    const grouped = this.filtered(accountIds, input).select(THREAD_EXPR, 'thread').addSelect('m.account_id', 'account')
      .addSelect('MAX(m.created_at)', 'last_at').groupBy(THREAD_EXPR).addGroupBy('m.account_id');
    const [countSql, countParams] = grouped.getQueryAndParameters();
    const total = Number((await this.ds.query(`SELECT COUNT(*) AS n FROM (${countSql}) g`, countParams))[0]?.n || 0);
    const page: Array<{ thread: string; account: string }> = await grouped.orderBy('last_at', 'DESC').addOrderBy('thread', 'DESC')
      .offset(input.offset).limit(Math.min(input.limit, THREAD_PAGE)).getRawMany();
    if (!page.length) return { ...empty, total };
    const keys = page.filter(p => !p.thread.startsWith('id:')).map(p => p.thread);
    const singles = page.filter(p => p.thread.startsWith('id:')).map(p => p.thread.slice(3));
    const repo = this.ds.getRepository(BusinessMailMessage);
    const heads = await repo.createQueryBuilder('m')
      .select(['m.id', 'm.account_id', 'm.connection_id', 'm.thread_key', 'm.direction', 'm.status', 'm.confirmed', 'm.created_at'])
      .where('m.account_id IN (:...accounts)', { accounts: [...new Set(page.map(p => p.account))].filter(a => accountIds.includes(a)) })
      .andWhere(keys.length && singles.length ? '(m.thread_key IN (:...keys) OR m.id IN (:...singles))' : keys.length ? 'm.thread_key IN (:...keys)' : 'm.id IN (:...singles)', { keys, singles })
      .orderBy('m.created_at', 'DESC').addOrderBy('m.id', 'DESC').getMany();
    const byThread = new Map<string, BusinessMailMessage[]>();
    for (const head of heads) {
      const thread = `${head.account_id}\n${head.thread_key || `id:${head.id}`}`;
      byThread.set(thread, [...(byThread.get(thread) || []), head]);
    }
    const shown = [...byThread.values()].flatMap(rows => rows.slice(0, THREAD_PREVIEW_ROWS).map(r => r.id));
    const [bodies, tasks] = await Promise.all([
      repo.find({ where: { id: In(shown), account_id: In(accountIds) } }),
      this.replyTasks(accountIds, heads.map(h => h.id)),
    ]);
    const content = new Map(bodies.map(row => [row.id, this.publicMessage(row)]));
    const threads = page.map(p => {
      const rows = byThread.get(`${p.account}\n${p.thread}`) || [];
      const messages = rows.map(r => content.get(r.id)).filter(<T>(m: T | undefined): m is T => !!m);
      const latest = messages[0]; const first = messages[messages.length - 1];
      const replies = tasks.filter(t => rows.some(r => r.id === t.message_id));
      return {
        id: p.thread, latest_id: rows[0]?.id || '', subject: first?.subject || latest?.subject || '', preview: latest && 'preview' in latest ? latest.preview : '',
        last_at: latest?.date || (rows[0]?.created_at ? new Date(rows[0].created_at).toISOString() : ''),
        count: rows.length, unconfirmed: rows.filter(r => r.direction === 'inbound' && !r.confirmed).length,
        inbound: rows.filter(r => r.direction === 'inbound').length, outbound: rows.filter(r => r.direction === 'outbound').length,
        // Senders oldest first, like a mail client's conversation row.
        senders: [...new Set([...messages].reverse().map(m => m.from).filter(Boolean))],
        connection_ids: [...new Set(rows.map(r => r.connection_id))],
        attachments: messages.reduce((n, m) => n + (m.attachments?.length || 0), 0),
        statuses: [...new Set(messages.filter(m => m.direction === 'outbound' && m.status !== 'accepted').map(m => m.status))],
        replies: [...new Set(replies.map(t => t.status))],
      };
    });
    return { ...empty, threads, total };
  }
  private async message(accountIds: string[], id: string) {
    const row = accountIds.length ? await this.ds.getRepository(BusinessMailMessage).findOneBy({ id, account_id: In(accountIds) }) : null;
    if (!row) throw new NotFoundException('메일 기록을 찾을 수 없습니다.');
    return row;
  }
  async detail(accountIds: string[], id: string) { return this.publicMessage(await this.message(accountIds, id), true); }
  /** The message plus its conversation, oldest first: the latest 50 mails with text and reply status. */
  async detailWithThread(accountIds: string[], id: string) {
    const row = await this.message(accountIds, id);
    const repo = this.ds.getRepository(BusinessMailMessage);
    const where = row.thread_key ? { account_id: row.account_id, thread_key: row.thread_key } : { id: row.id, account_id: row.account_id };
    const [rows, total] = await repo.findAndCount({ where, order: { created_at: 'DESC', id: 'DESC' }, take: THREAD_PAGE });
    if (!rows.some(r => r.id === row.id)) rows.push(row);
    const tasks = await this.replyTasks([row.account_id], rows.map(r => r.id));
    const time = (m: { date: string; created_at: Date }) => Date.parse(m.date) || new Date(m.created_at).getTime();
    const messages = rows.map(r => ({ ...this.publicMessage(r, true), reply: tasks.find(t => t.message_id === r.id) || null }))
      .sort((a, b) => time(a) - time(b) || new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    return { ...this.publicMessage(row, true), thread: { id: row.thread_key || `id:${row.id}`, total, messages } };
  }
  async confirm(accountIds: string[], id: string, body: unknown, actor: string) {
    const input = parseMail(mailConfirmSchema, body); const row = await this.message(accountIds, id);
    const content = read<MailContent>(row.encrypted_data);
    const result = await this.ds.getRepository(BusinessMailMessage).update({ id, account_id: row.account_id, revision: input.revision }, {
      confirmed: input.confirmed, confirmed_by: input.confirmed ? actor : '', confirmed_at: input.confirmed ? now() : '', revision: input.revision + 1,
      encrypted_data: encrypt(JSON.stringify({ ...content, note: input.note })),
    });
    if (result.affected !== 1) throw new ConflictException('메일 처리 상태가 변경되었습니다. 다시 불러오세요.');
    return this.detail(accountIds, id);
  }

  async send(accountIds: string[], id: string, body: unknown, actor: string, automated?: { taskId: string; fingerprint: string }) {
    const input = parseMail(mailSendSchema, body); const connection = await this.connection(id, accountIds);
    const payloadDigest = digest(input); const sourceKey = `out:${input.request_id}`;
    const existing = await this.ds.getRepository(BusinessMailMessage).findOneBy({ connection_id: id, source_key: sourceKey });
    if (existing) {
      if (existing.payload_digest !== payloadDigest) throw new ConflictException('같은 요청 ID의 수신자·본문을 바꿀 수 없습니다.');
      return this.publicMessage(existing, true);
    }
    const config = read<MailData>(connection.encrypted_data).config;
    if (!config.addresses.some(a => a.toLowerCase() === input.from.toLowerCase())) throw new BadRequestException('이 연결에 등록한 발신 주소를 선택하세요.');
    if (connection.provider === 'smtp_imap' && !config.smtp) throw new BadRequestException('수신 전용 연결입니다.');
    if (input.reply_to_message_id && input.forward_message_id) throw new BadRequestException('답장과 전달 중 하나만 선택하세요.');
    let inReplyTo: string | undefined; let references: string[] = []; let parent: BusinessMailMessage | undefined;
    if (input.reply_to_message_id || input.forward_message_id) {
      parent = await this.message(accountIds, (input.reply_to_message_id || input.forward_message_id)!);
      if (parent.connection_id !== id) throw new BadRequestException(input.reply_to_message_id ? '답장할 메일과 같은 연결을 사용하세요.' : '전달할 메일과 같은 연결을 사용하세요.');
      const original = read<MailContent>(parent.encrypted_data);
      // A forward stays in the conversation (References) but is not a reply (no In-Reply-To).
      if (input.reply_to_message_id && /^<[^<>\s]{1,990}>$/.test(original.message_id)) inReplyTo = original.message_id;
      references = mailReferences(original);
    }
    return this.locked(connection, async (data, context) => {
      if (automated) {
        if (automationFingerprint(data) !== automated.fingerprint || mailAutomation(data).mode === 'off') throw new ConflictException('자동화 설정이 변경되어 발송을 중단했습니다.');
        const task = await this.ds.getRepository(BusinessMailTask).findOneBy({ id: automated.taskId, account_id: connection.account_id, connection_id: id, status: 'sending' });
        if (!task || task.id !== input.request_id || task.message_id !== input.reply_to_message_id) throw new ConflictException('답장 발송 상태를 확인하세요.');
        const draft = read<MailTaskData>(task.encrypted_data);
        if (draft.from !== input.from || input.to.length !== 1 || draft.to !== input.to[0] || draft.subject !== input.subject || draft.text !== input.text) throw new ConflictException('승인한 답장이 변경되었습니다.');
        await validateMailRuntime(this.ds, draft.automation.agent_runtime, connection.account_id);
      }
      const content: MailContent = { source_id: input.request_id, message_id: `<awb-${input.request_id}@${input.from.split('@')[1]}>`,
        from: input.from, to: input.to, subject: input.subject, text: input.text, date: now(), attachments: [],
        ...(automated ? { auto_submitted: 'auto-replied' } : {}),
        ...(inReplyTo ? { in_reply_to: inReplyTo } : {}), ...(references.length ? { references } : {}) };
      const own = await this.ownAddresses(connection.account_id);
      // Durable claim BEFORE network I/O. An uncertain SMTP attempt is never automatically replayed.
      const row = await this.ds.transaction(async manager => {
        const repo = manager.getRepository(BusinessMailMessage); const rowId = randomUUID();
        const thread = await assignMailThread(manager, { accountId: connection.account_id, rowId, content, own, at: new Date(), parentThread: parent?.thread_key });
        return repo.save(repo.create({ id: rowId, account_id: connection.account_id, connection_id: id, source_key: sourceKey, ...thread,
          direction: 'outbound', status: 'sending', address_keys: `\n${input.from.toLowerCase()}\n`, encrypted_data: encrypt(JSON.stringify(content)), payload_digest: payloadDigest, actor_id: actor }));
      });
      const repo = this.ds.getRepository(BusinessMailMessage);
      if (!automated && input.reply_to_message_id) {
        // Someone answered this mail directly; a pending agent draft would become a second reply.
        await this.ds.getRepository(BusinessMailTask).update({ account_id: connection.account_id, message_id: input.reply_to_message_id, status: In(['queued', 'drafting', 'review']) }, {
          status: 'cancelled', last_error: '직접 보낸 답장이 있어 자동 답장 작업을 취소했습니다.', review_notification_state: 'none', revision: () => 'revision + 1',
        });
      }
      try {
        await flushSqljs(this.ds, true);
        await mailConnector(connection.provider).send(context, content);
        await repo.update({ id: row.id, status: 'sending' }, { status: 'accepted', revision: () => 'revision + 1' });
      } catch {
        await repo.update({ id: row.id, status: 'sending' }, { status: 'uncertain', last_error: UNCERTAIN, revision: () => 'revision + 1' });
      }
      return this.detail(accountIds, row.id);
    });
  }

  /**
   * Conversation keys for mail collected before they existed or imported from another instance (import clears
   * them), oldest first so parents are keyed before replies. Runs on every collection tick; `thread_key` leads an index.
   */
  backfillThreads(): Promise<number> {
    this.backfilling ||= (async () => {
      const repo = this.ds.getRepository(BusinessMailMessage); const own = new Map<string, Set<string>>(); let done = 0;
      try {
        for (;;) {
          const rows = await repo.find({ where: { thread_key: '' }, order: { created_at: 'ASC', id: 'ASC' }, take: 100 });
          if (!rows.length) return done;
          for (const row of rows) {
            if (!own.has(row.account_id)) own.set(row.account_id, await this.ownAddresses(row.account_id));
            let content: MailContent | null = null;
            try { content = read<MailContent>(row.encrypted_data); } catch { /* unreadable rows stay single-mail conversations */ }
            const keys = content ? await assignMailThread(this.ds.manager, { accountId: row.account_id, rowId: row.id, content, own: own.get(row.account_id)!, at: new Date(row.created_at) })
              : { message_key: '', subject_key: '', thread_key: `id:${row.id}` };
            await repo.update({ id: row.id, thread_key: '' }, keys);
            done++;
          }
        }
      } finally { this.backfilling = undefined; }
    })();
    return this.backfilling;
  }

  async tick() {
    if (this.ticking) return;
    void this.backfillThreads().catch(() => {});
    this.ticking = true;
    try {
      const rows = await this.ds.getRepository(BusinessMailConnection).find({ where: { enabled: true, next_sync_at: LessThanOrEqual(now()), lease_until: LessThanOrEqual(now()) }, order: { next_sync_at: 'ASC' }, take: 10 });
      for (const row of rows) {
        try { await this.sync([row.account_id], row.id); }
        catch {
          // Pre-lease failures (revoked owner/key) also need backoff; otherwise they starve later rows.
          await this.ds.getRepository(BusinessMailConnection).update({ id: row.id, revision: row.revision, lease_until: LessThanOrEqual(now()) }, {
            status: 'error', last_error: SAFE_ERROR, next_sync_at: new Date(Date.now() + row.interval_minutes * 60_000).toISOString(),
          });
        }
      }
    } finally { this.ticking = false; }
  }
}
