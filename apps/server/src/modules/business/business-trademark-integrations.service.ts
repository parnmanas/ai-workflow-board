import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, LessThanOrEqual } from 'typeorm';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { BusinessCompany } from '../../entities/BusinessCompany';
import { BusinessTrademark } from '../../entities/BusinessTrademark';
import { BusinessTrademarkIntegration } from '../../entities/BusinessTrademarkIntegration';
import { BusinessTrademarkRecord } from '../../entities/BusinessTrademarkRecord';
import { BusinessTrademarkAction } from '../../entities/BusinessTrademarkAction';
import { BusinessEvent } from '../../entities/BusinessEvent';
import { Account } from '../../entities/Account';
import { User } from '../../entities/User';
import { Credential } from '../../entities/Credential';
import { hasPermission, PERMISSIONS } from '../../common/types/permissions';
import { verifySvixSignature } from '../../common/marketing/email-events';
import { encrypt, decryptStrict } from '../../services/encryption.service';
import { BusinessService } from './business.service';
import { parseTrademark, type TrademarkDetails } from './trademark.types';
import { TRADEMARK_CONNECTORS, trademarkConnector } from './connectors/trademark-registry';
import { digest, trademarkRequest } from './connectors/trademark-http';
import type { IntegrationData, OAuthTokens, PreparedTrademarkAction, TrademarkConnectorContext, TrademarkSourceRecord } from './connectors/trademark-connector';
import { trademarkReplyAddress } from './connectors/trademark-resend';
import { oauthCallbackBase } from '../../common/public-url';

const OPEN_ACTIONS = ['draft', 'sending', 'uncertain'];
const approval = z.object({ confirm: z.literal(true), payload_digest: z.string().length(64), revision: z.number().int().nonnegative(), external_id: z.string().max(500).optional() });
const readData = <T>(encrypted: string): T => JSON.parse(decryptStrict(encrypted));
const nowIso = () => new Date().toISOString();
const SAFE_ERROR = '연동에 실패했습니다. 저장된 데이터는 유지됩니다. 로그인·API 권한·연결 설정·서비스 한도를 확인하고 다시 시도하세요.';

export const TRADEMARK_CALLBACK_PATH = '/api/business-integrations/oauth/callback';

@Injectable()
export class BusinessTrademarkIntegrationsService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly business: BusinessService) {}
  onModuleInit() { this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 30_000); this.timer.unref(); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async owned(companyId: string, accountId: string, trademarkId: string) {
    await this.business.company(companyId, accountId);
    const row = await this.ds.getRepository(BusinessTrademark).findOneBy({ id: trademarkId, company_id: companyId, account_id: accountId });
    if (!row) throw new NotFoundException('상표 기록을 찾을 수 없습니다.');
    return row;
  }
  private async connection(companyId: string, accountId: string, trademarkId: string, id: string) {
    await this.owned(companyId, accountId, trademarkId);
    const row = await this.ds.getRepository(BusinessTrademarkIntegration).findOneBy({ id, company_id: companyId, account_id: accountId, trademark_id: trademarkId });
    if (!row) throw new NotFoundException('연결을 찾을 수 없습니다.');
    return row;
  }
  private async credential(credentialId: string, provider: string, accountId: string) {
    const adapter = trademarkConnector(provider);
    const row = await this.ds.getRepository(Credential).findOneBy({ id: credentialId, account_id: accountId, provider: adapter.descriptor.credential_provider, agent_env: false });
    if (!row) throw new BadRequestException('같은 소유 계정의 서버 전용 credential을 선택하세요.');
    const secrets = readData<Record<string, string>>(row.encrypted_data);
    const required = adapter.oauth ? ['client_id', 'client_secret'] : ['api_key'];
    if (required.some(key => typeof secrets[key] !== 'string' || !secrets[key].trim() || /[\r\n]/.test(secrets[key]))) throw new BadRequestException('연결 키의 필수 값을 확인하세요.');
    const fingerprint = digest(JSON.stringify(Object.keys(secrets).sort().map(key => [key, secrets[key]])));
    return { secrets, fingerprint };
  }
  private publicConnection(row: BusinessTrademarkIntegration) {
    const data = readData<IntegrationData>(row.encrypted_data);
    let base = ''; try { base = oauthCallbackBase(); } catch { /* API-key reads work without a public callback origin. */ }
    const descriptor = trademarkConnector(row.provider).descriptor;
    return { id: row.id, provider: row.provider, credential_id: row.credential_id, config: data.config, identity: data.identity || null,
      status: row.status, ready: row.status !== 'disconnected' && (descriptor.auth === 'api_key' || !!data.tokens), auto_sync: row.auto_sync, interval_minutes: row.interval_minutes,
      synced_at: row.synced_at, next_sync_at: row.next_sync_at, last_error: row.last_error, revision: row.revision, summary: data.summary || '',
      callback_url: `${base}${TRADEMARK_CALLBACK_PATH}`, webhook_url: descriptor.webhook ? `${base}/api/business-integrations/webhooks/${row.id}` : '',
      reply_address: row.provider === 'resend_inbound' && row.status !== 'disconnected' ? trademarkReplyAddress({ id: row.id, data }) : '', public_url_configured: !!base };
  }
  private publicAction(row: BusinessTrademarkAction, includeReview = false) {
    const data = readData<PreparedTrademarkAction>(row.encrypted_data);
    return { id: row.id, integration_id: row.integration_id, kind: row.kind, status: row.status, external_id: row.external_id, external_status: row.external_status,
      payload_digest: row.payload_digest, revision: row.revision, attempted_at: row.attempted_at, last_error: row.last_error, created_at: row.created_at,
      title: data.review.subject, ...(includeReview ? { review: data.review } : {}) };
  }
  async list(companyId: string, accountId: string, trademarkId: string) {
    await this.owned(companyId, accountId, trademarkId);
    const where = { company_id: companyId, account_id: accountId, trademark_id: trademarkId };
    const [connections, records, recent, pending] = await Promise.all([
      this.ds.getRepository(BusinessTrademarkIntegration).find({ where, order: { created_at: 'ASC' } }),
      this.ds.getRepository(BusinessTrademarkRecord).find({ where, order: { updated_at: 'DESC', id: 'DESC' }, take: 150 }),
      this.ds.getRepository(BusinessTrademarkAction).find({ where, order: { created_at: 'DESC' }, take: 50 }),
      this.ds.getRepository(BusinessTrademarkAction).find({ where: { ...where, status: In(OPEN_ACTIONS) } }),
    ]);
    return { connectors: TRADEMARK_CONNECTORS.map(c => c.descriptor), connections: connections.map(row => this.publicConnection(row)),
      records: records.map(row => ({ id: row.id, integration_id: row.integration_id, ...readData<TrademarkSourceRecord>(row.encrypted_data) })),
      actions: [...new Map([...pending, ...recent].map(row => [row.id, row])).values()].map(row => this.publicAction(row)) };
  }
  async configure(companyId: string, accountId: string, trademarkId: string, body: unknown, actor: string) {
    await this.owned(companyId, accountId, trademarkId);
    const input = parseTrademark(z.object({ provider: z.string(), credential_id: z.string().uuid(), config: z.record(z.string(), z.string()), auto_sync: z.boolean(), interval_minutes: z.union([z.literal(5), z.literal(15), z.literal(60)]), revision: z.number().int().nonnegative().optional() }), body);
    const adapter = trademarkConnector(input.provider); const config = adapter.config(input.config);
    const { fingerprint } = await this.credential(input.credential_id, input.provider, accountId);
    return this.ds.transaction(async manager => {
      await manager.getRepository(BusinessCompany).increment({ id: companyId, account_id: accountId }, 'revision', 1);
      const repo = manager.getRepository(BusinessTrademarkIntegration);
      let row = await repo.findOneBy({ account_id: accountId, trademark_id: trademarkId, provider: input.provider });
      if (row) {
        if (row.revision !== input.revision || row.lease_until > nowIso()) throw new ConflictException('연결이 변경되었거나 작업 중입니다. 다시 불러오세요.');
        if (await manager.getRepository(BusinessTrademarkAction).existsBy({ integration_id: row.id, status: In(OPEN_ACTIONS) })) throw new ConflictException('기존 검토·발송 요청을 먼저 처리하세요.');
      }
      const old = row ? readData<IntegrationData>(row.encrypted_data) : null;
      const sameAuth = old && old.credential_digest === fingerprint && row!.credential_id === input.credential_id && row!.status !== 'disconnected' &&
        JSON.stringify(adapter.oauth?.endpoints(old.config)) === JSON.stringify(adapter.oauth?.endpoints(config)) && old.config.account_id === config.account_id;
      const data: IntegrationData = { config, credential_digest: fingerprint, ...(sameAuth ? { tokens: old.tokens, identity: old.identity, cursor: old.cursor } : {}) };
      row = await repo.save({ ...(row || {}), account_id: accountId, company_id: companyId, trademark_id: trademarkId, provider: input.provider, credential_id: input.credential_id,
        encrypted_data: encrypt(JSON.stringify(data)), status: sameAuth && old?.tokens ? 'connected' : 'configured', auto_sync: input.auto_sync,
        interval_minutes: input.interval_minutes, next_sync_at: nowIso(), oauth_state_hash: null, last_error: '', revision: (row?.revision ?? -1) + 1 });
      await manager.getRepository(BusinessEvent).save({ account_id: accountId, company_id: companyId, actor_id: actor, kind: 'trademark', message: `${adapter.descriptor.name} 상표 커넥터를 설정했습니다.` });
      return this.publicConnection(row);
    });
  }
  async disconnect(companyId: string, accountId: string, trademarkId: string, id: string, revision: number) {
    const row = await this.connection(companyId, accountId, trademarkId, id);
    if (row.revision !== revision || row.lease_until > nowIso()) throw new ConflictException('연결이 변경되었거나 사용 중입니다. 다시 불러오세요.');
    if (await this.ds.getRepository(BusinessTrademarkAction).existsBy({ integration_id: id, status: In(OPEN_ACTIONS) })) throw new ConflictException('검토·발송 요청을 먼저 처리하세요.');
    const data = readData<IntegrationData>(row.encrypted_data);
    const changed = await this.ds.getRepository(BusinessTrademarkIntegration).update({ id, account_id: accountId, revision }, { status: 'disconnected', auto_sync: false, next_sync_at: null, oauth_state_hash: null,
      encrypted_data: encrypt(JSON.stringify({ config: data.config, credential_digest: data.credential_digest })), revision: revision + 1 });
    if (changed.affected !== 1) throw new ConflictException('연결 상태가 변경되었습니다.');
    return { success: true };
  }
  private async locked<T>(row: BusinessTrademarkIntegration, action: (row: BusinessTrademarkIntegration, data: IntegrationData) => Promise<T>): Promise<T> {
    if (row.status === 'disconnected') throw new ConflictException('연결을 다시 설정하세요.');
    const repo = this.ds.getRepository(BusinessTrademarkIntegration); const lease = randomUUID();
    const leaseUntil = new Date(Date.now() + 10 * 60_000).toISOString();
    const claim = await repo.update({ id: row.id, account_id: row.account_id, revision: row.revision, lease_until: LessThanOrEqual(nowIso()) },
      { lease_token: lease, lease_until: leaseUntil, revision: row.revision + 1 });
    if (claim.affected !== 1) throw new ConflictException('다른 요청이 연결을 사용 중입니다. 잠시 후 다시 확인하세요.');
    row.lease_token = lease; row.lease_until = leaseUntil; row.revision++;
    const data = readData<IntegrationData>(row.encrypted_data);
    try { return await action(row, data); }
    finally { await repo.update({ id: row.id, lease_token: lease }, { lease_token: '', lease_until: '', revision: () => 'revision + 1' }); }
  }
  private async storeData(row: BusinessTrademarkIntegration, data: IntegrationData, patch: Partial<BusinessTrademarkIntegration> = {}) {
    const changed = await this.ds.getRepository(BusinessTrademarkIntegration).update({ id: row.id, account_id: row.account_id, lease_token: row.lease_token }, { encrypted_data: encrypt(JSON.stringify(data)), ...patch });
    if (changed.affected !== 1) throw new ConflictException('연결 작업 권한이 만료되었습니다. 기록을 다시 확인하세요.');
  }
  private async context(row: BusinessTrademarkIntegration, data: IntegrationData, refresh = true): Promise<TrademarkConnectorContext> {
    const trademark = await this.owned(row.company_id, row.account_id, row.trademark_id);
    const account = await this.ds.getRepository(Account).findOneBy({ id: row.account_id });
    const owner = account?.owner_user_id ? await this.ds.getRepository(User).findOneBy({ id: account.owner_user_id }) : null;
    if (!owner || owner.status !== 'active' || !hasPermission(owner.role, JSON.parse(owner.permissions || '[]'), PERMISSIONS.MANAGE_BUSINESS)) throw new UnauthorizedException('계정 소유자의 실행 권한을 확인하세요.');
    const { secrets, fingerprint } = await this.credential(row.credential_id, row.provider, row.account_id);
    if (fingerprint !== data.credential_digest) throw new ConflictException('연결 후 credential이 변경되었습니다. 미처리 작업을 확인하고 연결을 다시 설정하세요.');
    const adapter = trademarkConnector(row.provider);
    if (adapter.oauth && refresh) {
      if (!data.tokens) throw new BadRequestException('먼저 서비스 로그인을 연결하세요.');
      if (data.tokens.expires_at < Date.now() + 120_000) {
        if (!data.tokens.refresh_token) throw new BadRequestException('갱신 권한이 없습니다. 서비스 로그인을 다시 연결하세요.');
        data.tokens = await this.tokens(adapter.oauth.endpoints(data.config), secrets, { grant_type: 'refresh_token', refresh_token: data.tokens.refresh_token }, data.tokens.refresh_token);
        await this.storeData(row, data);
      }
    }
    const sent = await this.ds.getRepository(BusinessTrademarkAction).find({ where: { integration_id: row.id, status: 'sent' }, select: ['external_id'], order: { created_at: 'ASC' } });
    // Bounded pagination must also finish before another worker can acquire the lease.
    const deadline = Math.min(Date.now() + 120_000, Date.parse(row.lease_until) - 30_000);
    const request: typeof trademarkRequest = (url, options) => {
      if (Date.now() >= deadline) throw new BadRequestException('수집 제한 시간을 초과했습니다. 잠시 후 다시 수집하세요.');
      return trademarkRequest(url, options);
    };
    return { id: row.id, data, secrets, trademark: readData<TrademarkDetails>(trademark.encrypted_details), external_ids: sent.map(a => a.external_id).filter(Boolean), request };
  }
  private async tokens(endpoint: { token: string; basic?: boolean; scope: string }, secrets: Record<string, string>, fields: Record<string, string>, previousRefresh = ''): Promise<OAuthTokens> {
    const result = await trademarkRequest(endpoint.token, { method: 'POST', headers: endpoint.basic ? { Authorization: `Basic ${Buffer.from(`${secrets.client_id}:${secrets.client_secret}`).toString('base64')}` } : {},
      form: { ...fields, ...(endpoint.basic ? {} : { client_id: secrets.client_id, client_secret: secrets.client_secret }) } });
    if (typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(Number(result.expires_in)) || Number(result.expires_in) <= 0) throw new BadRequestException('OAuth 토큰 응답을 확인하지 못했습니다. 다시 연결하세요.');
    return { access_token: result.access_token, refresh_token: typeof result.refresh_token === 'string' ? result.refresh_token : previousRefresh, expires_at: Date.now() + Number(result.expires_in) * 1000 };
  }
  async authorize(companyId: string, accountId: string, trademarkId: string, id: string, actor: string, origin?: string) {
    const row = await this.connection(companyId, accountId, trademarkId, id); const adapter = trademarkConnector(row.provider);
    if (!adapter.oauth) throw new BadRequestException('이 연결은 API 키를 사용합니다.');
    const base = oauthCallbackBase(origin);
    return this.locked(row, async (locked, data) => {
      const { fingerprint, secrets } = await this.credential(row.credential_id, row.provider, accountId);
      if (fingerprint !== data.credential_digest) throw new ConflictException('credential이 변경되었습니다. 연결 설정을 다시 저장하세요.');
      const state = randomBytes(32).toString('base64url'); const cookie = randomBytes(32).toString('base64url'); const verifier = randomBytes(48).toString('base64url');
      data.oauth = { verifier, cookie_hash: digest(cookie), expires: Date.now() + 10 * 60_000, user_id: actor, redirect_uri: `${base}${TRADEMARK_CALLBACK_PATH}`, credential_digest: fingerprint };
      await this.storeData(locked, data, { oauth_state_hash: digest(state) });
      const endpoint = adapter.oauth!.endpoints(data.config);
      const params = new URLSearchParams({ response_type: 'code', client_id: secrets.client_id, redirect_uri: data.oauth.redirect_uri, state, ...(endpoint.scope ? { scope: endpoint.scope } : {}), ...endpoint.extra,
        ...(endpoint.pkce ? { code_challenge: Buffer.from(digest(verifier), 'hex').toString('base64url'), code_challenge_method: 'S256' } : {}) });
      return { url: `${endpoint.authorize}?${params}`, cookie, cookie_name: `awb_tm_oauth_${state.slice(0, 12)}`, secure: base.startsWith('https:') };
    });
  }
  async callback(state: string, code: string, cookie: string) {
    if (!/^[a-zA-Z0-9_-]{43}$/.test(state) || !code || code.length > 5000) throw new UnauthorizedException('OAuth 요청이 만료되었거나 유효하지 않습니다.');
    const row = await this.ds.getRepository(BusinessTrademarkIntegration).findOneBy({ oauth_state_hash: digest(state) });
    if (!row) throw new UnauthorizedException('OAuth 요청을 다시 시작하세요.');
    return this.locked(row, async (locked, data) => {
      const flow = data.oauth;
      if (!flow || flow.expires < Date.now() || flow.cookie_hash !== digest(cookie)) throw new UnauthorizedException('같은 브라우저에서 연결을 다시 시작하세요.');
      const account = await this.ds.getRepository(Account).findOneBy({ id: row.account_id, owner_user_id: flow.user_id });
      if (!account) throw new UnauthorizedException('연결한 소유 계정이 변경되었습니다.');
      const context = await this.context(locked, data, false); const adapter = trademarkConnector(row.provider); const endpoint = adapter.oauth!.endpoints(data.config);
      delete data.oauth; await this.storeData(locked, data, { oauth_state_hash: null });
      const tokens = await this.tokens(endpoint, context.secrets, { grant_type: 'authorization_code', code, redirect_uri: flow.redirect_uri, ...(endpoint.pkce ? { code_verifier: flow.verifier } : {}) });
      const previousIdentity = data.identity; data.tokens = tokens;
      const identity = await adapter.oauth!.identify(context);
      const identityKey = (value: Record<string, string>) => value.account_id || value.id || value.email?.toLowerCase();
      if (previousIdentity && identityKey(identity) !== identityKey(previousIdentity)) throw new ConflictException('이전과 다른 서비스 계정입니다. 기존 연결을 해제한 뒤 새 계정을 연결하세요.');
      data.identity = identity;
      await this.storeData(locked, data, { status: 'connected', last_error: '', next_sync_at: nowIso() });
      return { company_id: row.company_id, trademark_id: row.trademark_id };
    });
  }
  private async saveRecords(row: BusinessTrademarkIntegration, records: TrademarkSourceRecord[]) {
    await this.ds.transaction(async manager => {
      const repo = manager.getRepository(BusinessTrademarkRecord);
      for (const record of records) {
        const sourceHash = digest(`${record.kind}:${record.source_id}`);
        const old = await repo.findOneBy({ integration_id: row.id, source_hash: sourceHash });
        const payload = JSON.stringify(record);
        if (old && decryptStrict(old.encrypted_data) === payload) continue;
        await repo.save({ ...(old || {}), account_id: row.account_id, company_id: row.company_id, trademark_id: row.trademark_id, integration_id: row.id, source_hash: sourceHash, encrypted_data: encrypt(payload) });
        if (record.kind === 'contract') await manager.getRepository(BusinessTrademarkAction).update({ integration_id: row.id, external_id: record.source_id, status: 'sent' }, { external_status: record.status });
      }
    });
  }
  async sync(companyId: string, accountId: string, trademarkId: string, id: string) {
    const row = await this.connection(companyId, accountId, trademarkId, id);
    return this.locked(row, async (locked, data) => {
      try {
        const context = await this.context(locked, data); const result = await trademarkConnector(row.provider).sync(context);
        await this.saveRecords(locked, result.records);
        data.summary = result.summary; if (result.cursor) data.cursor = { ...data.cursor, ...result.cursor };
        await this.storeData(locked, data, { status: 'connected', last_error: '', synced_at: nowIso(), next_sync_at: new Date(Date.now() + row.interval_minutes * 60_000).toISOString() });
      } catch {
        await this.storeData(locked, data, { status: 'error', last_error: SAFE_ERROR, next_sync_at: new Date(Date.now() + Math.max(5, row.interval_minutes) * 60_000).toISOString() });
        throw new BadRequestException(SAFE_ERROR);
      }
      return { success: true };
    });
  }
  async tick() {
    if (this.ticking || !this.ds.isInitialized) return;
    this.ticking = true;
    try {
      const rows = await this.ds.getRepository(BusinessTrademarkIntegration).find({ where: { auto_sync: true, status: In(['configured', 'connected', 'error']), next_sync_at: LessThanOrEqual(nowIso()), lease_until: LessThanOrEqual(nowIso()) }, order: { next_sync_at: 'ASC' }, take: 10 });
      for (const row of rows) {
        if (trademarkConnector(row.provider).oauth && !readData<IntegrationData>(row.encrypted_data).tokens) {
          await this.ds.getRepository(BusinessTrademarkIntegration).update({ id: row.id, revision: row.revision }, { next_sync_at: new Date(Date.now() + 15 * 60_000).toISOString() });
          continue;
        }
        await this.sync(row.company_id, row.account_id, row.trademark_id, row.id).catch(() => {});
      }
    } finally { this.ticking = false; }
  }
  async webhook(id: string, raw: Buffer, headers: Record<string, any>) {
    if (!z.string().uuid().safeParse(id).success) throw new UnauthorizedException('웹훅 인증에 실패했습니다.');
    if (!Buffer.isBuffer(raw) || raw.length > 1_000_000) throw new BadRequestException('웹훅 원문을 확인하세요.');
    const row = await this.ds.getRepository(BusinessTrademarkIntegration).findOneBy({ id });
    if (!row || row.status === 'disconnected') throw new UnauthorizedException('웹훅 인증에 실패했습니다.');
    const adapter = trademarkConnector(row.provider); const { secrets } = await this.credential(row.credential_id, row.provider, row.account_id);
    const h = (name: string) => typeof headers[name] === 'string' ? headers[name] : '';
    let verified = false;
    if (adapter.descriptor.webhook === 'svix') verified = verifySvixSignature({ secret: secrets.webhook_secret || '', id: h('svix-id'), timestamp: h('svix-timestamp'), signature: h('svix-signature'), body: raw });
    if (adapter.descriptor.webhook === 'docusign' && secrets.hmac_secret) {
      const expected = createHmac('sha256', secrets.hmac_secret).update(raw).digest();
      verified = Object.keys(headers).filter(key => /^x-docusign-signature-\d+$/.test(key)).some(key => { const received = Buffer.from(h(key), 'base64'); return received.length === expected.length && timingSafeEqual(received, expected); });
    }
    if (!verified) throw new UnauthorizedException('웹훅 서명이 유효하지 않습니다.');
    let event: any; try { event = JSON.parse(raw.toString('utf8')); } catch { throw new BadRequestException('JSON 웹훅 형식을 확인하세요.'); }
    return this.locked(row, async (locked, data) => {
      if (adapter.receive) {
        const context = await this.context(locked, data);
        await this.saveRecords(locked, await adapter.receive(context, event));
      } else if (adapter.descriptor.webhook === 'docusign') {
        if (event.data?.accountId !== data.identity?.account_id || !await this.ds.getRepository(BusinessTrademarkAction).existsBy({ integration_id: row.id, external_id: event.data?.envelopeId || '', status: 'sent' })) return { success: true };
        // Read current state rather than trusting an older signed event to move a contract backwards.
        const context = await this.context(locked, data);
        context.external_ids = [event.data.envelopeId];
        const result = await adapter.sync(context);
        await this.saveRecords(locked, result.records);
        await this.storeData(locked, data, { synced_at: nowIso(), last_error: '' });
      }
      return { success: true };
    });
  }
  async options(companyId: string, accountId: string, trademarkId: string, id: string) {
    const row = await this.connection(companyId, accountId, trademarkId, id);
    return this.locked(row, async (locked, data) => trademarkConnector(row.provider).options?.(await this.context(locked, data)) || {});
  }
  private contextDigest(row: BusinessTrademarkIntegration, data: IntegrationData) {
    const identity = data.identity;
    // Display-name edits must not strand a request whose provider receipt still needs reconciling.
    return digest(JSON.stringify({ provider: row.provider, credential: row.credential_id, fingerprint: data.credential_digest, config: data.config,
      identity: identity && { account_id: identity.account_id, id: identity.id, email: identity.email?.toLowerCase(), base_uri: identity.base_uri } }));
  }
  private async action(companyId: string, accountId: string, trademarkId: string, actionId: string) {
    await this.owned(companyId, accountId, trademarkId);
    const row = await this.ds.getRepository(BusinessTrademarkAction).findOneBy({ id: actionId, account_id: accountId, company_id: companyId, trademark_id: trademarkId });
    if (!row) throw new NotFoundException('검토 요청을 찾을 수 없습니다.');
    return row;
  }
  async prepare(companyId: string, accountId: string, trademarkId: string, id: string, body: unknown, actor: string) {
    const input = parseTrademark(z.object({ trademark_revision: z.number().int().nonnegative(), payload: z.unknown() }), body);
    const row = await this.connection(companyId, accountId, trademarkId, id); const adapter = trademarkConnector(row.provider);
    if (!adapter.prepare || !adapter.descriptor.action) throw new BadRequestException('이 커넥터는 조회용입니다.');
    return this.locked(row, async (locked, data) => {
      if (await this.ds.getRepository(BusinessTrademarkAction).existsBy({ integration_id: id, status: In(OPEN_ACTIONS) })) throw new ConflictException('기존 검토·발송 요청을 먼저 처리하세요.');
      const actionId = randomUUID(); const prepared = await adapter.prepare!(await this.context(locked, data), input.payload, actionId);
      const contextDigest = this.contextDigest(locked, data); const payloadDigest = digest(JSON.stringify({ actionId, contextDigest, prepared }));
      return this.ds.transaction(async manager => {
        await manager.getRepository(BusinessCompany).increment({ id: companyId, account_id: accountId }, 'revision', 1);
        const trademark = await manager.getRepository(BusinessTrademark).findOneByOrFail({ id: trademarkId, account_id: accountId, company_id: companyId });
        if (trademark.revision !== input.trademark_revision) throw new ConflictException('상표 정보가 변경되었습니다. 다시 작성하세요.');
        const action = await manager.getRepository(BusinessTrademarkAction).save({ id: actionId, account_id: accountId, company_id: companyId, trademark_id: trademarkId, integration_id: id,
          credential_id: row.credential_id, context_digest: contextDigest, trademark_revision: trademark.revision, kind: adapter.descriptor.action,
          encrypted_data: encrypt(JSON.stringify(prepared)), payload_digest: payloadDigest, status: 'draft' });
        await manager.getRepository(BusinessEvent).save({ account_id: accountId, company_id: companyId, actor_id: actor, kind: 'trademark', message: `${adapter.descriptor.name} 요청을 검토용으로 저장했습니다. 아직 발송하지 않았습니다.` });
        return this.publicAction(action, true);
      });
    });
  }
  async review(companyId: string, accountId: string, trademarkId: string, actionId: string) { return this.publicAction(await this.action(companyId, accountId, trademarkId, actionId), true); }
  async discard(companyId: string, accountId: string, trademarkId: string, actionId: string, body: unknown) {
    const input = parseTrademark(approval, body); const row = await this.action(companyId, accountId, trademarkId, actionId);
    if (row.status !== 'draft' || row.payload_digest !== input.payload_digest || row.revision !== input.revision) throw new ConflictException('미발송 검토 요청만 삭제할 수 있습니다.');
    const result = await this.ds.getRepository(BusinessTrademarkAction).delete({ id: row.id, account_id: accountId, revision: input.revision, status: 'draft' });
    if (result.affected !== 1) throw new ConflictException('요청 상태가 변경되었습니다.');
    return { success: true };
  }
  async execute(companyId: string, accountId: string, trademarkId: string, actionId: string, body: unknown, actor: string, reconcile = false) {
    const input = parseTrademark(approval, body); const action = await this.action(companyId, accountId, trademarkId, actionId);
    if (action.payload_digest !== input.payload_digest || action.revision !== input.revision) throw new ConflictException('검토 요청이 변경되었습니다. 다시 불러오세요.');
    if (action.status === 'sent') return this.publicAction(action, true);
    if ((!reconcile && action.status !== 'draft') || (reconcile && action.status === 'draft')) throw new ConflictException('이미 시도한 발송은 원문 대조로 확인하세요. 자동 재발송하지 않습니다.');
    const connection = await this.connection(companyId, accountId, trademarkId, action.integration_id); const adapter = trademarkConnector(connection.provider);
    return this.locked(connection, async (locked, data) => {
      const context = await this.context(locked, data);
      if (action.context_digest !== this.contextDigest(locked, data)) throw new ConflictException('검토 이후 연결 대상 또는 키가 변경되었습니다.');
      const prepared = readData<PreparedTrademarkAction>(action.encrypted_data);
      if (!reconcile) {
        await adapter.verify?.(context, prepared);
        await this.ds.transaction(async manager => {
          await manager.getRepository(BusinessCompany).increment({ id: companyId, account_id: accountId }, 'revision', 1);
          const trademark = await manager.getRepository(BusinessTrademark).findOneByOrFail({ id: trademarkId, account_id: accountId });
          if (trademark.revision !== action.trademark_revision) throw new ConflictException('검토 이후 상표 정보가 변경되었습니다. 요청을 다시 작성하세요.');
          const changed = await manager.getRepository(BusinessTrademarkAction).update({ id: action.id, account_id: accountId, status: 'draft', revision: action.revision }, { status: 'sending', attempted_at: nowIso(), revision: action.revision + 1 });
          if (changed.affected !== 1) throw new ConflictException('다른 요청이 이미 발송을 시작했습니다.');
          await manager.getRepository(BusinessEvent).save({ account_id: accountId, company_id: companyId, actor_id: actor, kind: 'trademark', message: `${adapter.descriptor.name}의 검토한 요청 발송을 승인했습니다.` });
        });
        action.revision++;
      }
      let result;
      try {
        result = reconcile ? await adapter.reconcile!(context, prepared, action.id, input.external_id || action.external_id) :
          await adapter.execute!(context, prepared, action.id, async externalId => {
            const saved = await this.ds.getRepository(BusinessTrademarkAction).update({ id: action.id, account_id: accountId, revision: action.revision, status: 'sending' }, { external_id: externalId });
            if (saved.affected !== 1) throw new ConflictException('발송 초안 기록을 저장하지 못했습니다.');
          });
      } catch {
        if (!reconcile) await this.ds.getRepository(BusinessTrademarkAction).update({ id: action.id, account_id: accountId, revision: action.revision, status: 'sending' }, { status: 'uncertain', revision: action.revision + 1,
          last_error: '공급자 접수 결과를 확인하지 못했습니다. 다시 발송하지 않습니다. 기존 메일·계약의 원문 대조로 확인하세요.' });
        if (reconcile) throw new ConflictException('공급자의 발송 원문을 대조하지 못했습니다. 서비스에서 ID·초안 여부를 확인하세요. 새 요청은 보내지 않았습니다.');
        return this.review(companyId, accountId, trademarkId, actionId);
      }
      if (result.conversation_id) {
        const conversations: string[] = JSON.parse(data.cursor?.conversations || '[]');
        data.cursor = { ...data.cursor, conversations: JSON.stringify([...new Set([...conversations, result.conversation_id])].slice(-20)) };
      }
      await this.ds.transaction(async manager => {
        const changed = await manager.getRepository(BusinessTrademarkAction).update({ id: action.id, account_id: accountId, revision: action.revision }, { status: 'sent', external_id: result.id, external_status: result.status, last_error: '', revision: action.revision + 1 });
        if (changed.affected !== 1) throw new ConflictException('발송 결과 기록이 변경되었습니다. 원문 대조로 확인하세요.');
        const saved = await manager.getRepository(BusinessTrademarkIntegration).update({ id: locked.id, account_id: accountId, lease_token: locked.lease_token }, { encrypted_data: encrypt(JSON.stringify(data)), next_sync_at: nowIso() });
        if (saved.affected !== 1) throw new ConflictException('연결 작업 권한이 만료되었습니다. 원문 대조로 확인하세요.');
        await manager.getRepository(BusinessEvent).save({ account_id: accountId, company_id: companyId, actor_id: actor, kind: 'trademark', message: `${adapter.descriptor.name} 공급자 접수를 확인했습니다. 계약·출원 완료 여부는 별도 확인합니다.` });
      });
      return this.review(companyId, accountId, trademarkId, actionId);
    });
  }
  async document(companyId: string, accountId: string, trademarkId: string, actionId: string, preview: number | null) {
    const action = await this.action(companyId, accountId, trademarkId, actionId);
    if (preview !== null) {
      const prepared = readData<PreparedTrademarkAction>(action.encrypted_data); const document = prepared.documents?.[preview];
      if (!document) throw new NotFoundException('검토 문서를 찾을 수 없습니다.');
      return Buffer.from(document.pdf, 'base64');
    }
    const row = await this.connection(companyId, accountId, trademarkId, action.integration_id); const adapter = trademarkConnector(row.provider);
    if (!adapter.document || action.status !== 'sent') throw new BadRequestException('접수된 서명 요청을 선택하세요.');
    return this.locked(row, async (locked, data) => adapter.document!(await this.context(locked, data), action.external_id));
  }
}
