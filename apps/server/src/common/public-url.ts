import { BadRequestException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { SystemSetting } from '../entities/SystemSetting';

/**
 * The address people use to reach this AWB (links in notifications and mail, OAuth callbacks).
 *
 * Nobody should have to type it: the server learns it from what the browser actually used. Order:
 * `AWB_PUBLIC_URL` env (explicit deploy override) → Admin → Settings `server.public_url` → the origin
 * learned from an admin's browser (`server.public_url_detected`). An empty result means "not known
 * yet" — callers that cannot work without it say so; they never invent a host.
 */
export const PUBLIC_URL_SETTING = 'server.public_url';
export const PUBLIC_URL_DETECTED_SETTING = 'server.public_url_detected';

let configured = '';
let detected = '';
let store: DataSource | null = null;
let saving: Promise<unknown> | null = null;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const rank = (origin: string) => { const u = new URL(origin); return LOOPBACK.has(u.hostname) ? 0 : u.protocol === 'https:' ? 2 : 1; };

/** Origin of an http(s) URL without credentials, or ''. */
export function normalizePublicOrigin(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return '';
    return url.origin;
  } catch { return ''; }
}
/** An explicitly configured base may carry a path prefix (reverse proxy under /awb); keep it, drop the trailing slash. */
function normalizeConfiguredBase(value: unknown): string {
  if (!normalizePublicOrigin(value)) return '';
  const url = new URL(String(value).trim());
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** Base URL for links, without a trailing slash. '' = not known yet. */
export function publicBaseUrl(): string {
  return normalizeConfiguredBase(process.env.AWB_PUBLIC_URL) || configured || detected;
}

/**
 * The origin this browser request came from. The SPA's `Origin` (sent on POST) or `Referer` is what
 * the user actually typed — behind a dev proxy or tunnel the Host header can be an internal address.
 */
const header = (req: any, name: string) => { const v = req?.headers?.[name]; return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : ''; };
/** What the browser says it is on (`Origin` on POST, else `Referer`). Scripts and proxies usually send neither. */
function browserOrigin(req: any) { return normalizePublicOrigin(header(req, 'origin')) || normalizePublicOrigin(header(req, 'referer')); }

export function requestOrigin(req: any): string {
  const fromBrowser = browserOrigin(req);
  if (fromBrowser) return fromBrowser;
  const proto = header(req, 'x-forwarded-proto').split(',')[0].trim() || (req?.protocol as string) || 'http';
  const host = header(req, 'x-forwarded-host').split(',')[0].trim() || header(req, 'host');
  return host ? normalizePublicOrigin(`${proto}://${host}`) : '';
}

/** Load stored values once the DataSource is up; later writes keep this cache current. */
export async function bindPublicUrlStore(ds: DataSource) {
  store = ds;
  try {
    const rows = await ds.getRepository(SystemSetting).findBy([{ key: PUBLIC_URL_SETTING }, { key: PUBLIC_URL_DETECTED_SETTING }]);
    configured = normalizeConfiguredBase(rows.find(r => r.key === PUBLIC_URL_SETTING)?.value);
    detected = normalizePublicOrigin(rows.find(r => r.key === PUBLIC_URL_DETECTED_SETTING)?.value);
  } catch { /* Settings table unavailable (narrow test DataSource): stay with env/learned values. */ }
}

/** Admin → Settings saved a value (empty clears it). */
export function setConfiguredPublicUrl(value: string) { configured = normalizeConfiguredBase(value); }
export { normalizeConfiguredBase };

/**
 * Remember the origin an admin's browser used. Admins only: an ordinary account must not be able to
 * steer the links other people receive. Never throws — this runs inside request authentication.
 */
export function notePublicOrigin(req: any, role: string | undefined) {
  if (role !== 'admin') return;
  // Only a browser-reported origin: the Host header behind a tunnel or dev proxy is an internal address.
  const origin = browserOrigin(req);
  if (!origin || origin === detected) return;
  // Never downgrade: a loopback or plain-HTTP tab must not replace an HTTPS address learned earlier.
  if (detected && rank(origin) < rank(detected)) return;
  detected = origin;
  if (!store || saving) return;
  const repo = store.getRepository(SystemSetting);
  saving = repo.save({ key: PUBLIC_URL_DETECTED_SETTING, value: origin, description: 'Origin learned from an admin browser', is_secret: 0 })
    .catch(() => {}).finally(() => { saving = null; });
}

export function learnedPublicUrl() { return detected; }

/**
 * Origin an OAuth provider sends the browser back to. Prefer the origin of the browser that starts
 * sign-in (it reaches AWB there by definition); otherwise the known public address. Providers want
 * HTTPS; plain HTTP is accepted only on loopback outside production.
 */
export function oauthCallbackBase(origin?: string): string {
  const value = normalizePublicOrigin(origin) || normalizePublicOrigin(publicBaseUrl());
  if (value) {
    const url = new URL(value);
    if (url.protocol === 'https:' || (process.env.NODE_ENV !== 'production' && LOOPBACK.has(url.hostname))) return value;
  }
  throw new BadRequestException('이 AWB의 HTTPS 주소를 확인하지 못했습니다. HTTPS 주소로 AWB에 접속한 화면에서 다시 시도하세요.');
}
