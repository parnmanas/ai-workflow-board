import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { runFlowFile, TraceEvent } from './qa-flow-runner';
import { AdminGuard } from '../../common/guards/admin.guard';

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
  cleanup: { account_deleted: boolean; error?: string };
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
  // isolate both sql.js databases in a fresh temporary directory per file.
  // Postgres users are warned in the response.
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
      // Flow suite doesn't create a shared scratch account (each file
      // owns its scene), so there's no single cleanup row to surface —
      // we just pass through a trivially-"clean" state for UI-shape parity.
      cleanup: { account_deleted: true },
      warnings: warnings.length ? warnings : undefined,
    };

    return res.json(report);
  }
}
