import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { discoverOAuthServerInfo, exchangeAuthorization, refreshAuthorization, registerClient, startAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import type { AuthorizationServerMetadata, OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { Account } from '../../entities/Account';
import { SystemSetting } from '../../entities/SystemSetting';
import { BusinessMcpConnection } from '../../entities/BusinessMcpConnection';
import { encrypt, decrypt, decryptStrict } from '../../services/encryption.service';
import { BusinessService } from './business.service';
import { MCP_CONNECTORS, MCP_LOOPBACK_REDIRECT, mcpConnector, isOwnerOnlyTool, registeredMcpClient, type McpProviderSpec } from './connectors/mcp-providers';
import { oauthCallbackBase } from '../../common/public-url';

export const BUSINESS_MCP_CALLBACK_PATH = '/api/business-mcp/oauth/callback';
const FLOW_MS = 10 * 60_000;
const MAX_TOOL_PAGES = 20;
const MAX_RESULT_CHARS = 60_000;

export interface BusinessMcpTool {
  name: string;
  title: string;
  description: string;
  read_only: boolean;
  owner_only: boolean;
  input_schema: Record<string, unknown>;
}
interface McpData {
  client?: { client_id: string; client_secret?: string; redirect_uri: string };
  tokens?: { access_token: string; refresh_token?: string; expires_at?: number };
  flow?: { verifier: string; user_id: string; expires: number; redirect_uri: string; mode: 'redirect' | 'paste'; cookie_hash?: string };
  tools?: BusinessMcpTool[];
}
interface Discovery { url: string; metadata: AuthorizationServerMetadata; resource?: URL; at: number }

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const read = (row: BusinessMcpConnection): McpData => JSON.parse(decryptStrict(row.encrypted_data));
const nowIso = () => new Date().toISOString();
const callArgs = z.record(z.string(), z.unknown());

/** OAuth and MCP requests only reach the origins a provider spec pins; redirects are refused. */
function pinnedFetch(spec: McpProviderSpec, timeoutMs: number) {
  const origins = new Set([new URL(spec.url).origin, ...spec.auth_origins.map(o => new URL(o).origin)]);
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== 'https:' || !origins.has(url.origin)) throw new BadGatewayException('허용되지 않은 공급자 주소로의 요청을 거부했습니다.');
    const signal = init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    return fetch(input, { ...init, redirect: 'error', signal });
  };
}
const statusOf = (error: unknown) => {
  const e = error as { code?: unknown; status?: unknown; name?: string };
  return typeof e?.code === 'number' ? e.code : typeof e?.status === 'number' ? e.status : e?.name === 'UnauthorizedError' ? 401 : 0;
};

@Injectable()
export class BusinessMcpService {
  private readonly discovery = new Map<string, Discovery>();
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly business: BusinessService) {}

  /** Token refresh rotates refresh tokens; one writer per connection keeps the stored pair valid. */
  private exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    const tail = next.catch(() => {});
    this.locks.set(id, tail);
    void tail.then(() => { if (this.locks.get(id) === tail) this.locks.delete(id); });
    return next;
  }
  private async store(row: BusinessMcpConnection, data: McpData, patch: Partial<BusinessMcpConnection> = {}) {
    const result = await this.ds.getRepository(BusinessMcpConnection).update({ id: row.id, revision: row.revision }, { ...patch, encrypted_data: encrypt(JSON.stringify(data)), revision: row.revision + 1 });
    if (result.affected !== 1) throw new ConflictException('연결이 다른 요청에서 변경되었습니다. 다시 시도하세요.');
    Object.assign(row, patch, { revision: row.revision + 1 });
  }
  private async row(companyId: string, accountId: string, provider: string) {
    await this.business.company(companyId, accountId);
    mcpConnector(provider);
    const row = await this.ds.getRepository(BusinessMcpConnection).findOneBy({ company_id: companyId, account_id: accountId, provider });
    if (!row) throw new NotFoundException('먼저 공급자 계정으로 로그인해 연결하세요.');
    return row;
  }

  private async discover(provider: string, spec: McpProviderSpec): Promise<Discovery> {
    const cached = this.discovery.get(provider);
    if (cached && Date.now() - cached.at < FLOW_MS) return cached;
    let info;
    try { info = await discoverOAuthServerInfo(spec.url, { fetchFn: pinnedFetch(spec, 15_000) }); }
    catch { throw new BadGatewayException('공급자 로그인 정보를 확인하지 못했습니다. 잠시 후 다시 시도하세요.'); }
    const metadata = info.authorizationServerMetadata;
    const endpoints = [metadata?.authorization_endpoint, metadata?.token_endpoint, metadata?.registration_endpoint].filter(Boolean) as string[];
    const allowed = new Set(spec.auth_origins.map(o => new URL(o).origin));
    if (!metadata || !metadata.authorization_endpoint || !metadata.token_endpoint || endpoints.some(e => { try { const u = new URL(e); return u.protocol !== 'https:' || !allowed.has(u.origin); } catch { return true; } })) {
      throw new BadGatewayException('공급자 로그인 주소가 예상한 도메인과 다릅니다. 연결을 중단했습니다.');
    }
    const found: Discovery = { url: info.authorizationServerUrl, metadata, resource: info.resourceMetadata?.resource ? new URL(info.resourceMetadata.resource) : undefined, at: Date.now() };
    this.discovery.set(provider, found);
    return found;
  }
  /** A client the provider issued to this AWB: env first, then Admin → Settings. */
  private async issuedClient(spec: McpProviderSpec): Promise<{ client_id: string; client_secret?: string } | null> {
    if (spec.client.kind !== 'public') return null;
    const env = registeredMcpClient(spec); if (env) return env;
    const prefix = spec.client.registered_setting;
    const rows = await this.ds.getRepository(SystemSetting).findBy([{ key: `${prefix}.client_id` }, { key: `${prefix}.client_secret` }]).catch(() => [] as SystemSetting[]);
    const id = rows.find(row => row.key === `${prefix}.client_id`)?.value.trim();
    const sealed = rows.find(row => row.key === `${prefix}.client_secret`)?.value;
    const secret = sealed ? decrypt(sealed).trim() : '';
    return id ? { client_id: id, ...(secret ? { client_secret: secret } : {}) } : null;
  }
  private redirectFor(spec: McpProviderSpec, origin: string | undefined, issued: boolean): { uri: string; mode: 'redirect' | 'paste' } {
    if (issued) return { uri: `${oauthCallbackBase(origin)}${BUSINESS_MCP_CALLBACK_PATH}`, mode: 'redirect' };
    if (spec.client.kind === 'public') return { uri: MCP_LOOPBACK_REDIRECT, mode: 'paste' };
    try { return { uri: `${oauthCallbackBase(origin)}${BUSINESS_MCP_CALLBACK_PATH}`, mode: 'redirect' }; }
    // Not on HTTPS (e.g. a LAN http:// address): the provider cannot return to AWB; the owner pastes the loopback address instead.
    catch { return { uri: MCP_LOOPBACK_REDIRECT, mode: 'paste' }; }
  }
  private async clientFor(provider: string, spec: McpProviderSpec, found: Discovery, data: McpData, redirectUri: string): Promise<OAuthClientInformationFull> {
    const issued = await this.issuedClient(spec);
    if (issued) return { ...issued, redirect_uris: [redirectUri] };
    if (spec.client.kind === 'public') return { client_id: spec.client.client_id, redirect_uris: [redirectUri] };
    if (data.client?.redirect_uri === redirectUri) return { client_id: data.client.client_id, ...(data.client.client_secret ? { client_secret: data.client.client_secret } : {}), redirect_uris: [redirectUri] };
    if (!found.metadata.registration_endpoint) throw new BadGatewayException('공급자가 클라이언트 등록을 지원하지 않습니다.');
    let registered;
    try {
      registered = await registerClient(found.url, { metadata: found.metadata, fetchFn: pinnedFetch(spec, 15_000), clientMetadata: {
        client_name: 'AI Workflow Board', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
        ...(spec.scope ? { scope: spec.scope } : {}) } });
    } catch { throw new BadGatewayException(`${mcpConnector(provider).name} 로그인 클라이언트를 등록하지 못했습니다. 잠시 후 다시 시도하세요.`); }
    data.client = { client_id: registered.client_id, ...(registered.client_secret ? { client_secret: registered.client_secret } : {}), redirect_uri: redirectUri };
    return registered;
  }

  /**
   * The shared public client's allowed redirects are the provider's to change (Northwest dropped
   * localhost overnight). Ask the authorization endpoint first so the owner gets a reason, not the
   * provider's "Invalid parameter: redirect_uri" page.
   */
  private async checkSharedClientRedirect(name: string, spec: McpProviderSpec, url: URL) {
    let status = 0;
    try { const res = await pinnedFetch(spec, 15_000)(url, { method: 'GET' }); status = res.status; await res.body?.cancel(); }
    catch { return; /* Unreachable or redirected: let the browser show the provider's own page. */ }
    if (status === 400) {
      throw new ConflictException(`${name}가 공용 로그인 클라이언트로 외부 앱의 로그인을 더 이상 받지 않습니다(Claude·ChatGPT·Cursor만 허용). ${name}에서 이 AWB용 OAuth 클라이언트를 발급받으면 관리자 설정 → Business MCP 클라이언트에 넣으세요.`);
    }
  }

  list(companyId: string, accountId: string) {
    return this.business.company(companyId, accountId).then(async () => {
      const rows = await this.ds.getRepository(BusinessMcpConnection).find({ where: { company_id: companyId, account_id: accountId } });
      return MCP_CONNECTORS.map(({ descriptor }) => {
        const row = rows.find(r => r.provider === descriptor.id);
        const data = row ? read(row) : null;
        return { provider: descriptor.id, status: !row ? 'disconnected' : data?.tokens || row.status === 'error' ? row.status : 'authorizing', connected_at: row?.connected_at || null,
          tools_synced_at: row?.tools_synced_at || null, last_error: row?.last_error || '', pending_mode: data?.flow && data.flow.expires > Date.now() ? data.flow.mode : null,
          tools: (data?.tools || []).map(({ input_schema, ...tool }) => ({ ...tool, description: tool.description.slice(0, 300) })) };
      });
    });
  }

  /** Starts the owner's provider sign-in. Paste mode returns the loopback address the owner copies back. */
  async authorize(companyId: string, accountId: string, provider: string, userId: string, origin?: string) {
    const company = await this.business.company(companyId, accountId);
    const descriptor = mcpConnector(provider); const spec = descriptor.mcp;
    const found = await this.discover(provider, spec);
    const repo = this.ds.getRepository(BusinessMcpConnection);
    let row = await repo.findOneBy({ company_id: companyId, account_id: accountId, provider });
    if (!row) row = await repo.save({ account_id: accountId, company_id: companyId, provider, encrypted_data: encrypt('{}'), status: 'authorizing', oauth_state_hash: null, last_error: '', revision: 0 });
    return this.exclusive(row.id, async () => {
      const current = await repo.findOneByOrFail({ id: row!.id });
      const data = read(current);
      const issued = !!(await this.issuedClient(spec));
      const redirect = this.redirectFor(spec, origin, issued);
      const clientInformation = await this.clientFor(provider, spec, found, data, redirect.uri);
      const state = randomBytes(32).toString('base64url');
      const cookie = redirect.mode === 'redirect' ? randomBytes(32).toString('base64url') : '';
      const { authorizationUrl, codeVerifier } = await startAuthorization(found.url, { metadata: found.metadata, clientInformation, redirectUrl: redirect.uri, state,
        ...(spec.scope ? { scope: spec.scope } : {}), ...(found.resource ? { resource: found.resource } : {}) });
      if (spec.client.kind === 'public' && !issued) await this.checkSharedClientRedirect(descriptor.name, spec, authorizationUrl);
      data.flow = { verifier: codeVerifier, user_id: userId, expires: Date.now() + FLOW_MS, redirect_uri: redirect.uri, mode: redirect.mode, ...(cookie ? { cookie_hash: sha(cookie) } : {}) };
      await this.store(current, data, { oauth_state_hash: sha(state), last_error: '' });
      await this.ds.transaction(manager => this.business.event(manager, company, userId, 'connector', `${descriptor.name} MCP 로그인을 시작했습니다.`));
      return { url: authorizationUrl.toString(), mode: redirect.mode, redirect_uri: redirect.uri, cookie, cookie_name: `awb_mcp_oauth_${state.slice(0, 12)}`, secure: redirect.uri.startsWith('https:') };
    });
  }

  /** Paste mode: the owner copies the final address (code + state) from the browser after signing in. */
  async completePasted(companyId: string, accountId: string, provider: string, body: unknown, userId: string) {
    const input = z.object({ callback_url: z.string().trim().min(10).max(6000) }).safeParse(body);
    if (!input.success) throw new BadRequestException('로그인 후 브라우저 주소창의 전체 주소를 붙여 넣으세요.');
    let url: URL;
    try { url = new URL(input.data.callback_url); } catch { throw new BadRequestException('주소 형식이 올바르지 않습니다. 주소창의 전체 주소를 붙여 넣으세요.'); }
    const row = await this.row(companyId, accountId, provider);
    const flow = read(row).flow;
    if (!flow || flow.mode !== 'paste') throw new BadRequestException('진행 중인 로그인이 없습니다. 로그인을 다시 시작하세요.');
    const expected = new URL(flow.redirect_uri);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname) throw new BadRequestException(`${expected.origin}${expected.pathname} 로 시작하는 주소를 붙여 넣으세요.`);
    if (url.searchParams.get('error')) throw new BadRequestException('공급자에서 로그인을 취소했거나 거부했습니다. 다시 시도하세요.');
    return this.complete(url.searchParams.get('state') || '', url.searchParams.get('code') || '', { userId, accountId });
  }

  /** Exchanges the code. Redirect mode binds the browser by cookie; paste mode by the signed-in owner. */
  async complete(state: string, code: string, binding: { cookie: string } | { userId: string; accountId: string }) {
    if (!/^[a-zA-Z0-9_-]{43}$/.test(state) || !code || code.length > 5000) throw new UnauthorizedException('로그인 요청이 만료되었거나 유효하지 않습니다.');
    const found0 = await this.ds.getRepository(BusinessMcpConnection).findOneBy({ oauth_state_hash: sha(state) });
    if (!found0) throw new UnauthorizedException('로그인을 다시 시작하세요.');
    return this.exclusive(found0.id, async () => {
      const row = await this.ds.getRepository(BusinessMcpConnection).findOneByOrFail({ id: found0.id });
      const data = read(row); const flow = data.flow;
      const bound = 'cookie' in binding ? flow?.mode === 'redirect' && flow.cookie_hash === sha(binding.cookie) : flow?.mode === 'paste' && flow.user_id === binding.userId && row.account_id === binding.accountId;
      if (!flow || flow.expires < Date.now() || row.oauth_state_hash !== sha(state) || !bound) throw new UnauthorizedException('같은 브라우저·계정에서 로그인을 다시 시작하세요.');
      const account = await this.ds.getRepository(Account).findOneBy({ id: row.account_id, owner_user_id: flow.user_id });
      if (!account) throw new UnauthorizedException('연결한 소유 계정이 변경되었습니다.');
      const spec = mcpConnector(row.provider).mcp; const found = await this.discover(row.provider, spec);
      delete data.flow;
      await this.store(row, data, { oauth_state_hash: null });
      const clientInformation = await this.clientFor(row.provider, spec, found, data, flow.redirect_uri);
      let tokens;
      try {
        tokens = await exchangeAuthorization(found.url, { metadata: found.metadata, clientInformation, authorizationCode: code, codeVerifier: flow.verifier, redirectUri: flow.redirect_uri,
          ...(found.resource ? { resource: found.resource } : {}), fetchFn: pinnedFetch(spec, 15_000) });
      } catch {
        await this.store(row, data, { status: 'error', last_error: '로그인 코드를 교환하지 못했습니다. 로그인을 다시 시작하세요.' });
        throw new BadGatewayException('로그인 코드를 교환하지 못했습니다. 로그인을 다시 시작하세요.');
      }
      data.tokens = { access_token: tokens.access_token, ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}), ...(tokens.expires_in ? { expires_at: Date.now() + tokens.expires_in * 1000 } : {}) };
      delete data.tools;
      await this.store(row, data, { status: 'connected', connected_at: nowIso(), tools_synced_at: null, last_error: '' });
      const company = await this.business.company(row.company_id, row.account_id);
      await this.ds.transaction(manager => this.business.event(manager, company, flow.user_id, 'connector', `${mcpConnector(row.provider).name} MCP 계정을 연결했습니다.`));
      return { company_id: row.company_id, provider: row.provider };
    });
  }

  private async accessToken(row: BusinessMcpConnection, data: McpData, force = false) {
    const tokens = data.tokens;
    if (!tokens) throw new ConflictException('공급자 로그인이 필요합니다. 연결 화면에서 로그인하세요.');
    if (!force && (!tokens.expires_at || tokens.expires_at - 60_000 > Date.now())) return tokens.access_token;
    if (!tokens.refresh_token) {
      await this.store(row, data, { status: 'error', last_error: '로그인이 만료되었습니다. 다시 로그인하세요.' });
      throw new ConflictException('공급자 로그인이 만료되었습니다. 소유자가 연결 화면에서 다시 로그인해야 합니다.');
    }
    const spec = mcpConnector(row.provider).mcp; const found = await this.discover(row.provider, spec);
    const clientInformation = await this.clientFor(row.provider, spec, found, data, data.client?.redirect_uri || MCP_LOOPBACK_REDIRECT);
    try {
      const next = await refreshAuthorization(found.url, { metadata: found.metadata, clientInformation, refreshToken: tokens.refresh_token, ...(found.resource ? { resource: found.resource } : {}), fetchFn: pinnedFetch(spec, 15_000) });
      data.tokens = { access_token: next.access_token, refresh_token: next.refresh_token || tokens.refresh_token, ...(next.expires_in ? { expires_at: Date.now() + next.expires_in * 1000 } : {}) };
      await this.store(row, data, { status: 'connected', last_error: '' });
      return data.tokens.access_token;
    } catch (error) {
      // Only a rejected grant ends the sign-in; a network failure keeps the tokens for the next attempt.
      if (!(error instanceof InvalidGrantError)) throw new BadGatewayException('공급자 로그인 갱신 요청이 실패했습니다. 잠시 후 다시 시도하세요.');
      delete data.tokens;
      await this.store(row, data, { status: 'error', last_error: '로그인이 만료되었습니다. 다시 로그인하세요.' });
      throw new ConflictException('공급자 로그인이 만료되었습니다. 소유자가 연결 화면에서 다시 로그인해야 합니다.');
    }
  }
  /** One MCP session per operation; a 401 refreshes once (the request was rejected, so nothing ran). */
  private async session<T>(row: BusinessMcpConnection, data: McpData, timeoutMs: number, work: (client: Client) => Promise<T>): Promise<T> {
    const spec = mcpConnector(row.provider).mcp;
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken(row, data, attempt > 0);
      const client = new Client({ name: 'ai-workflow-board', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } }, fetch: pinnedFetch(spec, timeoutMs) });
      try {
        await client.connect(transport);
        return await work(client);
      } catch (error) {
        if (error instanceof HttpException) throw error;
        if (statusOf(error) === 401 && attempt === 0) continue;
        throw new BadGatewayException(statusOf(error) === 401 ? '공급자가 로그인을 거부했습니다. 소유자가 다시 로그인해야 합니다.' : '공급자 MCP 서버 호출에 실패했습니다. 잠시 후 다시 시도하세요.');
      } finally { await client.close().catch(() => {}); }
    }
  }

  async refreshTools(companyId: string, accountId: string, provider: string) {
    const row0 = await this.row(companyId, accountId, provider);
    return this.exclusive(row0.id, async () => {
      const row = await this.ds.getRepository(BusinessMcpConnection).findOneByOrFail({ id: row0.id });
      const data = read(row); const spec = mcpConnector(provider).mcp;
      const tools = await this.session(row, data, 30_000, async client => {
        const all: BusinessMcpTool[] = []; let cursor: string | undefined;
        for (let page = 0; page < MAX_TOOL_PAGES; page++) {
          const result = await client.listTools(cursor ? { cursor } : undefined);
          for (const tool of result.tools) all.push({ name: tool.name, title: String(tool.title || tool.annotations?.title || ''), description: String(tool.description || '').slice(0, 2000),
            read_only: tool.annotations?.readOnlyHint === true, owner_only: isOwnerOnlyTool(spec, tool.name), input_schema: tool.inputSchema as Record<string, unknown> });
          cursor = result.nextCursor; if (!cursor) break;
        }
        return all;
      });
      data.tools = tools;
      await this.store(row, data, { tools_synced_at: nowIso(), last_error: '' });
      return tools;
    });
  }

  /** Tool catalogue for agents. Without `names`, schemas are omitted so 100+ tools fit in context. */
  async tools(companyId: string, accountId: string, provider: string, options: { query?: string; names?: string[]; refresh?: boolean }) {
    const row = await this.row(companyId, accountId, provider);
    let tools = read(row).tools;
    if (!tools || options.refresh) tools = await this.refreshTools(companyId, accountId, provider);
    const q = options.query?.toLowerCase().trim();
    const picked = options.names?.length ? tools.filter(t => options.names!.includes(t.name)) : tools.filter(t => !q || `${t.name} ${t.title} ${t.description}`.toLowerCase().includes(q));
    return { provider, count: tools.length, tools: picked.map(t => options.names?.length ? t : { name: t.name, title: t.title, description: t.description.slice(0, 400), read_only: t.read_only, owner_only: t.owner_only }) };
  }

  /**
   * Relays one tool call. Read-only tools run directly; anything else needs `confirm: true` for an
   * explicit user instruction, and owner-only tools (payment / checkout) are never relayed.
   */
  async call(companyId: string, accountId: string, provider: string, body: unknown, actor: string) {
    const input = z.object({ tool: z.string().min(1).max(200), arguments: callArgs.default({}), confirm: z.boolean().optional() }).safeParse(body);
    if (!input.success) throw new BadRequestException('tool 이름과 arguments 객체가 필요합니다.');
    const company = await this.business.company(companyId, accountId);
    const descriptor = mcpConnector(provider);
    let listed = (await this.tools(companyId, accountId, provider, { names: [input.data.tool] })).tools[0] as BusinessMcpTool | undefined;
    if (!listed) listed = (await this.tools(companyId, accountId, provider, { names: [input.data.tool], refresh: true })).tools[0] as BusinessMcpTool | undefined;
    if (!listed) throw new NotFoundException(`${descriptor.name} MCP에 ${input.data.tool} 도구가 없습니다. 도구 목록을 다시 조회하세요.`);
    if (listed.owner_only) throw new ForbiddenException(`${input.data.tool}은 결제·서명 단계라 AWB에서 대신 실행하지 않습니다. 소유자가 ${descriptor.name} 화면에서 직접 진행하도록 안내하세요.`);
    if (!listed.read_only && input.data.confirm !== true) throw new BadRequestException(`${input.data.tool}은 공급자 데이터를 바꿀 수 있는 도구입니다. 사용자가 이 작업을 명시적으로 지시한 경우에만 confirm: true로 다시 호출하세요.`);
    const row0 = await this.row(companyId, accountId, provider);
    const result = await this.exclusive(row0.id, async () => {
      const row = await this.ds.getRepository(BusinessMcpConnection).findOneByOrFail({ id: row0.id });
      return this.session(row, read(row), 120_000, client => client.callTool({ name: input.data.tool, arguments: input.data.arguments }));
    });
    if (!listed.read_only) await this.ds.transaction(manager => this.business.event(manager, company, actor, 'connector', `${descriptor.name} MCP · ${input.data.tool} 실행`));
    let used = 0;
    const content = (Array.isArray(result.content) ? result.content : []).map((item: any) => {
      if (item?.type === 'text') { const text = String(item.text).slice(0, Math.max(0, MAX_RESULT_CHARS - used)); used += text.length; return { type: 'text', text }; }
      if (item?.type === 'resource_link') return { type: 'resource_link', uri: String(item.uri || ''), name: String(item.name || '') };
      return { type: String(item?.type || 'unknown'), omitted: true };
    });
    const structured = result.structuredContent ? JSON.stringify(result.structuredContent) : '';
    return { provider, tool: input.data.tool, read_only: listed.read_only, is_error: result.isError === true, truncated: used >= MAX_RESULT_CHARS || structured.length > MAX_RESULT_CHARS,
      content_untrusted: content, ...(structured && structured.length <= MAX_RESULT_CHARS ? { structured_untrusted: result.structuredContent } : {}) };
  }

  async disconnect(companyId: string, accountId: string, provider: string, actor: string) {
    const row = await this.row(companyId, accountId, provider);
    const company = await this.business.company(companyId, accountId);
    await this.exclusive(row.id, async () => {
      await this.ds.transaction(async manager => {
        await manager.getRepository(BusinessMcpConnection).delete({ id: row.id, account_id: accountId });
        await this.business.event(manager, company, actor, 'connector', `${mcpConnector(provider).name} MCP 연결을 해제했습니다.`);
      });
    });
    return { provider, status: 'disconnected' };
  }
}
