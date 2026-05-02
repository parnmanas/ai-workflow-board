import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { LOG_DIR, LOG_PATH } from './constants.js';

const LOG_MAX_BYTES = 5 * 1024 * 1024;

try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  /* ignore — fall back to stderr-only logging */
}

export function writeLogLine(line: string): void {
  try {
    const st = statSync(LOG_PATH);
    if (st.size > LOG_MAX_BYTES) {
      try {
        renameSync(LOG_PATH, LOG_PATH + '.1');
      } catch {
        /* ignore rotation failure */
      }
    }
  } catch {
    /* file may not exist yet */
  }
  try {
    appendFileSync(LOG_PATH, line);
  } catch {
    /* disk full / readonly fs / no perms */
  }
}

export function log(msg: string): void {
  const line = `[${new Date().toISOString()}] [pid=${process.pid}] ${msg}\n`;
  try {
    process.stderr.write(`[awb-agent-manager] ${msg}\n`);
  } catch {
    /* swallow — stderr loss is non-fatal */
  }
  writeLogLine(line);
}

let crashHandlersInstalled = false;

export function installCrashHandlers(): void {
  if (crashHandlersInstalled) return;
  crashHandlersInstalled = true;

  process.on('uncaughtException', (err: any) => {
    log(`Uncaught error: ${err?.stack || err?.message || err}`);
  });
  process.on('unhandledRejection', (err: any) => {
    log(`Unhandled rejection: ${err?.stack || err?.message || err}`);
  });
  process.on('exit', (code) => {
    writeLogLine(
      `[${new Date().toISOString()}] [pid=${process.pid}] EXIT code=${code}\n`,
    );
  });

  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => log(`Received ${sig}`));
  }
  if (process.platform !== 'win32') {
    process.on('SIGPIPE' as NodeJS.Signals, () => log('Received SIGPIPE'));
  }

  process.stdout.on('error', (err: any) => {
    log(`stdout error: code=${err?.code} msg=${err?.message}`);
    if (err?.code === 'EPIPE') process.exit(0);
  });
  process.stderr.on('error', () => {
    /* swallow — stderr loss is non-fatal */
  });
}
