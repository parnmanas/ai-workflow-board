import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { RequestLoggerInterceptor } from './common/interceptors/request-logger.interceptor';
import { ApiKeyService } from './services/api-key.service';
import { LogService } from './services/log.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: process.env.CORS_ORIGIN || true, // true = reflect request origin (dev); set CORS_ORIGIN in production
    credentials: true,
  });

  const logService = app.get(LogService);

  const exceptionFilter = new AllExceptionsFilter();
  exceptionFilter.setLogService(logService);
  app.useGlobalFilters(exceptionFilter);
  app.useGlobalInterceptors(new RequestLoggerInterceptor(logService));

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
  logService.info('System', `MCP auth: ${authStatus}`);
  logService.info('System', `API key management: http://localhost:${PORT}/api/keys`);
}
bootstrap();
