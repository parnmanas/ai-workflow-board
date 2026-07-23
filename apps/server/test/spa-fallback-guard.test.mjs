// Unit test — `shouldServeIndexFallback` SPA-fallback route predicate (ticket
// 7ba057fb). Single-port deployments (no separate SPA dev server, no
// reverse-proxy history fallback) 404 on a refreshed deep React Router link
// (e.g. /admin/workflow-health, /board/:id) because ServeStaticModule only
// serves files that literally exist on disk. This guard decides which
// unmatched requests should fall back to index.html: GET, not under
// /api or /mcp, and no file extension (so a genuinely missing static asset
// still 404s instead of silently returning HTML).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');

const { shouldServeIndexFallback } = await import(
  'file://' + path.join(DIST_ROOT, 'common', 'spa-fallback.js')
);

test('shouldServeIndexFallback: client-side route refreshes fall back to index.html', () => {
  assert.equal(shouldServeIndexFallback('GET', '/'), true);
  assert.equal(shouldServeIndexFallback('GET', '/board'), true);
  assert.equal(shouldServeIndexFallback('GET', '/board/090abc77-5ff6-4515-929b-63d6a89ee6df'), true);
  assert.equal(shouldServeIndexFallback('GET', '/admin'), true);
  assert.equal(shouldServeIndexFallback('GET', '/admin/workflow-health'), true);
  assert.equal(shouldServeIndexFallback('GET', '/nonexistent-xyz'), true);
});

test('shouldServeIndexFallback: /api and /mcp are never intercepted', () => {
  assert.equal(shouldServeIndexFallback('GET', '/api'), false);
  assert.equal(shouldServeIndexFallback('GET', '/api/boards'), false);
  assert.equal(shouldServeIndexFallback('GET', '/api/boards/123'), false);
  assert.equal(shouldServeIndexFallback('GET', '/mcp'), false);
  assert.equal(shouldServeIndexFallback('GET', '/mcp/anything'), false);
  // Prefix without the separator must NOT be excluded by accident.
  assert.equal(shouldServeIndexFallback('GET', '/apiary'), true);
});

test('shouldServeIndexFallback: Swagger (/api-docs*) is never intercepted', () => {
  // /api-docs is a SIBLING of /api (SwaggerModule.setup('api-docs', ...) in
  // main.ts), not a child — 'startsWith(\'/api/\')' does not catch it, so it
  // needs its own exclusion. Regression for a review finding on ticket
  // 7ba057fb: without this, the SPA fallback (mounted ahead of Swagger in
  // main.ts) swallowed both the UI and the OpenAPI spec into index.html.
  assert.equal(shouldServeIndexFallback('GET', '/api-docs'), false);
  assert.equal(shouldServeIndexFallback('GET', '/api-docs-json'), false);
  assert.equal(shouldServeIndexFallback('GET', '/api-docs-yaml'), false);
});

test('shouldServeIndexFallback: paths with a file extension stay real 404s', () => {
  assert.equal(shouldServeIndexFallback('GET', '/assets/index-abc123.js'), false);
  assert.equal(shouldServeIndexFallback('GET', '/favicon.ico'), false);
  assert.equal(shouldServeIndexFallback('GET', '/robots.txt'), false);
});

test('shouldServeIndexFallback: only GET is eligible', () => {
  assert.equal(shouldServeIndexFallback('POST', '/board'), false);
  assert.equal(shouldServeIndexFallback('PUT', '/admin'), false);
  assert.equal(shouldServeIndexFallback('DELETE', '/nonexistent-xyz'), false);
});
