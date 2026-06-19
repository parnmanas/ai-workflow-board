import { json, urlencoded, raw } from 'express';
import type { INestApplication } from '@nestjs/common';

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

  // Raise the JSON/urlencoded limit from Express's 100KB default to 10MB. Agent
  // plugins ship proxy.log error/event batches (up to 500 entries) that routinely
  // cross 100KB; the default silently bounced them as Express catch-all 404s.
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ limit: '10mb', extended: true }));

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
