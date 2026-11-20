import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isolatedPreviewDomain } from '../../common/web-preview-domain';
import { hasPermission, PERMISSIONS } from '../../common/types/permissions';
import { AccountAccessService } from '../../services/account-access.service';
import { AuthService } from '../../services/auth.service';
import { AgentSessionError, AgentSessionsService } from './agent-sessions.service';

export const PREVIEW_PREFIX = 'awb-preview-';
export const PREVIEW_OPEN_PATH = '/.awb-preview/open';
const HANDOFF_MS = 60_000;
const VIEW_MS = 15 * 60_000;
const MAX_BYTES = 8 * 1024 * 1024;

export interface PreviewSession {
  accountId: string;
  userId: string;
  managerId: string;
  cli: string;
  sessionId: string;
}

interface Grant extends PreviewSession {
  login: string;
  protocol: 'http:' | 'https:';
  host: 'localhost' | '127.0.0.1' | '[::1]';
  port: number;
  start: string;
  ticket: string;
  cookie: string;
  expires: number;
  pending: number;
}

function previewPath(value: unknown, fragment = false): value is string {
  return typeof value === 'string' && value.length <= 8192 && value.startsWith('/') && !value.startsWith('//')
    && !/[\\\x00-\x20\x7f-\uffff]/.test(value) && (fragment || !value.includes('#'));
}

function localTarget(address: unknown) {
  if (typeof address === 'string' && address.length <= 8192 && !/[\\\x00-\x20\x7f]/.test(address)
      && /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i.test(address) && URL.canParse(address)) {
    const url = new URL(address);
    const start = url.pathname + url.search + url.hash;
    if (previewPath(start, true)) return {
      protocol: url.protocol as Grant['protocol'], host: url.hostname as Grant['host'],
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), start,
    };
  }
  throw new AgentSessionError(400, 'preview_invalid', 'Enter an HTTP or HTTPS URL on localhost, 127.0.0.1 or [::1].');
}

function matches(secret: string, offered: unknown) {
  return !!secret && typeof offered === 'string' && /^[a-f0-9]{64}$/.test(offered)
    && timingSafeEqual(Buffer.from(secret), Buffer.from(offered));
}

function sameSession(a: PreviewSession, b: PreviewSession) {
  return a.accountId === b.accountId && a.userId === b.userId && a.managerId === b.managerId && a.cli === b.cli && a.sessionId === b.sessionId;
}

function noAccess() {
  return new AgentSessionError(403, 'preview_closed', 'Open the preview again from your AWB session.');
}

@Injectable()
export class WebPreviewService implements OnModuleDestroy {
  private readonly grants = new Map<string, Grant>();
  private readonly sweep = setInterval(() => {
    for (const [id, grant] of this.grants) if (grant.expires <= Date.now()) this.grants.delete(id);
  }, HANDOFF_MS).unref();
  private activeReads = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly sessions: AgentSessionsService, private readonly auth: AuthService, private readonly accounts: AccountAccessService) {}

  onModuleDestroy() {
    clearInterval(this.sweep);
    this.grants.clear();
  }

  async options(s: PreviewSession, awbOrigin: string) {
    const ports = await this.sessions.webPreviewPorts(s.accountId, s.managerId, s.cli, s.sessionId);
    const count = [...this.grants.values()].filter(g => sameSession(g, s) && g.expires > Date.now()).length;
    return { configured: !!isolatedPreviewDomain(awbOrigin), ports: ports ?? null, active: count };
  }

  async open(s: PreviewSession, login: string, address: unknown, awbOrigin: string) {
    const domain = isolatedPreviewDomain(awbOrigin);
    if (!domain) throw new AgentSessionError(503, 'preview_domain_required', 'Configure AWB_PREVIEW_DOMAIN on a separate HTTPS site.');
    const target = localTarget(address);
    const ports = await this.sessions.webPreviewPorts(s.accountId, s.managerId, s.cli, s.sessionId);
    if (!ports) throw new AgentSessionError(409, 'manager_outdated', 'Update the Agent Manager on this Runtime Host.');
    if (!ports.includes(target.port)) throw new AgentSessionError(403, 'preview_port_denied', 'Allow this port in web_preview_ports on the Runtime Host.');
    const info = await this.sessions.readSessionInfo(s.accountId, s.userId, s.managerId, s.cli, s.sessionId);
    if (info.session?.session_id !== s.sessionId && !info.live) throw new AgentSessionError(404, 'session_not_found');
    if (this.auth.validateSession(login)?.userId !== s.userId) throw noAccess();
    if (this.grants.size >= 256 || [...this.grants.values()].filter(g => g.userId === s.userId).length >= 12) {
      throw new AgentSessionError(429, 'preview_limit', 'Close an existing web preview and try again.');
    }
    const id = randomBytes(16).toString('hex');
    const ticket = randomBytes(32).toString('hex');
    this.grants.set(id, { ...s, ...target, login, ticket, cookie: '', expires: Date.now() + HANDOFF_MS, pending: 0 });
    return { action: 'https://' + PREVIEW_PREFIX + id + '.' + domain + PREVIEW_OPEN_PATH, ticket };
  }

  close(s: PreviewSession) {
    for (const [id, grant] of this.grants) if (sameSession(s, grant)) this.grants.delete(id);
    return { active: 0 };
  }

  private current(id: string) {
    const grant = this.grants.get(id);
    if (!grant || grant.expires <= Date.now() || this.auth.validateSession(grant.login)?.userId !== grant.userId) {
      this.grants.delete(id);
      throw noAccess();
    }
    return grant;
  }

  redeem(id: string, ticket: unknown) {
    const grant = this.current(id);
    if (!matches(grant.ticket, ticket)) throw noAccess();
    grant.ticket = '';
    grant.cookie = randomBytes(32).toString('hex');
    grant.expires = Date.now() + VIEW_MS;
    return { cookie: grant.cookie, path: grant.start, maxAge: VIEW_MS };
  }

  async resource(id: string, cookie: string, path: string, method: 'GET' | 'HEAD', signal?: AbortSignal) {
    const grant = this.current(id);
    if (!matches(grant.cookie, cookie)) throw noAccess();
    if (!previewPath(path)) throw new AgentSessionError(400, 'preview_invalid');
    // An HTTP/2 browser can request a whole module graph at once. Queue that burst while
    // bounding both buffered response bytes and how much work one preview can enqueue.
    if (grant.pending >= 192 || this.waiting.length >= 384) throw new AgentSessionError(429, 'preview_busy');
    grant.pending++;
    if (this.activeReads < 12) this.activeReads++;
    else await new Promise<void>(resolve => this.waiting.push(resolve));
    try {
      this.current(id);
      if (signal?.aborted) throw noAccess();
      const owner = (await this.accounts.usersWithAccess(grant.accountId)).find(u => u.id === grant.userId);
      if (!owner || !hasPermission(owner.role, JSON.parse(owner.permissions || '[]'), PERMISSIONS.USE_AGENT_SESSIONS)) {
        this.grants.delete(id);
        throw noAccess();
      }
      const result = await this.sessions.readWebPreview(grant.accountId, grant.userId, grant.managerId, grant.cli, grant.sessionId, {
        protocol: grant.protocol, host: grant.host, port: grant.port, path, method,
      });
      this.current(id); // Logout, expiry or an explicit close while the host was responding.
      if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status > 599) throw new AgentSessionError(422, 'invalid_preview_response');
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        if (!previewPath(result.location, true)) throw new AgentSessionError(422, 'invalid_preview_redirect');
        return { status: result.status, location: result.location };
      }
      if (typeof result.base64 !== 'string' || result.base64.length > 4 * Math.ceil(MAX_BYTES / 3)) throw new AgentSessionError(413, 'invalid_preview_body');
      const bytes = Buffer.from(result.base64, 'base64');
      if (bytes.length > MAX_BYTES) throw new AgentSessionError(413, 'invalid_preview_body');
      // Multipart responses can contain their own headers. Only ordinary web resources go to the browser.
      const mime = typeof result.mime_type === 'string' && result.mime_type.length <= 160
        && /^(?:(?:text|image|font|audio|video)\/[\w.+-]+|application\/(?:javascript|x-javascript|ecmascript|json|manifest\+json|wasm|octet-stream))(?:\s*;\s*charset=["']?[\w.-]+["']?)?$/i.test(result.mime_type)
        ? result.mime_type : 'application/octet-stream';
      return { status: result.status, bytes, mime };
    } finally {
      grant.pending--;
      const next = this.waiting.shift();
      if (next) next();
      else this.activeReads--;
    }
  }
}
