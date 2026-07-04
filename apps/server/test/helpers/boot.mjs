// Shared NestFactory boot for QA tests.
//
// Every QA test boots its own NestJS app on a unique port so tests can run
// independently. This module consolidates the repeated boot/module-load code
// that appeared inline in proxy-passthrough.test.mjs and chat-roundtrip.test.mjs.
//
// Pattern: `const { app, port, modules } = await bootApp({ port: 7800 });`
// then `t.after(() => app.close())` + `exitAfterTests()` at file end.

import fs from 'node:fs';
import os from 'node:os';
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
  const { ActionsService } = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'actions', 'actions.service.js')
  );
  const { HandoffService } = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'handoff', 'handoff.service.js')
  );
  const mcpTools = await import('file://' + path.join(DIST_ROOT, 'modules', 'mcp', 'mcp-tools.js'));
  return { NestFactory, AppModule, activityEvents, ActivityService, AuthService, ActionsService, HandoffService, getDataSourceToken, mcpTools };
}

// Create a fresh, isolated Postgres schema for this test process and point the
// datasource at it via DB_SCHEMA (read in buildDataSourceOptions). Drops any
// leftover schema of the same name first so a reused pid can't inherit stale
// tables. Connects with the raw `pg` driver because the TypeORM DataSource is
// not up yet at this boot stage. Postgres matrix only — see bootApp().
async function prepareIsolatedPgSchema(schema) {
  // Defensive identifier validation — schema is built from pid+port (always
  // safe) but never interpolate an unvalidated value into DDL.
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) {
    throw new Error(`unsafe pg schema name: ${schema}`);
  }
  const { Client } = await import('pg');
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'ai_workflow',
  });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await client.end();
  }
  process.env.DB_SCHEMA = schema;
  traceEvent('pg-schema-isolated', { schema });
}

export async function bootApp({ port = 7800, logger = false } = {}) {
  process.env.DB_TYPE = process.env.DB_TYPE || 'sqlite';
  process.env.NODE_ENV = 'test';
  process.env.MCP_DEV_MODE = process.env.MCP_DEV_MODE || 'true';
  process.env.AGENT_DEV_MODE = process.env.AGENT_DEV_MODE || 'true';
  process.env.PORT = String(port);
  // Hermetic sql.js DB per test process. The `test`/`test:qa` npm scripts chain
  // every flow file through ONE process each, but all default to `database/data.db`
  // — so two files in the run share a single on-disk DB and contaminate each
  // other (e.g. a later file reads an attachment a former file left behind).
  // resolveSqljsLocation() (db.ts) honors SQLJS_DB_PATH and the admin self-test
  // runner already sets it; here we give the npm-script path the same isolation
  // by defaulting to a unique temp DB keyed on pid+port. Callers that set
  // SQLJS_DB_PATH explicitly (qa.controller) keep their value. Start fresh so a
  // reused pid doesn't inherit a stale file.
  if (!process.env.SQLJS_DB_PATH) {
    const isolated = path.join(os.tmpdir(), `awb-qa-${process.pid}-${port}.db`);
    try { fs.rmSync(isolated, { force: true }); } catch { /* best-effort */ }
    process.env.SQLJS_DB_PATH = isolated;
  }
  // Postgres matrix (ticket 0c175408): the qa-flows suite chains every flow
  // file through its own process but they all connect to the SAME ephemeral CI
  // database — without per-process isolation they cross-contaminate the way the
  // shared data.db did before SQLJS_DB_PATH. Give each process a dedicated
  // Postgres schema (keyed on pid+port, like the sqljs temp path) and create it
  // up front so TypeORM synchronize builds the tables into it. No-op unless
  // DB_TYPE=postgres; production (DB_SCHEMA unset → 'public') is untouched.
  if (process.env.DB_TYPE === 'postgres' && !process.env.DB_SCHEMA) {
    await prepareIsolatedPgSchema(`qa_${process.pid}_${port}`);
  }
  // Auto-start the trace buffer so every helper below records into it
  // without the test author having to wire anything.
  startTrace({ testFile: process.env.QA_TEST_FILE });
  traceEvent('boot-start', { port });
  const t0 = Date.now();
  const modules = await loadServerModules();
  const app = await modules.NestFactory.create(modules.AppModule, { logger });
  // Mount the SAME body parsers main.ts wires (raw media-upload route + 10MB
  // json/urlencoded). NestFactory.create alone leaves only Express's stock
  // 100KB parser and NO raw route for /api/resources/upload, so raw-byte upload
  // tests saw an empty req.body and 400'd while production was fine. Must run
  // before app.listen (ticket 5e5959ef, comment-media-e2e).
  const { applyHttpBodyParsers } = await import(
    'file://' + path.join(DIST_ROOT, 'common', 'http-body-parsers.js')
  );
  applyHttpBodyParsers(app);
  // Mirror main.ts's global exception filter so error-path contracts (e.g. an
  // oversize body → clean 413 via entity.too.large, not an opaque 404/500) are
  // exercised against the same mapping production uses (ticket 5e5959ef).
  const { AllExceptionsFilter } = await import(
    'file://' + path.join(DIST_ROOT, 'common', 'filters', 'http-exception.filter.js')
  );
  const { LogService } = await import('file://' + path.join(DIST_ROOT, 'services', 'log.service.js'));
  const exceptionFilter = new AllExceptionsFilter();
  exceptionFilter.setLogService(app.get(LogService));
  app.useGlobalFilters(exceptionFilter);
  await app.listen(port, '0.0.0.0');
  traceEvent('boot-ok', { port, duration_ms: Date.now() - t0 });
  return { app, port, modules };
}

// Flushes the trace buffer to QA_TRACE_PATH so the parent qa.controller can
// attach it to the test result. Call at the END of a test's success path.
//
// IMPORTANT — this helper must NOT call process.exit. NestJS leaves unreffed
// intervals (AuthService session cleanup) and TypeORM pool handles that keep
// the event loop alive, so these tests are launched with `--test-force-exit`
// (see package.json + qa.controller). That flag tears the handles down AND
// exits with the real code node:test computed — 0 when every assertion held,
// non-zero when one failed. The previous `setImmediate(() => process.exit(0))`
// raced node:test's async completion and force-exited 0 BEFORE a failed
// assertion was recorded, so a deliberately broken test still reported green.
// Removing the exit hands the exit code back to node:test, restoring the gate.
//
// The legacy `code` argument is accepted-and-ignored (43 call sites pass `0`).
export function exitAfterTests() {
  try {
    writeTrace();
  } catch {
    /* best-effort */
  }
}

// Re-export so tests can import step() from boot.mjs without a separate
// import line. Keeps the existing test file footer pattern intact.
export { step } from './trace.mjs';
