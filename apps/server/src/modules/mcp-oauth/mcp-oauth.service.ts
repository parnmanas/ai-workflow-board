import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError, TemporarilyUnavailableError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { In, Repository } from 'typeorm';
import { Account } from '../../entities/Account';
import { McpOAuthGrant } from '../../entities/McpOAuthGrant';
import { AccountAccessService } from '../../services/account-access.service';
import { keyedDigest } from '../../services/encryption.service';
import { isValidCodeChallenge } from '../auth/oauth-flow';
import { mcpClients, oauthBase } from './mcp-oauth-clients';

const minute = 60000;
const accessMs = 60 * minute;
const familyMs = 30 * 24 * accessMs;
export const oauthScopes = ['awb.read', 'offline_access'];
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const invalid = () => new InvalidGrantError('This authorization has expired or is no longer valid.');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

interface Flow {
  clientId: string; name: string; params: AuthorizationParams; resource: string; offline: boolean;
  binding: string; expires: number; userId?: string; email?: string;
}
interface Code { flow: Flow; userId: string; accountId: string; expires: number }

@Injectable()
export class McpOAuthService implements OAuthServerProvider {
  readonly clientsStore = mcpClients;
  private readonly flows = new Map<string, Flow>();
  private readonly codes = new Map<string, Code>();

  constructor(@InjectRepository(McpOAuthGrant) private readonly grants: Repository<McpOAuthGrant>,
    @InjectRepository(Account) private readonly accounts: Repository<Account>, private readonly access: AccountAccessService) {}

  private prune() {
    for (const [id, f] of this.flows) if (f.expires <= Date.now()) this.flows.delete(id);
    for (const [id, c] of this.codes) if (c.expires <= Date.now()) this.codes.delete(id);
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    const base = oauthBase();
    if (!base || !isValidCodeChallenge(params.codeChallenge)) throw invalid();
    const resource = base + '/mcp';
    if (params.resource && params.resource.href !== resource) throw new InvalidTargetError('Use the AWB MCP endpoint as the resource.');
    const scopes = params.scopes?.length ? params.scopes : oauthScopes;
    if (!scopes.includes('awb.read') || scopes.some(s => !oauthScopes.includes(s))) {
      throw new InvalidScopeError('Request awb.read and optionally offline_access.');
    }
    this.prune();
    if (this.flows.size + this.codes.size >= 2048) throw new TemporarilyUnavailableError('Try connecting again later.');
    const id = secret(), binding = secret();
    this.flows.set(id, { clientId: client.client_id, name: client.client_name!, params, resource, offline: scopes.includes('offline_access'),
      binding, expires: Date.now() + 10 * minute });
    res.cookie('awb_mcp_' + id, binding, { httpOnly: true, secure: base.startsWith('https:'), sameSite: 'lax',
      path: new URL(base + '/api/').pathname, maxAge: 10 * minute });
    res.set('Cache-Control', 'no-store').redirect(base + '/api/auth/oauth/google/start?mcp_request=' + id);
  }

  browserFlow(id: string, req: Request) {
    const flow = this.flows.get(id);
    const binding = (req.headers.cookie || '').split(/;\s*/).find(v => v.startsWith('awb_mcp_' + id + '='))?.split('=')[1];
    if (!flow || flow.expires <= Date.now() || flow.resource !== oauthBase() + '/mcp' || binding !== flow.binding) throw invalid();
    return flow;
  }

  identify(id: string, req: Request, userId: string, email: string) {
    const flow = this.browserFlow(id, req);
    if (flow.userId && flow.userId !== userId) throw invalid();
    flow.userId = userId;
    flow.email = email;
  }

  async choices(id: string, req: Request) {
    const flow = this.browserFlow(id, req);
    if (!flow.userId) throw invalid();
    const ids = await this.access.accessibleIds({ id: flow.userId, role: '' });
    return { flow, accounts: await this.accounts.find({ where: { id: In(ids) }, select: ['id', 'name'], order: { name: 'ASC' } }) };
  }

  finish(id: string, req: Request, accountId?: string) {
    const flow = this.browserFlow(id, req);
    this.flows.delete(id);
    const dest = new URL(flow.params.redirectUri);
    if (flow.params.state !== undefined) dest.searchParams.set('state', flow.params.state);
    dest.searchParams.set('iss', oauthBase());
    if (accountId && flow.userId) {
      const code = secret();
      this.codes.set(code, { flow, accountId, userId: flow.userId, expires: Date.now() + minute });
      dest.searchParams.set('code', code);
    } else dest.searchParams.set('error', 'access_denied');
    return dest.href;
  }

  private code(client: OAuthClientInformationFull, code: string) {
    const entry = this.codes.get(code);
    if (!entry || entry.expires <= Date.now() || entry.flow.clientId !== client.client_id || entry.flow.resource !== oauthBase() + '/mcp') throw invalid();
    return entry;
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) { return this.code(client, code).flow.params.codeChallenge; }

  private async owner(userId: string, accountId: string) {
    return (await this.access.usersWithAccess(accountId)).some(u => u.id === userId);
  }

  private refreshToken(row: McpOAuthGrant) {
    const tag = keyedDigest('mcp-oauth-refresh', JSON.stringify([row.id, row.client_id, row.resource, row.refresh_version]));
    return 'awbr_' + row.id + '.' + row.refresh_version + '.' + tag;
  }
  private tokenSet(row: McpOAuthGrant, accessToken: string) {
    return { token_type: 'Bearer', access_token: accessToken, expires_in: Math.max(0, Math.floor((row.access_expires_at.getTime() - Date.now()) / 1000)),
      scope: row.refresh_version ? oauthScopes.join(' ') : 'awb.read', ...(row.refresh_version ? { refresh_token: this.refreshToken(row) } : {}) };
  }
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL) {
    const entry = this.code(client, code);
    if (redirectUri !== entry.flow.params.redirectUri || (resource && entry.flow.resource !== resource.href)) throw invalid();
    this.codes.delete(code); // Consume before any async work, also for simultaneous exchanges.
    if (!await this.owner(entry.userId, entry.accountId)) throw invalid();
    const token = 'awbo_' + secret();
    const now = Date.now();
    const row = this.grants.create({ id: randomUUID(), user_id: entry.userId, account_id: entry.accountId,
      client_id: client.client_id, client_name: entry.flow.name, resource: entry.flow.resource, access_hash: digest(token),
      access_expires_at: new Date(now + accessMs), expires_at: new Date(now + (entry.flow.offline ? familyMs : accessMs)),
      refresh_version: entry.flow.offline ? 1 : 0 });
    await this.grants.insert(row);
    return this.tokenSet(row, token);
  }

  private async refreshGrant(client: OAuthClientInformationFull, token: string) {
    const match = /^awbr_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.([1-9]\d{0,9})\.([a-f0-9]{64})$/.exec(token);
    if (!match) return;
    const row = await this.grants.findOneBy({ id: match[1], client_id: client.client_id });
    if (!row || row.resource !== oauthBase() + '/mcp') return;
    const version = Number(match[2]);
    const expected = this.refreshToken({ ...row, refresh_version: version });
    if (!same(token, expected)) return;
    if (version !== row.refresh_version || row.expires_at.getTime() <= Date.now()) {
      await this.grants.delete(row.id); // A previously issued refresh token was reused.
      return;
    }
    return row;
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, token: string, scopes?: string[], resource?: URL) {
    if (scopes && (!scopes.includes('awb.read') || scopes.some(s => !oauthScopes.includes(s)))) {
      throw new InvalidScopeError('Request awb.read and optionally offline_access.');
    }
    if (resource && resource.href !== oauthBase() + '/mcp') throw new InvalidTargetError('Invalid resource.');
    const row = await this.refreshGrant(client, token);
    if (!row || !await this.owner(row.user_id, row.account_id)) throw invalid();
    const accessToken = 'awbo_' + secret();
    const next = { access_hash: digest(accessToken), access_expires_at: new Date(Math.min(Date.now() + accessMs, row.expires_at.getTime())),
      refresh_version: scopes && !scopes.includes('offline_access') ? 0 : row.refresh_version + 1 };
    const changed = await this.grants.update({ id: row.id, refresh_version: row.refresh_version }, next);
    if (changed.affected !== 1) {
      // Two requests may both read the current token before either rotates it.
      // Reuse retires the family even when it is detected by the atomic update.
      await this.grants.delete(row.id);
      throw invalid();
    }
    return this.tokenSet(Object.assign(row, next), accessToken);
  }

  async verifyAccessToken(token: string) {
    const row = /^awbo_[\w-]{43}$/.test(token) ? await this.grants.findOneBy({ access_hash: digest(token) }) : null;
    if (!row || row.resource !== oauthBase() + '/mcp' || row.access_expires_at.getTime() <= Date.now()
        || !await this.owner(row.user_id, row.account_id)) throw new InvalidTokenError('Expired or revoked AWB connection.');
    return { token, clientId: row.client_id, scopes: ['awb.read'], resource: new URL(row.resource), expiresAt: row.access_expires_at.getTime() / 1000,
      extra: { accountId: row.account_id, grantId: row.id } };
  }
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    if (request.token.startsWith('awbr_')) {
      const row = await this.refreshGrant(client, request.token);
      if (row) await this.grants.delete(row.id);
    } else await this.grants.delete({ client_id: client.client_id, access_hash: digest(request.token) });
  }
  list(user_id: string, account_id: string) {
    if (!user_id || !account_id) return [];
    return this.grants.createQueryBuilder('g').select(['g.id', 'g.client_name', 'g.expires_at']).where('g.user_id = :user_id AND g.account_id = :account_id AND g.expires_at > :now', { user_id, account_id, now: new Date() }).orderBy('g.created_at', 'DESC').getMany();
  }
  async disconnect(id: string, user_id: string, account_id: string) {
    if (user_id && account_id && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) {
      await this.grants.delete({ id, user_id, account_id });
    }
  }
}
