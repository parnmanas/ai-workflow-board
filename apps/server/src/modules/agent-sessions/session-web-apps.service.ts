import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Agent, fetch as directFetch } from 'undici';
import { createHash, randomBytes } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { AuthService } from '../../services/auth.service';
import { decryptStrict, encrypt } from '../../services/encryption.service';
import { AgentSessionError, AgentSessionsService } from './agent-sessions.service';
import type { PreviewSession } from './web-preview.service';

interface Registration {
  id: string;
  name: string;
  account_id: string;
  manager_id: string;
  cli: string;
  session_id: string;
  origin: string;
  document: string;
  routes: string[];
  cookie?: string;
}

const registryName = 'session-web-apps.json';
const documentLimit = 4 * 1024 * 1024;
const requestLimit = 32 * 1024;
const responseLimit = 1024 * 1024;
const idleMs = 15 * 60_000;
const routePattern = /^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/;
const cookieValue = /^[A-Za-z0-9._~+/=-]{1,512}$/;
const closed = () => new AgentSessionError(403, 'web_app_closed', 'Open the application again from your AWB session.');
const unavailable = () => new AgentSessionError(503, 'web_app_unavailable', 'The registered session application is unavailable.');
const loginFingerprint = (login: string) => createHash('sha256').update(login).digest('hex');
const scopeKey = (s: PreviewSession) => JSON.stringify([s.accountId, s.managerId, s.cli, s.sessionId, s.userId]);

async function readLimited(file: string, limit: number) {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw unavailable();
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit || offset !== stat.size) throw unavailable();
    return bytes.toString('utf8', 0, offset);
  } finally { await handle.close(); }
}

function validRegistration(app: Registration) {
  if (!app || typeof app !== 'object' || ![app.account_id, app.manager_id, app.cli, app.session_id, app.name, app.document].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256)
      || typeof app.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(app.id)
      || typeof app.origin !== 'string' || !URL.canParse(app.origin)
      || !Array.isArray(app.routes) || !app.routes.length || app.routes.length > 32 || !app.routes.every(p => typeof p === 'string' && p.length <= 256 && routePattern.test(p))
      || (app.cookie !== undefined && (typeof app.cookie !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(app.cookie)))) return false;
  const url = new URL(app.origin);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return /^https?:$/.test(url.protocol) && app.origin === url.origin && !!isIP(host)
    && Object.values(networkInterfaces()).some(iface => iface?.some(address => address.address === host));
}

function registrationsPath() {
  return process.env.AWB_SESSION_WEB_APPS_FILE || (process.env.AWB_DATA_DIR && join(process.env.AWB_DATA_DIR, registryName));
}

async function registrations(s: PreviewSession): Promise<Registration[]> {
  const file = registrationsPath();
  if (!file) return [];
  try {
    const list: unknown = JSON.parse(await readLimited(file, 64 * 1024)).apps;
    if (!Array.isArray(list) || list.length > 128) throw unavailable();
    const scoped = list.filter(a => a?.account_id === s.accountId && a.manager_id === s.managerId && a.cli === s.cli && a.session_id === s.sessionId);
    if (!scoped.every(validRegistration) || new Set(scoped.map(a => a.id)).size !== scoped.length) throw unavailable();
    return scoped;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw unavailable();
  }
}

async function readDocument(reg: Registration) {
  try {
    const dir = await realpath(dirname(resolve(registrationsPath()!)));
    const file = await realpath(resolve(dir, reg.document));
    if (!file.startsWith(dir + sep) || !file.endsWith('.html')) throw unavailable();
    return await readLimited(file, documentLimit);
  } catch { throw unavailable(); }
}

function credentialName(scope: string, app: Registration) {
  const digest = createHash('sha256').update(JSON.stringify([scope, app.id, app.origin, app.cookie])).digest('hex').slice(0, 32);
  return 'awb_web_app_' + digest;
}

function upstreamCookie(header: string, name: string) {
  const raw = header.split(/;\s*/).find(pair => pair.startsWith(name + '='))?.slice(name.length + 1);
  if (!raw || !/^[\w-]{1,2048}$/.test(raw)) return '';
  try {
    const encrypted = Buffer.from(raw, 'base64url').toString();
    if (!encrypted.startsWith('enc:')) return '';
    const [scope, value] = JSON.parse(decryptStrict(encrypted));
    return scope === name && typeof value === 'string' && cookieValue.test(value) ? value : '';
  } catch { return ''; }
}

function browserCookie(lines: string[], app: Registration, name: string) {
  if (!app.cookie) return;
  for (const line of lines) {
    const [pair, ...attrs] = line.split(/;\s*/);
    if (!pair.startsWith(app.cookie + '=')) continue;
    const value = pair.slice(app.cookie.length + 1);
    const age = attrs.find(a => /^max-age=-?\d+$/i.test(a));
    const expires = attrs.find(a => /^expires=/i.test(a));
    const lifetime = age ? Number(age.slice(8)) : expires ? (Date.parse(expires.slice(8)) - Date.now()) / 1000 : undefined;
    if (!value || (lifetime !== undefined && lifetime <= 0)) return { name, value: '', maxAge: 0 };
    if (!cookieValue.test(value)) continue;
    const sealed = Buffer.from(encrypt(JSON.stringify([name, value]))).toString('base64url');
    return { name, value: sealed, maxAge: lifetime !== undefined && Number.isFinite(lifetime) ? Math.min(lifetime, 365 * 86400) * 1000 : undefined };
  }
}

async function sendJson(dispatcher: Agent, app: Registration, path: string, json: string, cookie: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (cookie && app.cookie) headers.Cookie = app.cookie + '=' + cookie;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000).unref();
  try {
    const response = await directFetch(app.origin + path, { dispatcher, method: 'POST', headers, body: json, redirect: 'error', signal: controller.signal });
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || !response.body) throw unavailable();
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > responseLimit) throw unavailable();
      chunks.push(Buffer.from(value));
    }
    const body = Buffer.concat(chunks).toString();
    JSON.parse(body);
    return { status: response.status, body, cookies: response.headers.getSetCookie() };
  } catch { throw unavailable(); }
  finally { clearTimeout(timer); controller.abort(); }
}

@Injectable()
export class SessionWebAppsService implements OnModuleDestroy {
  // Private service credentials travel directly to a local interface, even when the process has an outbound proxy.
  private readonly upstream = new Agent({ connections: 4 });
  private readonly views = new Map<string, { scope: string; userId: string; loginFingerprint: string; registration: string; expires: number; pending: number }>();
  private pending = 0;

  constructor(private readonly sessions: AgentSessionsService, private readonly auth: AuthService) {}

  async onModuleDestroy() {
    this.views.clear();
    await this.upstream.destroy();
  }

  async options(s: PreviewSession) {
    const apps = (await registrations(s)).map(({ id, name }) => ({ id, name }));
    const active = [...this.views.values()].filter(v => v.scope === scopeKey(s) && v.expires > Date.now()).length;
    return { apps, active };
  }

  async open(s: PreviewSession, login: string, id: string) {
    const app = (await registrations(s)).find(a => a.id === id);
    if (!app) throw new AgentSessionError(404, 'web_app_not_found');
    await this.sessions.webPreviewPorts(s.accountId, s.managerId, s.cli, s.sessionId);
    const info = await this.sessions.readSessionInfo(s.accountId, s.userId, s.managerId, s.cli, s.sessionId);
    if (info.session?.session_id !== s.sessionId && !info.live) throw new AgentSessionError(404, 'session_not_found');
    const html = await readDocument(app);
    if (this.auth.validateSession(login)?.userId !== s.userId) throw closed();
    for (const [key, view] of this.views) if (view.expires <= Date.now()) this.views.delete(key);
    const scope = scopeKey(s);
    if (this.views.size >= 256 || [...this.views.values()].filter(v => v.userId === s.userId).length >= 12) throw new AgentSessionError(429, 'web_app_limit');
    const grant = randomBytes(32).toString('hex');
    this.views.set(grant, { scope, userId: s.userId, loginFingerprint: loginFingerprint(login), registration: JSON.stringify(app), expires: Date.now() + idleMs, pending: 0 });
    return { grant, html, name: app.name };
  }

  close(s: PreviewSession, grant?: string) {
    for (const [key, view] of this.views) if (view.scope === scopeKey(s) && (grant === undefined || key === grant)) this.views.delete(key);
  }

  async request(s: PreviewSession, login: string, id: string, input: { grant?: string; path?: string; body?: string } | undefined, cookies: string) {
    const grant = input?.grant || '';
    const view = this.views.get(grant);
    if (!view || view.scope !== scopeKey(s) || view.loginFingerprint !== loginFingerprint(login) || view.expires <= Date.now()) throw closed();
    if (view.pending >= 4 || this.pending >= 64) throw new AgentSessionError(429, 'web_app_busy');
    view.pending++;
    this.pending++;
    try {
      const app = (await registrations(s)).find(a => a.id === id);
      if (!app || JSON.stringify(app) !== view.registration) throw closed();
      const { path, body } = input!;
      if (typeof path !== 'string' || !app.routes.includes(path)) throw new AgentSessionError(403, 'web_app_route_denied');
      if (typeof body !== 'string' || Buffer.byteLength(body) > requestLimit) throw new AgentSessionError(413, 'web_app_body_invalid');
      try { JSON.parse(body); } catch { throw new AgentSessionError(400, 'web_app_body_invalid'); }
      await this.sessions.webPreviewPorts(s.accountId, s.managerId, s.cli, s.sessionId);
      const current = () => this.views.get(grant) === view && view.expires > Date.now() && this.auth.validateSession(login)?.userId === s.userId;
      if (!current()) throw closed();
      const name = credentialName(view.scope, app);
      const result = await sendJson(this.upstream, app, path, body, app.cookie ? upstreamCookie(cookies, name) : '');
      if (!current()) throw closed();
      view.expires = Date.now() + idleMs;
      return { status: result.status, body: result.body, cookie: browserCookie(result.cookies, app, name) };
    } finally { view.pending--; this.pending--; }
  }
}
