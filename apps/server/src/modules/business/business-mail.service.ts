import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, LessThanOrEqual } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { BusinessMailConnection } from '../../entities/BusinessMailConnection';
import { BusinessMailMessage } from '../../entities/BusinessMailMessage';
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

const now = () => new Date().toISOString();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read = <T>(value: string): T => JSON.parse(decryptStrict(value));
const SAFE_ERROR = '메일 연결·인증·서비스 한도를 확인하세요. 기존 수집 기록은 유지됩니다.';
const UNCERTAIN = '발신 결과를 확정하지 못했습니다. 서버의 발신 기록을 확인하세요. 같은 요청은 다시 전송하지 않습니다.';

@Injectable()
export class BusinessMailService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  constructor(@InjectDataSource() private readonly ds: DataSource) {}
  onModuleInit() { this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 30_000); this.timer.unref(); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async connection(id: string, accountIds: string[]) {
    const row = accountIds.length ? await this.ds.getRepository(BusinessMailConnection).findOneBy({ id, account_id: In(accountIds) }) : null;
    if (!row) throw new NotFoundException('메일 연결을 찾을 수 없습니다.');
    return row;
  }
  private async credential(id: string, accountId: string) {
    const row = await this.ds.getRepository(Credential).findOneBy({ id, account_id: accountId, provider: 'mail', agent_env: false });
    if (!row) throw new BadRequestException('같은 소유 계정의 서버 전용 Mail credential을 선택하세요.');
    return read<Record<string, string>>(row.encrypted_data);
  }
  private async activeOwner(accountId: string) {
    const account = await this.ds.getRepository(Account).findOneBy({ id: accountId });
    const user = account?.owner_user_id ? await this.ds.getRepository(User).findOneBy({ id: account.owner_user_id, status: 'active' }) : null;
    if (!user || !hasPermission(user.role, JSON.parse(user.permissions || '[]'), PERMISSIONS.MANAGE_BUSINESS)) throw new UnauthorizedException('메일 소유자의 비즈니스 권한을 확인하세요.');
  }
  private publicConnection(row: BusinessMailConnection) {
    const { encrypted_data, lease_token, lease_until, ...safe } = row;
    return { ...safe, config: read<MailData>(encrypted_data).config, busy: lease_until > now() };
  }
  private publicMessage(row: BusinessMailMessage, full = false) {
    const { encrypted_data, source_key, address_keys, payload_digest, ...safe } = row;
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
    return this.ds.transaction(async manager => {
      const repo = manager.getRepository(BusinessMailConnection);
      let data: MailData = { config: input.config };
      if (previous) {
        if (previous.revision !== input.revision) throw new ConflictException('연결이 변경되었습니다. 새로고침하세요.');
        const old = read<MailData>(previous.encrypted_data);
        const { addresses: _old, ...oldServer } = old.config;
        const { addresses: _new, ...newServer } = input.config;
        if (input.provider !== previous.provider || digest(oldServer) !== digest(newServer)) throw new BadRequestException('메일 서버·로그인 변경은 새 연결로 등록하세요. 기존 메일의 출처를 보존합니다.');
        data = { ...old, config: input.config };
      }
      const patch = { account_id: accountId, company_id: input.company_id, name: input.name, provider: input.provider, purpose: input.purpose,
        credential_id: input.credential_id, encrypted_data: encrypt(JSON.stringify(data)), enabled: input.enabled, interval_minutes: input.interval_minutes,
        next_sync_at: now(), revision: (previous?.revision ?? -1) + 1 };
      if (previous) {
        const result = await repo.update({ id: previous.id, revision: input.revision, lease_until: LessThanOrEqual(now()) }, patch);
        if (result.affected !== 1) throw new ConflictException('연결을 사용 중이거나 변경되었습니다. 새로고침하세요.');
        return this.publicConnection({ ...previous, ...patch });
      }
      return this.publicConnection(await repo.save(repo.create(patch)));
    });
  }

  private async locked<T>(row: BusinessMailConnection, work: (data: MailData, context: MailContext) => Promise<T>): Promise<T> {
    if (!row.enabled) throw new ConflictException('중지된 메일 연결입니다.');
    await this.activeOwner(row.account_id);
    const secrets = await this.credential(row.credential_id, row.account_id);
    const lease = randomUUID(); const repo = this.ds.getRepository(BusinessMailConnection);
    const result = await repo.update({ id: row.id, revision: row.revision, lease_until: LessThanOrEqual(now()) },
      { lease_token: lease, lease_until: new Date(Date.now() + 10 * 60_000).toISOString(), revision: row.revision + 1 });
    if (result.affected !== 1) throw new ConflictException('다른 메일 작업이 진행 중입니다. 잠시 후 다시 확인하세요.');
    row.lease_token = lease;
    const data = read<MailData>(row.encrypted_data);
    try { return await work(data, { config: parseMail(mailConfigSchema, data.config), cursor: data.cursor || {}, secrets }); }
    finally { await repo.update({ id: row.id, lease_token: lease }, { lease_token: '', lease_until: '', revision: () => 'revision + 1' }); }
  }

  async sync(accountIds: string[], id: string) {
    const row = await this.connection(id, accountIds);
    return this.locked(row, async (data, context) => {
      try {
        const result = await mailConnector(row.provider).sync(context);
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
            await repo.insert({ account_id: row.account_id, connection_id: id, source_key: key, direction: 'inbound',
              encrypted_data: encrypt(JSON.stringify(message)), status: 'received',
              address_keys: '\n' + context.config.addresses.filter(a => message.to.some(to => to.toLowerCase() === a.toLowerCase())).map(a => a.toLowerCase()).join('\n') + '\n' });
            collected++;
          }
        });
        return { collected, has_more: !!result.has_more };
      } catch {
        await this.ds.getRepository(BusinessMailConnection).update({ id, lease_token: row.lease_token }, { status: 'error', last_error: SAFE_ERROR,
          next_sync_at: new Date(Date.now() + row.interval_minutes * 60_000).toISOString() });
        throw new BadRequestException(SAFE_ERROR);
      }
    });
  }

  async list(accountIds: string[], filters: unknown) {
    const input = parseMail(mailFiltersSchema, filters);
    if (!accountIds.length) return { messages: [], total: 0, offset: input.offset, limit: input.limit };
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
    const [rows, total] = await query.orderBy('m.created_at', 'DESC').addOrderBy('m.id', 'DESC').skip(input.offset).take(input.limit).getManyAndCount();
    return { messages: rows.map(r => this.publicMessage(r)), total, offset: input.offset, limit: input.limit };
  }
  private async message(accountIds: string[], id: string) {
    const row = accountIds.length ? await this.ds.getRepository(BusinessMailMessage).findOneBy({ id, account_id: In(accountIds) }) : null;
    if (!row) throw new NotFoundException('메일 기록을 찾을 수 없습니다.');
    return row;
  }
  async detail(accountIds: string[], id: string) { return this.publicMessage(await this.message(accountIds, id), true); }
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

  async send(accountIds: string[], id: string, body: unknown, actor: string) {
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
    let inReplyTo: string | undefined;
    if (input.reply_to_message_id) {
      const reply = await this.message(accountIds, input.reply_to_message_id);
      if (reply.connection_id !== id) throw new BadRequestException('답장할 메일과 같은 연결을 사용하세요.');
      const value = read<MailContent>(reply.encrypted_data).message_id;
      if (/^<[^<>\s]{1,990}>$/.test(value)) inReplyTo = value;
    }
    return this.locked(connection, async (_data, context) => {
      const content: MailContent = { source_id: input.request_id, message_id: `<awb-${input.request_id}@${input.from.split('@')[1]}>`,
        from: input.from, to: input.to, subject: input.subject, text: input.text, date: now(), attachments: [],
        ...(inReplyTo ? { in_reply_to: inReplyTo, references: [inReplyTo] } : {}) };
      const repo = this.ds.getRepository(BusinessMailMessage);
      // Durable claim BEFORE network I/O. An uncertain SMTP attempt is never automatically replayed.
      const row = await repo.save(repo.create({ account_id: connection.account_id, connection_id: id, source_key: sourceKey,
        direction: 'outbound', status: 'sending', address_keys: `\n${input.from.toLowerCase()}\n`, encrypted_data: encrypt(JSON.stringify(content)), payload_digest: payloadDigest, actor_id: actor }));
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

  async tick() {
    if (this.ticking) return;
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
