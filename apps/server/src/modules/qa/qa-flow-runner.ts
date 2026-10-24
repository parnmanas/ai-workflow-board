import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export interface TraceEvent {
  t: number;
  type: string;
  [k: string]: any;
}

// ─── spawn runner ─────────────────────────────────────────────────────

interface FlowOutcome {
  status: 'PASS' | 'FAIL';
  duration_ms?: number;
  error?: string;
  detail?: string;
  trace?: TraceEvent[];
}

export async function runFlowFile(absTestPath: string): Promise<FlowOutcome> {
  let runDir: string | undefined;
  try {
    // mkdtemp reserves a fresh directory: neither server files nor another
    // concurrent flow can already occupy either child database path.
    runDir = await fs.promises.mkdtemp(path.resolve(os.tmpdir(), 'awb-qa-flow-'));
    return await spawnFlowFile(absTestPath, runDir);
  } catch (err) {
    return { status: 'FAIL', error: `Flow runner failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (runDir) {
      // Only reached after close (or a synchronous spawn failure), so the
      // child has finished flushing. Cleanup failure must not hide its result.
      try { await fs.promises.rm(runDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

function spawnFlowFile(absTestPath: string, runDir: string): Promise<FlowOutcome> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // Each test writes its trace buffer (every MCP request/response, every
    // SSE frame received, every step() marker, every DB fixture) to this
    // file via helpers/trace.mjs writeTrace() just before process.exit.
    // We read + unlink it after the subprocess finishes.
    const traceFile = path.join(runDir, 'trace.json');
    // Point sqljs at an isolated test DB file so concurrent writes from
    // the main server process don't clobber each other through autoSave.
    // For postgres/mysql this env does nothing (by design) and the caller
    // has already surfaced the warning to the UI.
    const env = {
      ...process.env,
      SQLJS_DB_PATH: path.join(runDir, 'data.db'),
      SQLJS_ONTOLOGY_DB_PATH: path.join(runDir, 'ontology.db'),
      // Prevent per-file PORT env from leaking into the child and colliding
      // with the main server — each flow file picks its own default port
      // (7801+) via QA_*_PORT envs inside the file.
      PORT: '',
      QA_TRACE_PATH: traceFile,
      QA_TEST_FILE: path.basename(absTestPath),
    };
    const proc = spawn(
      process.execPath,
      // --test-force-exit: the booted NestJS app leaves unreffed intervals
      // (AuthService session cleanup) + TypeORM pool handles that keep the
      // event loop alive, so node:test would otherwise hang. force-exit tears
      // them down AND exits with the REAL code (non-zero on a failed assertion)
      // — without it the flow files used to self-exit 0 and mask regressions.
      ['--test', '--test-force-exit', '--test-reporter=spec', absTestPath],
      {
        cwd: path.resolve(absTestPath, '..', '..', '..'),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    // Hard ceiling per file: 90s. Any individual flow test should finish
    // in under 10s — anything longer is a regression or a hang.
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
    }, 90_000);

    const readTrace = (): TraceEvent[] | undefined => {
      try {
        if (!fs.existsSync(traceFile)) return undefined;
        const raw = fs.readFileSync(traceFile, 'utf8');
        fs.unlinkSync(traceFile);
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : undefined;
      } catch {
        // Best-effort cleanup on parse failure — don't poison the test result.
        try { fs.unlinkSync(traceFile); } catch { /* ignore */ }
        return undefined;
      }
    };

    let spawnError: Error | undefined;
    proc.on('error', (err) => { spawnError = err; });

    proc.on('close', (code) => {
      clearTimeout(timer);
      const duration_ms = Date.now() - t0;
      const combined = (stdout + '\n' + stderr).trim();
      const trace = readTrace();

      if (spawnError) {
        return resolve({ status: 'FAIL', duration_ms, error: `spawn failed: ${spawnError.message}`, trace });
      }

      if (code === 0) {
        // Pull the one-line duration from the spec-reporter summary if present.
        const m = /duration_ms[\s\S]*?(\d+\.?\d*)/.exec(stdout);
        return resolve({
          status: 'PASS',
          duration_ms,
          detail: m ? `runner=${Math.round(parseFloat(m[1]))}ms` : undefined,
          trace,
        });
      }

      // FAIL: surface the error block. node --test spec reporter writes:
      //   ✖ <test name> (Xms)
      //     <assertion / stack>
      // Plus a final "failing tests:" section. We keep stdout intact for
      // copy/paste and additionally extract the most relevant slice for a
      // compact `error` field.
      const compact = extractFailureSummary(combined) ||
        `Exit code ${code ?? '(killed)'} with no parseable failure block.`;
      resolve({
        status: 'FAIL',
        duration_ms,
        error: compact,
        detail: combined.length > 8000 ? combined.slice(-8000) : combined,
        trace,
      });
    });
  });
}

// Grab the interesting error-bearing slice of the spec-reporter output.
// Prefer the "failing tests:" tail when it exists (richer context with the
// assertion stack), otherwise fall back to the first ✖ line.
function extractFailureSummary(output: string): string {
  const failHeaderIdx = output.indexOf('failing tests:');
  if (failHeaderIdx !== -1) {
    return output.slice(failHeaderIdx).trim().slice(0, 4000);
  }
  const lines = output.split('\n');
  const errLines: string[] = [];
  let collect = false;
  for (const line of lines) {
    if (/^\s*✖|AssertionError|^  Error:/.test(line)) collect = true;
    if (collect) errLines.push(line);
  }
  return errLines.join('\n').trim().slice(0, 4000);
}
