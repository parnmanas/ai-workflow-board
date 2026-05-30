import 'dotenv/config';
import 'reflect-metadata';
import { json, urlencoded } from 'express';
import compression from 'compression';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { RequestLoggerInterceptor } from './common/interceptors/request-logger.interceptor';
import { ApiKeyService } from './services/api-key.service';
import { LogService } from './services/log.service';
import { preSyncPostgres } from './database/pre-sync-postgres';
import { ensureSqljsDbHealthy } from './db';

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

  const app = await NestFactory.create(AppModule);

  // Raise Express body-parser limit from its 100KB default. Agent plugins
  // ship proxy.log error + event batches (up to 500 entries, each can carry
  // ~200 bytes of raw_line) — a routine batch crosses 100KB, which made the
  // default limit silently bounce uploads as 404 "Cannot POST" via Express's
  // catch-all route. Raised to 10MB; ingestEntries already caps entries at
  // 500 per upload so this is the natural ceiling, not a wildly permissive
  // attack surface.
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ limit: '10mb', extended: true }));

  // Gzip everything over 1KB. The MCP tools/list response alone is ~59KB
  // uncompressed; compression cuts it ~10x and stacks on top of the
  // tools/list cache (cache avoids re-serialization, gzip avoids
  // re-transmission). Threshold ignores tiny responses where the
  // compression overhead would outweigh the savings.
  app.use(compression({ threshold: 1024 }));

  app.enableCors({
    origin: process.env.CORS_ORIGIN || true, // true = reflect request origin (dev); set CORS_ORIGIN in production
    credentials: true,
  });

  const logService = app.get(LogService);

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
