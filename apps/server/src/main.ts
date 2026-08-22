import 'dotenv/config';
import 'reflect-metadata';
import { join } from 'path';
import compression from 'compression';
import helmet from 'helmet';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { RequestLoggerInterceptor } from './common/interceptors/request-logger.interceptor';
import { ApiKeyService } from './services/api-key.service';
import { DeploymentService } from './modules/deployments/deployment.service';
import { LogService } from './services/log.service';
import { preSyncPostgres } from './database/pre-sync-postgres';
import { ensureSqljsDbHealthy, ensureOntologySqljsDbHealthy, preSyncSqljsOpenIntents } from './db';
import { applyHttpBodyParsers } from './common/http-body-parsers';
import { applySpaFallback } from './common/spa-fallback';

async function bootstrap() {
  // Runs BEFORE NestFactory so TypeORM's auto-synchronize doesn't trip on
  // the "column ... contains null values" blocker. Handles both the
  // type-mismatch rebuild path (uuid → varchar realignment) and lingering
  // NULL rows on NOT-NULL columns. No-op on sqlite/mysql.
  // See pre-sync-postgres.ts for the rationale.
  await preSyncPostgres();

  // Catch a corrupt dev sql.js data.db here, before NestFactory.create()
  // triggers DatabaseModule's TypeOrmModule.forRoot() — which would otherwise
  // hang ~25s on a malformed file (ticket e9847153). No-op on postgres/mysql.
  await ensureSqljsDbHealthy();

  // 두 번째 sql.js DataSource(database/ontology.db, ticket 6ca4894a)도 같은
  // 종류의 hang을 일으킬 수 있다 — NestFactory.create() 도중 DI 라이프사이클이
  // OntologySqljsFlushService.onModuleInit()을 거쳐 AppOntologyDataSource.initialize()를
  // 호출하기 때문이다. primary와 같은 시점(NestFactory.create() 이전)에 선제
  // 검사한다(ticket b646ed54).
  await ensureOntologySqljsDbHealthy();

  // Also before NestFactory (→ TypeOrmModule.forRoot → synchronize): collapse any
  // pre-existing duplicate OPEN dispatch_intents so the partial UNIQUE index this
  // ticket adds can be created without CREATE UNIQUE INDEX failing on legacy dup
  // rows and aborting boot. No-op on postgres/mysql (postgres handled in
  // preSyncPostgres above). Ticket 3c3b17a3.
  await preSyncSqljsOpenIntents();

  const app = await NestFactory.create(AppModule);

  // Listen for SIGTERM/SIGINT and await NestJS lifecycle hooks (onModuleDestroy)
  // before the process exits. Needed so SqljsFlushService gets its final flush
  // on a graceful stop (ticket d5a8594a — dev sql.js autoSave is off); also lets
  // every sweep service clear its timers cleanly. No-op effect on prod backends.
  app.enableShutdownHooks();

  // 보안 응답 헤더(M1) — nosniff/frameguard/HSTS 등은 helmet 기본값 그대로 전
  // 라우트에 적용한다. CSP는 별도 미들웨어로 분리해 /api-docs(Swagger UI, 인라인
  // script/style 필요)만 예외 처리한다 — helmet()을 두 번 체이닝하면 뒤쪽 인스턴스가
  // 앞쪽이 뺀 CSP 헤더를 다시 덮어써 예외가 무효화되므로, contentSecurityPolicy를
  // 아예 끈 기본 인스턴스 + 조건부 CSP 단독 미들웨어 조합으로 구성한다.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use((req: any, res: any, next: any) => {
    if (req.path.startsWith('/api-docs')) return next();
    return helmet.contentSecurityPolicy({
      useDefaults: true,
      directives: {
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    })(req, res, next);
  });

  // Body parsers (raw media-upload route + 10MB json/urlencoded). Shared with
  // the QA test harness (test/helpers/boot.mjs) via applyHttpBodyParsers so the
  // in-process test app parses bodies exactly like production. See ff3e7337
  // (base64→raw media upload) and 5e5959ef (test harness missing these parsers).
  applyHttpBodyParsers(app);

  // Gzip everything over 1KB. The MCP tools/list response alone is ~59KB
  // uncompressed; compression cuts it ~10x and stacks on top of the
  // tools/list cache (cache avoids re-serialization, gzip avoids
  // re-transmission). Threshold ignores tiny responses where the
  // compression overhead would outweigh the savings.
  //
  // Must be mounted BEFORE applySpaFallback below — compression patches
  // res.write/res.end to gzip on the way out, so it only affects responses
  // from middleware registered *after* it. Mounting it after the fallback
  // would leave every fallback-served index.html uncompressed (ticket
  // 7ba057fb review).
  app.use(compression({ threshold: 1024 }));

  // SPA fallback for deep React Router links (e.g. /admin/workflow-health,
  // /board/:ticketId) refreshed against a single-port deployment — see
  // spa-fallback.ts for why this must be mounted here (before Nest finishes
  // initializing) rather than after ServeStaticModule/app.listen(), which is
  // where it would conceptually belong (ticket 7ba057fb).
  applySpaFallback(app, join(__dirname, '..', '..', 'client', 'dist'));

  const logService = app.get(LogService);

  // CORS(L1) — CORS_ORIGIN이 설정되면 그 값을 그대로 쓴다(dev/운영 공통). 미설정 시
  // NODE_ENV=production이면 reflect-all(true)로 열어두지 않고 fail-closed(모든
  // 크로스오리진 요청 거부)한다 — credentials:true와 결합된 reflect-all은 임의
  // 사이트가 자격증명 포함 요청을 보낼 수 있게 하는 원인이었다. 개발 환경은
  // CORS_ORIGIN 없이도 기존처럼 reflect-all을 유지해 로컬 작업을 막지 않는다.
  const isProduction = process.env.NODE_ENV === 'production';
  const corsOrigin = process.env.CORS_ORIGIN;
  if (isProduction && !corsOrigin) {
    logService.warn('System', 'CORS_ORIGIN is not set in production — failing closed (all cross-origin requests will be rejected). Set CORS_ORIGIN to an explicit allowlist.');
  }
  app.enableCors({
    origin: corsOrigin || (isProduction ? false : true),
    credentials: true,
  });

  const exceptionFilter = new AllExceptionsFilter();
  exceptionFilter.setLogService(logService);
  app.useGlobalFilters(exceptionFilter);
  app.useGlobalInterceptors(new RequestLoggerInterceptor(logService));

  // Swagger (OpenAPI) docs at /api-docs. Covers the REST API only — MCP tools
  // live under /mcp and use JSON-RPC, which OpenAPI can't describe.
  // Session-token auth (Bearer) and agent API key (X-Agent-Key) are declared
  // as security schemes so "Authorize" works from the Swagger UI.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('AI Workflow Board — REST API')
    .setDescription(
      'Kanban + agent-operations REST endpoints. For MCP (JSON-RPC) tools see /mcp. ' +
      'Allocation polling (v0.25.0): GET /api/agents/:id/allocated-tickets is the ' +
      'REST counterpart of the MCP tool `get_allocated_tickets`.'
    )
    .setVersion('0.25.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'session-token' }, 'user-session')
    .addApiKey({ type: 'apiKey', name: 'X-Agent-Key', in: 'header' }, 'agent-api-key')
    .build();
  const swaggerDoc = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api-docs', app, swaggerDoc, {
    swaggerOptions: { persistAuthorization: true },
  });

  const PORT = process.env.PORT || 7701;
  await app.listen(PORT, '0.0.0.0');

  // Boot-time deployment self-report (ticket 8ce72b18, "배포 인지" DoD 2). Record
  // THIS server's own build commit as a GLOBAL deployment so a board that treats
  // the AWB server itself as the SUT can gate QA reruns on the deployment fact.
  // No-ops unless a build commit is resolvable from the env (AWB_BUILD_COMMIT or a
  // known CI/PaaS var); best-effort — never blocks or crashes boot.
  try {
    const deploymentService = app.get(DeploymentService);
    const dep = await deploymentService.recordSelfDeployment();
    if (dep) {
      logService.info('System', `Self-deployment recorded — env=${dep.environment} commit=${dep.deployed_commit_sha.slice(0, 12)}`);
    }
  } catch (err) {
    logService.warn('System', `Self-deployment record skipped: ${err}`);
  }

  // Check MCP auth status
  let authStatus = 'DISABLED (dev mode)';
  try {
    const apiKeyService = app.get(ApiKeyService);
    const keys = await apiKeyService.listApiKeys();
    const activeKeys = keys.filter((k: any) => k.is_active);
    const envKeys = (process.env.MCP_API_KEYS || '').split(',').filter(Boolean);
    if (activeKeys.length > 0 && envKeys.length > 0) {
      authStatus = `ENABLED (DB: ${activeKeys.length} keys + ENV: ${envKeys.length} keys)`;
    } else if (activeKeys.length > 0) {
      authStatus = `ENABLED (DB: ${activeKeys.length} active keys)`;
    } else if (envKeys.length > 0) {
      authStatus = `ENABLED (ENV: ${envKeys.length} keys)`;
    } else if (process.env.MCP_DEV_MODE === 'true') {
      authStatus = 'DISABLED (MCP_DEV_MODE=true — create API keys or set MCP_API_KEYS to enable)';
    } else {
      authStatus = 'BLOCKED (no API keys configured — create API keys, set MCP_API_KEYS, or set MCP_DEV_MODE=true)';
    }
  } catch (err) {
    logService.warn('System', `Failed to check MCP auth status: ${err}`);
  }

  logService.info('System', `AI Workflow Board server running on http://0.0.0.0:${PORT}`);
  logService.info('System', `MCP endpoint available at http://0.0.0.0:${PORT}/mcp`);
  logService.info('System', `Swagger (OpenAPI) docs at http://0.0.0.0:${PORT}/api-docs`);
  logService.info('System', `MCP auth: ${authStatus}`);
  logService.info('System', `API key management: http://localhost:${PORT}/api/keys`);
}
bootstrap();
