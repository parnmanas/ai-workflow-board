import { extname } from 'path';
import type { NextFunction, Request, Response } from 'express';
import type { INestApplication } from '@nestjs/common';

// A client-side (React Router) route refresh — e.g. /admin/workflow-health or
// /board/:ticketId — has no file extension and isn't under /api, /mcp, or
// /api-docs. Every real route in this server lives under one of those
// prefixes (see app.module.ts's ServeStaticModule exclude list for /api and
// /mcp; /api-docs is Swagger, mounted separately in main.ts), so this
// predicate can't shadow a real controller. A missing static asset (has an
// extension, e.g. /assets/old-hash.js after a redeploy) still falls through
// to a normal 404 instead of silently returning HTML.
//
// /api-docs is a SIBLING of /api, not a child of it — 'startsWith(\'/api/\')'
// (with the trailing slash) doesn't catch it, so it needs its own exclusion.
// Without this, GET /api-docs and /api-docs-json pass the predicate (no
// extension) and the fallback mounted ahead of SwaggerModule.setup() in
// main.ts swallows both, returning index.html instead of the Swagger UI /
// OpenAPI spec (caught in review, ticket 7ba057fb).
export function shouldServeIndexFallback(method: string, path: string): boolean {
  if (method !== 'GET') return false;
  if (path === '/api' || path.startsWith('/api/')) return false;
  if (path === '/mcp' || path.startsWith('/mcp/')) return false;
  if (path === '/api-docs' || path.startsWith('/api-docs')) return false;
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
