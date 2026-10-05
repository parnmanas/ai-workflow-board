import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { AdminGuard } from '../../common/guards/admin.guard';

interface TraceEvent {
  t: number;
  type: string;
  [k: string]: any;
}

interface TestResult {
  name: string;
  category: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  duration_ms: number;
  error?: string;
  detail?: string;
  // Structured event log captured by the test subprocess: step() markers,
  // fixture creations, SSE frames received, and MCP request/response pairs.
  // The UI renders this as an expandable timeline per test.
  trace?: TraceEvent[];
}

interface QAReport {
  run_at: string;
  duration_ms: number;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    pass_rate: string;
  };
  categories: Record<string, { passed: number; failed: number; skipped: number }>;
  results: TestResult[];
  cleanup: { workspace_deleted: boolean; error?: string };
}

@ApiBearerAuth('user-session')
@ApiTags('qa')
@Controller('api/admin/qa')
@UseGuards(AdminGuard)
export class QaController {
  // The in-process `POST run` smoke harness (it built a scratch "QA Board" +
  // columns and drove tickets through them) was removed with boards — the
  // flow suite below covers the same ground against a real booted app.

  // ─── Flow test runner ───────────────────────────────────────────────
  //
  // Spawns `node --test --test-force-exit --test-reporter=spec test/qa-flows/<file>` per
  // flow file and collects PASS/FAIL + error text. Each flow file boots
  // its own NestJS app on its own port; they never collide with the main
  // server on 7701, but they DO share the sqljs database file unless we
  // isolate it — so we point the subprocess at database/qa-flows.db via
  // SQLJS_DB_PATH (see db.ts). Postgres users are warned in the response.
  //
  // This exists so the admin UI can trigger the same suite CI uses
  // (npm run test:qa) without shelling out manually.
  @Post('run-flows')
  async runFlows(@Res() res: Response) {
    const startTime = Date.now();

    // Each file is a single test() block keyed on its filename, so we can
    // treat one-file = one-result without TAP-parsing subtests.
    const FLOW_FILES: Array<{ file: string; category: string }> = [
      { file: 'ticket-lifecycle.test.mjs', category: 'Flow-Lifecycle' },
      { file: 'self-trigger-guard.test.mjs', category: 'Flow-Lifecycle' },
      { file: 'comment-trigger.test.mjs', category: 'Flow-Comment' },
      { file: 'comment-mention.test.mjs', category: 'Flow-Comment' },
      { file: 'mcp-tools-surface.test.mjs', category: 'Flow-MCP' },
      { file: 'mcp-schema-version.test.mjs', category: 'Flow-MCP' },
      { file: 'mcp-agent-roundtrip.test.mjs', category: 'Flow-MCP' },
      { file: 'backlog-promotion-chain.test.mjs', category: 'Flow-Lifecycle' },
      { file: 'multi-agent-concurrency.test.mjs', category: 'Flow-Concurrency' },
      { file: 'multi-user-chat.test.mjs', category: 'Flow-Chat' },
      { file: 'chat-message-read.test.mjs', category: 'Flow-Chat' },
      { file: 'large-data.test.mjs', category: 'Flow-Scale' },
      { file: 'qa-run-lifecycle.test.mjs', category: 'Flow-QA' },
      { file: 'qa-evidence-gate.test.mjs', category: 'Flow-QA' },
      { file: 'qa-scenario-list-rollup.test.mjs', category: 'Flow-QA' },
      { file: 'qa-on-failure-ticket.test.mjs', category: 'Flow-QA' },
      { file: 'qa-rerun-on-fix.test.mjs', category: 'Flow-QA' },
      { file: 'qa-batch-sequencing.test.mjs', category: 'Flow-QA' },
    ];

    // Resolve the apps/server root from wherever this compiled file lives
    // (dist/modules/qa/qa.controller.js). The test files live at
    // <serverRoot>/test/qa-flows/*. A sanity check lets us fail fast with
    // a readable message when the build layout changes.
    const serverRoot = path.resolve(__dirname, '..', '..', '..');
    const testDir = path.join(serverRoot, 'test', 'qa-flows');
    if (!fs.existsSync(testDir)) {
      return res.status(500).json({
        error: 'QA flow tests directory not found',
        detail: `Expected ${testDir}. Run 'npm run build' at apps/server and make sure test/qa-flows/ is present.`,
      });
    }

    // Warn if not sqlite — flow tests run against whatever DB the main
    // process uses unless SQLJS_DB_PATH is wired, which only applies to
    // sqljs. For Postgres/MySQL deployments the operator must accept that
    // flow-test data lands in the live DB (tests use random UUIDs so it
    // doesn't corrupt existing records, but the rows linger).
    const dbType = process.env.DB_TYPE || 'sqlite';
    const warnings: string[] = [];
    if (dbType !== 'sqlite' && dbType !== 'sqljs') {
      warnings.push(
        `Flow tests are sharing the live ${dbType} database; test data (accounts/agents/tickets with UUID names) will remain unless you clean up manually.`,
      );
    }

    const results: TestResult[] = [];

    for (const { file, category } of FLOW_FILES) {
      const t0 = Date.now();
      const outcome = await runFlowFile(path.join(testDir, file));
      results.push({
        name: file.replace(/\.test\.mjs$/, ''),
        category,
        status: outcome.status,
        duration_ms: outcome.duration_ms ?? Date.now() - t0,
        error: outcome.error,
        detail: outcome.detail,
        trace: outcome.trace,
      });
    }

    const passed = results.filter((r) => r.status === 'PASS').length;
    const failed = results.filter((r) => r.status === 'FAIL').length;
    const skipped = results.filter((r) => r.status === 'SKIP').length;
    const total = results.length;

    const categories: Record<string, { passed: number; failed: number; skipped: number }> = {};
    for (const r of results) {
      if (!categories[r.category]) categories[r.category] = { passed: 0, failed: 0, skipped: 0 };
      if (r.status === 'PASS') categories[r.category].passed++;
      else if (r.status === 'FAIL') categories[r.category].failed++;
      else categories[r.category].skipped++;
    }

    const report: QAReport & { warnings?: string[] } = {
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      summary: {
        total,
        passed,
        failed,
        skipped,
        pass_rate: total > 0 ? `${Math.round((passed / total) * 100)}%` : '0%',
      },
      categories,
      results,
      // Flow suite doesn't create a shared scratch workspace (each file
      // owns its scene), so there's no single cleanup row to surface —
      // we just pass through a trivially-"clean" state for UI-shape parity.
      cleanup: { workspace_deleted: true },
      warnings: warnings.length ? warnings : undefined,
    };

    return res.json(report);
  }
}

// ─── spawn runner ─────────────────────────────────────────────────────

interface FlowOutcome {
  status: 'PASS' | 'FAIL';
  duration_ms?: number;
  error?: string;
  detail?: string;
  trace?: TraceEvent[];
}

function runFlowFile(absTestPath: string): Promise<FlowOutcome> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // Each test writes its trace buffer (every MCP request/response, every
    // SSE frame received, every step() marker, every DB fixture) to this
    // file via helpers/trace.mjs writeTrace() just before process.exit.
    // We read + unlink it after the subprocess finishes.
    const traceFile = path.join(
      os.tmpdir(),
      `qa-trace-${path.basename(absTestPath, '.test.mjs')}-${randomUUID()}.json`,
    );
    // Point sqljs at an isolated test DB file so concurrent writes from
    // the main server process don't clobber each other through autoSave.
    // For postgres/mysql this env does nothing (by design) and the caller
    // has already surfaced the warning to the UI.
    const env = {
      ...process.env,
      SQLJS_DB_PATH: process.env.SQLJS_DB_PATH || 'qa-flows.db',
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

    proc.on('close', (code) => {
      clearTimeout(timer);
      const duration_ms = Date.now() - t0;
      const combined = (stdout + '\n' + stderr).trim();
      const trace = readTrace();

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

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        status: 'FAIL',
        duration_ms: Date.now() - t0,
        error: `spawn failed: ${err.message}`,
        trace: readTrace(),
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
