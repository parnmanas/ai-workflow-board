// Shared NestFactory boot for QA tests.
//
// Every QA test boots its own NestJS app on a unique port so tests can run
// independently. This module consolidates the repeated boot/module-load code
// that appeared inline in proxy-passthrough.test.mjs and chat-roundtrip.test.mjs.
//
// Pattern: `const { app, port, modules } = await bootApp({ port: 7800 });`
// then `t.after(() => app.close())` + `exitAfterTests()` at file end.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTrace, traceEvent, writeTrace } from './trace.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', '..', 'dist');

export async function loadServerModules() {
  const { NestFactory } = await import('@nestjs/core');
  const { getDataSourceToken } = await import('@nestjs/typeorm');
  const { AppModule } = await import('file://' + path.join(DIST_ROOT, 'app.module.js'));
  const { activityEvents, ActivityService } = await import(
    'file://' + path.join(DIST_ROOT, 'services', 'activity.service.js')
  );
  const { AuthService } = await import('file://' + path.join(DIST_ROOT, 'services', 'auth.service.js'));
  const mcpTools = await import('file://' + path.join(DIST_ROOT, 'modules', 'mcp', 'mcp-tools.js'));
  return { NestFactory, AppModule, activityEvents, ActivityService, AuthService, getDataSourceToken, mcpTools };
}

export async function bootApp({ port = 7800, logger = false } = {}) {
  process.env.DB_TYPE = process.env.DB_TYPE || 'sqlite';
  process.env.NODE_ENV = 'test';
  process.env.MCP_DEV_MODE = process.env.MCP_DEV_MODE || 'true';
  process.env.AGENT_DEV_MODE = process.env.AGENT_DEV_MODE || 'true';
  process.env.PORT = String(port);
  // Auto-start the trace buffer so every helper below records into it
  // without the test author having to wire anything.
  startTrace({ testFile: process.env.QA_TEST_FILE });
  traceEvent('boot-start', { port });
  const t0 = Date.now();
  const modules = await loadServerModules();
  const app = await modules.NestFactory.create(modules.AppModule, { logger });
  await app.listen(port, '0.0.0.0');
  traceEvent('boot-ok', { port, duration_ms: Date.now() - t0 });
  return { app, port, modules };
}

// NestJS leaves unreffed intervals (AuthService session cleanup) and TypeORM
// pool handles that keep the event loop alive. Existing leak tests solve this
// by forcing process.exit after all tests complete. Mirror that pattern.
// Also flushes the trace buffer to QA_TRACE_PATH so the parent qa.controller
// can attach it to the test result.
export function exitAfterTests(code = 0) {
  try {
    writeTrace();
  } catch {
    /* best-effort */
  }
  setImmediate(() => process.exit(code));
}

// Re-export so tests can import step() from boot.mjs without a separate
// import line. Keeps the existing test file footer pattern intact.
export { step } from './trace.mjs';
