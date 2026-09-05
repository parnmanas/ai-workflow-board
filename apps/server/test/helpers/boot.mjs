// 공용 NestFactory 부팅 헬퍼.
//
// bootApp() — QA 테스트용 전체 HTTP 부팅. 모든 QA 테스트는 독립적으로 실행될
// 수 있도록 각자 고유 포트에 자신만의 NestJS 앱을 부팅한다. 이 모듈은
// proxy-passthrough.test.mjs / chat-roundtrip.test.mjs에 인라인으로 중복돼
// 있던 부팅/모듈로드 코드를 하나로 모은 것이다.
//
// 패턴: `const { app, port, modules } = await bootApp({ port: 7800 });`
// 이후 파일 끝에서 `t.after(() => app.close())` + `exitAfterTests()`.
//
// `port: 0` 을 넘기면 OS 가 빈 포트를 골라주고, 반환된 `port` 는 실제로 바인딩된
// 포트다 — 고정 포트를 쓰지 않으므로 같은 파일이 여러 번 부팅해도 앞 서버가
// 아직 소켓을 놓지 못한 상태와 경합하지 않는다(ticket 6a9a3fe4). 한 파일이 같은
// 고정 포트를 두 번 이상 바인딩해야 한다면 그건 `port: 0` 을 써야 한다는 신호다.
// `BASE_PORT + n` 이나 `parseInt(process.env.PORT, 10) + n` 으로 번호를 파생하는
// 것은 답이 아니다 — 그 번호는 소스 검색에 잡히지 않고, 아래에서 이 함수가 매
// 부팅마다 process.env.PORT 를 실제 바인딩 포트로 덮어쓰기 때문에 두 번째
// 파생부터는 의도한 번호에서 밀린다. test/boot-port-derivation-guard.test.mjs 가
// 이 패턴을 정적으로 막는다 (ticket 5db0964a).
//
// bootAppModuleOnly() — HTTP listen 없이 DI 그래프만 인스턴스화하는 부팅
// (아래 자체 doc comment 참고). nest-app-boot-smoke.test.mjs가 사용한다.

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
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
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
    // TypeORM auto-installs uuid-ossp in the first schema on search_path. In
    // the dialect matrix that would strand the extension in the first test's
    // disposable schema, making subsequent schemas unable to resolve
    // uuid_generate_v4(). Keep shared extensions in public explicitly.
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');
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
  // 격리 단위는 프로세스이지 부팅이 아니다 — 이 블록은 프로세스의 첫 bootApp()
  // 에서만 실행되므로(env 가 이미 있으면 건너뜀) 같은 파일의 두 번째 부팅은
  // 어차피 같은 DB 를 재사용한다. 그래서 `port: 0` 이라 키의 포트 자리가 늘
  // 0 이 되어도 프로세스 간 유일성은 pid 가 그대로 보장한다.
  if (!process.env.SQLJS_DB_PATH) {
    const isolated = path.join(os.tmpdir(), `awb-qa-${process.pid}-${port}.db`);
    try { fs.rmSync(isolated, { force: true }); } catch { /* best-effort */ }
    process.env.SQLJS_DB_PATH = isolated;
  }
  // Ontology Graph 자체 sql.js DataSource에도 같은 격리를 적용한다(ticket
  // 6ca4894a) — AppOntologyDataSource는 db.ts 모듈 로드 시점에
  // resolveOntologySqljsLocation()으로 생성되는데, SQLJS_ONTOLOGY_DB_PATH가
  // 없으면 공유 레포 레벨 database/ontology.db가 기본값이 된다. 이 격리가
  // 없으면 실제 AppModule을 부팅하는 모든 qa-flow 테스트 프로세스가
  // (OntologySqljsFlushService가 @Global SharedServicesModule에 있으므로)
  // 그 공유 파일 하나에 synchronize/flush하게 되고 — 같은 시각에 실제
  // `npm run dev` 서버가 떠 있으면 그것과도 충돌한다 — 바로 위
  // SQLJS_DB_PATH 격리가 primary DB를 위해 이미 막고 있는 것과 동일한
  // 다중 프로세스 충돌 클래스다.
  if (!process.env.SQLJS_ONTOLOGY_DB_PATH) {
    const isolatedOntology = path.join(os.tmpdir(), `awb-qa-ontology-${process.pid}-${port}.db`);
    try { fs.rmSync(isolatedOntology, { force: true }); } catch { /* best-effort */ }
    process.env.SQLJS_ONTOLOGY_DB_PATH = isolatedOntology;
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
  // 요청 포트가 아니라 **실제로 바인딩된** 포트를 회수해 돌려준다. `port: 0`
  // (OS 가 빈 포트 배정)을 호출자가 쓸 수 있게 하는 것이 목적이다 — 요청값을
  // 그대로 되돌려주면 0 이 나가 URL 을 만들 수 없다(ticket 6a9a3fe4). 고정
  // 포트를 넘긴 기존 호출자에게는 두 값이 같으므로 동작이 바뀌지 않는다.
  const boundPort = app.getHttpServer().address()?.port ?? port;
  process.env.PORT = String(boundPort);
  traceEvent('boot-ok', { port: boundPort, requested_port: port, duration_ms: Date.now() - t0 });
  return { app, port: boundPort, modules };
}

// 최소 부팅 — HTTP listen 없이 DI 그래프만 인스턴스화한다.
// nest-app-boot-smoke.test.mjs가 이 함수로 guard/provider 배선 버그(예:
// @UseGuards(PermissionGuard)를 쓰는 컨트롤러의 모듈이 PermissionGuard
// 자신의 의존성인 AuthGuard를 등록하지 않은 경우)를 잡아낸다 — NestJS DI는
// 컴파일이 아니라 런타임에 해석되므로 `tsc`는 이 문제를 볼 수 없다.
//
// abortOnError: false가 반드시 필요하다. 이게 없으면 배선 실패 시
// NestFactory.create가 UnknownDependenciesException을 스스로 로그만 찍고
// process.exit(1)을 직접 호출해버려 — 호출자의 try/catch를 건너뛰고
// node:test 워커 전체를 그대로 죽인다(assert 가능한 에러로 드러나지 않는다).
// 모듈의 guard provider를 일부러 깨뜨려, abortOnError:false 없이는 프로세스가
// 조용히 죽고 있으면 깔끔하게 예외가 던져지는 것을 직접 확인해 검증했다.
export async function bootAppModuleOnly({ logger = false } = {}) {
  process.env.DB_TYPE = process.env.DB_TYPE || 'sqlite';
  process.env.NODE_ENV = 'test';
  process.env.MCP_DEV_MODE = process.env.MCP_DEV_MODE || 'true';
  process.env.AGENT_DEV_MODE = process.env.AGENT_DEV_MODE || 'true';
  // bootApp()과 동일한 이유로 프로세스별 격리 sql.js DB를 만들되, pid로만
  // 키를 잡는다(이 부팅은 listen을 하지 않으므로 port가 없다).
  if (!process.env.SQLJS_DB_PATH) {
    const isolated = path.join(os.tmpdir(), `awb-boot-smoke-${process.pid}.db`);
    try { fs.rmSync(isolated, { force: true }); } catch { /* best-effort */ }
    process.env.SQLJS_DB_PATH = isolated;
  }
  if (!process.env.SQLJS_ONTOLOGY_DB_PATH) {
    const isolatedOntology = path.join(os.tmpdir(), `awb-boot-smoke-ontology-${process.pid}.db`);
    try { fs.rmSync(isolatedOntology, { force: true }); } catch { /* best-effort */ }
    process.env.SQLJS_ONTOLOGY_DB_PATH = isolatedOntology;
  }
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('file://' + path.join(DIST_ROOT, 'app.module.js'));
  return NestFactory.create(AppModule, { logger, abortOnError: false });
}

export async function closeTestApp(app) {
  await app.close().catch(() => {});
  if (process.platform === 'win32') {
    // Nest's close promise can settle one libuv turn before the underlying
    // HTTP server handle finishes closing. Let that callback drain before
    // node:test's --test-force-exit tears down the worker.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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
