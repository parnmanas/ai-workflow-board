import type { INestApplication } from '@nestjs/common';
import { urlencoded, type Request, type Response, type NextFunction } from 'express';
import { AgentSessionError } from './agent-sessions.service';
import { PREVIEW_OPEN_PATH, PREVIEW_PREFIX, WebPreviewService } from './web-preview.service';
import { previewDomain } from '../../common/web-preview-domain';

const COOKIE = '__Host-awb-preview';
const FORM = urlencoded({ extended: false, inflate: false, limit: 256, parameterLimit: 1 });
const POLICY = [
  "sandbox allow-scripts allow-same-origin", "default-src 'none'", "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'", "connect-src 'self'", "img-src 'self' data: blob:",
  "font-src 'self' data:", "media-src 'self' blob:", "manifest-src 'self'", "base-uri 'self'",
  "form-action 'none'", "frame-ancestors 'none'", "worker-src 'none'",
].join('; ');

/** Mount before AWB's body parsers, static files, CORS and SPA fallback. Every path on a
 * preview hostname belongs exclusively to that preview, including /api, /mcp and /assets. */
export function applyWebPreview(app: INestApplication) {
  const previews = app.get(WebPreviewService);
  const domain = previewDomain();
  app.use((req: Request, res: Response, next: NextFunction) => {
    const authority = (req.headers.host || '').toLowerCase();
    const host = authority.split(':')[0].replace(/\.+$/, '');
    const reserved = host.startsWith(PREVIEW_PREFIX) || !!domain && (host === domain || host.endsWith('.' + domain));
    if (!reserved) return next();
    res.set({
      'Cache-Control': 'private, no-store', 'Content-Security-Policy': POLICY, 'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-DNS-Prefetch-Control': 'off',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
      'Strict-Transport-Security': 'max-age=31536000',
      'Origin-Agent-Cluster': '?1', 'X-Robots-Tag': 'noindex, nofollow',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=()',
    });
    const id = host.split('.')[0].slice(PREVIEW_PREFIX.length);
    const expected = PREVIEW_PREFIX + id + '.' + domain;
    if (!domain || !/^[a-f0-9]{32}$/.test(id) || (authority !== expected && authority !== expected + ':443')) {
      return res.status(404).end();
    }
    const fail = (err: unknown) => {
      if (res.destroyed) return;
      const known = err instanceof AgentSessionError;
      res.status(known ? err.status : 500).type('text/plain').send(known ? err.message : 'Web preview failed.');
    };
    if (req.url === PREVIEW_OPEN_PATH && req.method === 'POST') {
      return FORM(req, res, (err?: unknown) => {
        if (err) return res.status(400).end();
        try {
          const view = previews.redeem(id, req.body?.ticket);
          res.cookie(COOKIE, view.cookie, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: view.maxAge });
          res.status(303).set('Location', 'https://' + expected + view.path).end();
        } catch (error) { fail(error); }
      });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).set('Allow', 'GET, HEAD').end();
    if (req.headers['service-worker'] || req.headers.upgrade || req.headers['sec-fetch-dest'] === 'serviceworker') return res.status(403).end();
    const cookie = (req.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) ?? '';
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    void previews.resource(id, cookie, req.url, req.method, controller.signal).then(result => {
      if (res.destroyed) return;
      res.status(result.status);
      if (result.location) res.set('Location', 'https://' + expected + result.location);
      if (result.mime) res.setHeader('Content-Type', result.mime);
      res.end(req.method === 'HEAD' ? undefined : result.bytes);
    }).catch(fail);
  });
}
