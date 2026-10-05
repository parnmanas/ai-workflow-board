import { json, urlencoded, raw } from 'express';
import type { INestApplication } from '@nestjs/common';
import { normalizeOwnershipFields, withLegacyOwnershipFields } from './ownership-contract';

// Shared HTTP body-parser wiring for the Express adapter.
//
// Extracted from main.ts so the in-process QA test harness (test/helpers/boot.mjs)
// can mount the EXACT same parsers the production server does. Without this, a
// test app booted via NestFactory.create + app.listen has only Express's stock
// 100KB body parser and NO raw route for /api/resources/upload — so raw-byte
// media uploads arrived with an empty req.body and the handler 400'd
// ("request body is empty"), even though production was fine (ticket 5e5959ef,
// comment-media-e2e). Keep this the single source of truth for both call sites.
export function applyHttpBodyParsers(app: INestApplication): void {
  // Raw binary upload for media resources — mounted BEFORE the global json
  // parser and scoped to a single route so it claims that path's body as a
  // Buffer instead of letting json() try (and fail) to parse it. Raw bytes
  // carry no base64 inflation and stream straight through. Cap at 200MB —
  // generous for real attachments, still a bound. Overflow surfaces a clear
  // 413 (see AllExceptionsFilter's entity.too.large handling).
  app.use('/api/resources/upload', raw({ type: () => true, limit: '200mb' }));

  // 음성 발화 업로드(docs/voice-operator.md) — 같은 이유로 raw 로 잡는다. 녹음 한 건의 상한은
  // 2분이라(webm/opus ≈ 1MB/분) 25MB 면 넉넉하다.
  app.use('/api/voice/transcribe', raw({ type: () => true, limit: '25mb' }));
  app.use('/api/voice/lab/transcribe', raw({ type: () => true, limit: '25mb' }));
  app.use('/api/voice/speaker/enroll', raw({ type: () => true, limit: '25mb' }));

  // Raise the JSON/urlencoded limit from Express's 100KB default to 10MB. Agent
  // plugins ship proxy.log error/event batches (up to 500 entries) that routinely
  // cross 100KB; the default silently bounced them as Express catch-all 404s.
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ limit: '10mb', extended: true }));

  app.use((req: any, res: any, next: any) => {
    const legacyHeader = req.headers['x-workspace-id'];
    const query = req.query || {};
    const legacy = !!legacyHeader || query.workspace_id !== undefined || req.body?.workspace_id !== undefined
      || !!req.headers['x-agent-key'] || req.path === '/api/agent-manager/pair/redeem';
    if (!req.headers['x-account-id'] && legacyHeader) req.headers['x-account-id'] = legacyHeader;
    req.body = normalizeOwnershipFields(req.body);
    if (req.body?.method === 'tools/call' && req.body.params) {
      const params = req.body.params;
      params.arguments = normalizeOwnershipFields(params.arguments);
      const aliases: Record<string, string> = {
        list_workspaces: 'list_accounts', get_workspace: 'get_account', create_workspace: 'create_account',
        update_workspace: 'update_account', delete_workspace: 'delete_account',
        list_workspace_schedules: 'list_automation_schedules', get_workspace_schedule: 'get_automation_schedule',
        create_workspace_schedule: 'create_automation_schedule', update_workspace_schedule: 'update_automation_schedule',
        delete_workspace_schedule: 'delete_automation_schedule', run_workspace_schedule_now: 'run_automation_schedule_now',
      };
      if (aliases[params.name]) params.name = aliases[params.name];
    }
    Object.defineProperty(req, 'query', { value: normalizeOwnershipFields(query), configurable: true, writable: true });
    req.url = req.url.replace(/^\/api\/workspaces(?=\/|\?|$)/, '/api/accounts')
      .replace(/^\/api\/workspace-schedules(?=\/|\?|$)/, '/api/automation-schedules');
    if (legacy) {
      const json = res.json.bind(res);
      res.json = (value: any) => json(Array.isArray(value) ? value.map(withLegacyOwnershipFields) : withLegacyOwnershipFields(value));
    }
    next();
  });

  // Body-parser errors (e.g. PayloadTooLargeError / `entity.too.large` when a
  // body exceeds the limit above) are thrown from Express MIDDLEWARE — they
  // never enter the Nest execution context, so AllExceptionsFilter cannot see
  // them. Without this handler the request fell through to Express's default
  // 404 ("Cannot POST …"), so an oversize body was indistinguishable from a
  // wrong URL. Mounting an Express error-handling middleware right after the
  // parsers maps those to a clean 413 with a user-facing message (ticket
  // ff3e7337 intent; harness gap surfaced in 5e5959ef). Anything that isn't a
  // body-parser error is handed straight back to Nest's pipeline via next(err).
  app.use((err: any, _req: any, res: any, next: any) => {
    if (!err) return next();
    const status = err.status ?? err.statusCode;
    const isTooLarge = err.type === 'entity.too.large' || status === 413;
    if (isTooLarge) {
      return res
        .status(413)
        .json({ error: 'File too large — the upload exceeds the maximum allowed size.' });
    }
    return next(err);
  });
}
