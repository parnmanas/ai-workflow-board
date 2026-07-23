import { extname } from 'path';
import type { NextFunction, Request, Response } from 'express';
import type { INestApplication } from '@nestjs/common';

// A client-side (React Router) route refresh — e.g. /admin/workflow-health or
// /board/:ticketId — has no file extension and isn't under /api or /mcp. Every
// real route in this server lives under one of those two prefixes (see
// app.module.ts's ServeStaticModule exclude list), so this predicate can't
// shadow a real controller. A missing static asset (has an extension, e.g.
// /assets/old-hash.js after a redeploy) still falls through to a normal 404
// instead of silently returning HTML.
export function shouldServeIndexFallback(method: string, path: string): boolean {
  if (method !== 'GET') return false;
  if (path === '/api' || path.startsWith('/api/')) return false;
  if (path === '/mcp' || path.startsWith('/mcp/')) return false;
  return extname(path) === '';
}

// Single-port deployments (no separate SPA dev server, no reverse-proxy
// history-API fallback — docker-compose.yml/Dockerfile expose the NestJS
// server directly) 404 on a deep React Router link refresh without this.
//
// Must be mounted via app.use() BEFORE app.listen() with no preceding
// app.init() (see main.ts, next to the body parsers) — once Nest finishes
// initializing (either via an explicit app.init() or implicitly inside
// app.listen()), it registers its own catch-all that turns any unmatched
// route straight into a 404 without ever calling next(), so an app.use()
// added afterward never runs. This mirrors why the body parsers above must
// also be mounted early (ticket 7ba057fb; verified empirically — a fallback
// registered after an explicit app.init() was silently never invoked).
//
// { root } (not a bare absolute path) matters too: Express's `send` rejects
// any path containing a dotfile/dot-directory segment as 404 "Not Found"
// UNLESS root-scoped, and this repo's own worktrees live under `.awb/...` —
// a bare absolute sendFile() silently 404'd in every dev/agent worktree here
// (would have shipped invisibly broken outside a container's /app root).
export function applySpaFallback(app: INestApplication, clientDistRoot: string): void {
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!shouldServeIndexFallback(req.method, req.path)) {
      return next();
    }
    // Mirror ServeStaticModule's no-cache headers for .html (app.module.ts) —
    // otherwise a redeploy ships new hashed bundles but a cached fallback
    // response keeps pointing deep-linked pages at the old index.html.
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile('index.html', { root: clientDistRoot }, (err) => {
      if (err) next(err);
    });
  });
}
