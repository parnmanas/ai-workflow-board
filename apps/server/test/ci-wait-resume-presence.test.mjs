// Regression-grep — ticket 778b6dc7 (durable CI-wait resume).
//
// Cheap static check that CiWaitResumeService / CiWaitService / the
// await_ci_run+cancel_ci_wait MCP tools are wired in the right places. The
// behavioural assertions live in test/ci-wait-resume.test.mjs; this file
// guards against refactors that delete the wiring (which would make the
// sweep silently never run, or leave the entity fields unreachable from the
// tool surface — the exact "session dies mid-wait and nobody notices"
// failure mode this ticket exists to fix, this time for the fix itself).
// Mirrors ci-health-monitor-presence.test.mjs's shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC_DIR = path.resolve(__dirname, '..', 'src');
const AGENTS_MODULE = path.join(SRC_DIR, 'modules', 'agents', 'agents.module.ts');
const RESUMER      = path.join(SRC_DIR, 'modules', 'agents', 'ci-wait-resume.service.ts');
const CI_WAIT_SVC  = path.join(SRC_DIR, 'modules', 'tickets', 'ci-wait.service.ts');
const CI_WAIT_TOOLS = path.join(SRC_DIR, 'modules', 'mcp', 'tools', 'ci-wait-tools.ts');
const TICKET_ENTITY = path.join(SRC_DIR, 'entities', 'Ticket.ts');
const GITHUB_CONN   = path.join(SRC_DIR, 'services', 'github-connector.service.ts');
const AUTHZ_GATE    = path.join(SRC_DIR, 'modules', 'mcp', 'shared', 'tool-authz-gate.ts');
const CONTEXT       = path.join(SRC_DIR, 'modules', 'mcp', 'tools', 'context.ts');
const MCP_CONTROLLER = path.join(SRC_DIR, 'modules', 'mcp', 'mcp.controller.ts');
const CAPTURE_MAP   = path.resolve(__dirname, '..', '..', 'agent-manager', 'src', 'lib', 'ticket-ref-capture.ts');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

test('Ticket entity defines pending_ci_wait + ci_wait_context', () => {
  const src = fs.readFileSync(TICKET_ENTITY, 'utf8');
  assert.match(src, /pending_ci_wait:\s*boolean/, 'must define pending_ci_wait column');
  assert.match(src, /ci_wait_context:\s*string/, 'must define ci_wait_context column');
});

test('GitHubConnectorService exposes getWorkflowRun()', () => {
  assert.ok(fs.existsSync(GITHUB_CONN), `expected ${GITHUB_CONN} to exist`);
  const code = stripComments(fs.readFileSync(GITHUB_CONN, 'utf8'));
  assert.match(code, /async\s+getWorkflowRun\s*\(/, 'must expose getWorkflowRun()');
  assert.match(code, /head_sha:/, 'GitHubWorkflowRun must carry head_sha for the registered-SHA cross-check');
});

test('CiWaitService source defines the register/cancel/atomic-claim surface', () => {
  assert.ok(fs.existsSync(CI_WAIT_SVC), `expected ${CI_WAIT_SVC} to exist`);
  const code = stripComments(fs.readFileSync(CI_WAIT_SVC, 'utf8'));
  assert.match(code, /class\s+CiWaitService/, 'must export CiWaitService class');
  assert.match(code, /async\s+registerWait\s*\(/, 'must expose registerWait()');
  assert.match(code, /async\s+cancelWait\s*\(/, 'must expose cancelWait()');
  assert.match(code, /async\s+claimResolved\s*\(/, 'must expose claimResolved() — the atomic exactly-once claim');
  // The atomic claim MUST include pending_ci_wait: true in the UPDATE
  // criteria (not just the id) — that's what makes it a conditional CAS
  // instead of an unconditional write two overlapping callers could both win.
  assert.match(
    code,
    /update\(\s*\{\s*id:\s*ticketId,\s*pending_ci_wait:\s*true\s*\}/,
    'claimResolved must condition the UPDATE on pending_ci_wait: true (CAS, not unconditional write)',
  );
});

test('CiWaitResumeService source defines the sweep loop, env config, and bounded timeout', () => {
  assert.ok(fs.existsSync(RESUMER), `expected ${RESUMER} to exist`);
  const code = stripComments(fs.readFileSync(RESUMER, 'utf8'));
  assert.match(code, /class\s+CiWaitResumeService/, 'must export CiWaitResumeService class');
  assert.match(code, /OnModuleInit/, 'must implement OnModuleInit so the sweep loop boots');
  assert.match(code, /OnModuleDestroy/, 'must implement OnModuleDestroy so the timer is torn down');
  assert.match(code, /setInterval\(/, 'sweep loop must use setInterval');
  assert.match(code, /\.unref\(/, 'sweep timer must be unref()\'d — an un-unref\'d interval hangs --test-force-exit-less runs');
  assert.match(code, /CI_WAIT_ENABLED/, 'must read CI_WAIT_ENABLED env var');
  assert.match(code, /CI_WAIT_SWEEP_MS/, 'must read CI_WAIT_SWEEP_MS env var');
  assert.match(code, /CI_WAIT_MAX_AGE_MS/, 'must read CI_WAIT_MAX_AGE_MS env var');
  // Exactly-once contract: the claim happens before either side effect.
  assert.match(code, /claimResolved\(ticket\.id\)/, 'must call the atomic claim before acting on a resolution');
  assert.match(code, /dispatchCurrentColumn\(/, 'must resume via TriggerLoopService.dispatchCurrentColumn');
});

test('ci-wait-tools.ts registers await_ci_run and cancel_ci_wait', () => {
  assert.ok(fs.existsSync(CI_WAIT_TOOLS), `expected ${CI_WAIT_TOOLS} to exist`);
  const code = stripComments(fs.readFileSync(CI_WAIT_TOOLS, 'utf8'));
  assert.match(code, /export\s+function\s+registerCiWaitTools\s*\(/, 'must export registerCiWaitTools (filename-convention auto-discovery)');
  assert.match(code, /server\.tool\(\s*\n?\s*'await_ci_run'/, 'must register await_ci_run');
  assert.match(code, /server\.tool\(\s*\n?\s*'cancel_ci_wait'/, 'must register cancel_ci_wait');
});

test('await_ci_run / cancel_ci_wait have an explicit authz tier (not silently unclassified)', () => {
  const code = stripComments(fs.readFileSync(AUTHZ_GATE, 'utf8'));
  assert.match(code, /await_ci_run:\s*'(full|caller)'/, 'await_ci_run must have an explicit TOOL_AUTHZ_TABLE tier');
  assert.match(code, /cancel_ci_wait:\s*'(full|caller)'/, 'cancel_ci_wait must have an explicit TOOL_AUTHZ_TABLE tier');
});

test('await_ci_run / cancel_ci_wait are classified in agent-manager\'s ticket-ref-capture map', () => {
  assert.ok(fs.existsSync(CAPTURE_MAP), `expected ${CAPTURE_MAP} to exist`);
  const code = stripComments(fs.readFileSync(CAPTURE_MAP, 'utf8'));
  assert.match(code, /await_ci_run:\s*'[a-z_]+'/, 'await_ci_run must be classified (EMIT category) or excluded with a reason');
  assert.match(code, /cancel_ci_wait:\s*'[a-z_]+'/, 'cancel_ci_wait must be classified (EMIT category) or excluded with a reason');
});

test('ToolContext wires ciWaitService in both NestJS and standalone construction', () => {
  const code = stripComments(fs.readFileSync(CONTEXT, 'utf8'));
  assert.match(code, /ciWaitService\?:\s*CiWaitService/, 'ToolContext interface must declare ciWaitService');
  assert.match(code, /new CiWaitService\(/, 'standalone context must construct a CiWaitService instance');
});

test('mcp.controller.ts injects CiWaitService and forwards it into ToolContext', () => {
  const code = stripComments(fs.readFileSync(MCP_CONTROLLER, 'utf8'));
  assert.match(code, /private readonly ciWaitService:\s*CiWaitService/, 'mcp.controller.ts must inject CiWaitService via DI');
  assert.match(code, /ciWaitService:\s*this\.ciWaitService/, 'buildToolContext() must forward ciWaitService');
});

test('agents.module.ts wires CiWaitResumeService and CiWaitService', () => {
  const code = stripComments(fs.readFileSync(AGENTS_MODULE, 'utf8'));
  assert.match(
    code,
    /import\s+\{\s*CiWaitResumeService\s*\}\s+from\s+['"]\.\/ci-wait-resume\.service['"]/,
    'AgentsModule must import CiWaitResumeService from sibling file',
  );
  assert.match(
    code,
    /import\s+\{\s*CiWaitService\s*\}\s+from\s+['"]\.\.\/tickets\/ci-wait\.service['"]/,
    'AgentsModule must import CiWaitService',
  );
  assert.match(code, /providers\s*:\s*\[[\s\S]*CiWaitResumeService/, 'must register CiWaitResumeService in providers');
  assert.match(code, /providers\s*:\s*\[[\s\S]*CiWaitService/, 'must register CiWaitService in providers');
  assert.match(code, /exports\s*:\s*\[[\s\S]*CiWaitResumeService/, 'must export CiWaitResumeService');
});

test('the ten pre-existing pending_on_tickets gate sites also check pending_ci_wait', () => {
  // Same-shape parity guard as the 13160d20-lineage seat-contract lessons —
  // one flag added everywhere the sibling flag is checked, not just the
  // headline chokepoint. Each entry pairs a file with a regex proving BOTH
  // flags appear in the same boolean expression / query chain.
  const sites = [
    {
      file: path.join(SRC_DIR, 'modules', 'agents', 'trigger-loop.service.ts'),
      patterns: [
        /pending_user_action \|\| ticket\.pending_on_tickets \|\| ticket\.pending_ci_wait\) \{/, // _autoAdvanceUnassigned
        /pending_user_action \|\| ticket\.pending_on_tickets \|\| ticket\.pending_ci_wait\) \{\s*\n\s*this\.logService\.info\('MCP', 'dispatchCurrentColumn/,
        /pending_user_action \|\| ticket\.pending_on_tickets \|\| ticket\.pending_ci_wait\) throw new Error\('Pending ticket cannot be redispatched'\)/,
        /!freshForGate\?\.pending_user_action && !freshForGate\?\.pending_on_tickets && !freshForGate\?\.pending_ci_wait\) return false/,
        /fresh\.pending_user_action \|\| fresh\.pending_on_tickets \|\| fresh\.pending_ci_wait \|\| fresh\.archived_at/,
      ],
    },
    {
      file: path.join(SRC_DIR, 'modules', 'agents', 'dispatch-reconciler.service.ts'),
      patterns: [
        /pending_user_action \|\| ticket\.pending_on_tickets \|\| ticket\.pending_ci_wait\)/g,
      ],
      minMatches: 2,
    },
    {
      file: path.join(SRC_DIR, 'modules', 'agents', 'stuck-ticket-detector.service.ts'),
      patterns: [
        /pending_user_action \|\| liveTicket\.pending_on_tickets \|\| liveTicket\.pending_ci_wait\)/,
        /if \(ticket\.pending_ci_wait\) return 'ci_wait'/,
      ],
    },
    {
      file: path.join(SRC_DIR, 'modules', 'agents', 'allocation.service.ts'),
      patterns: [/if \(\(ticket as any\)\.pending_ci_wait\) continue;/],
    },
    {
      file: path.join(SRC_DIR, 'modules', 'agents', 'backlog-promotion.service.ts'),
      patterns: [/\.andWhere\('t\.pending_ci_wait = :falseVal'/],
    },
    {
      file: path.join(SRC_DIR, 'modules', 'agents', 'agent-workload.service.ts'),
      patterns: [/\.andWhere\('t\.pending_ci_wait = :falseVal'\)/],
    },
  ];

  for (const site of sites) {
    const code = stripComments(fs.readFileSync(site.file, 'utf8'));
    for (const pattern of site.patterns) {
      if (pattern.global) {
        const matches = code.match(pattern) || [];
        const min = site.minMatches ?? 1;
        assert.ok(
          matches.length >= min,
          `${path.basename(site.file)}: expected >= ${min} matches for ${pattern}, found ${matches.length}`,
        );
      } else {
        assert.match(code, pattern, `${path.basename(site.file)}: missing pending_ci_wait parity for ${pattern}`);
      }
    }
  }
});

test('the pending-drop audit action is distinctly suffixed for the CI-wait flavor', () => {
  const code = stripComments(fs.readFileSync(path.join(SRC_DIR, 'modules', 'agents', 'trigger-loop.service.ts'), 'utf8'));
  const mentions = (code.match(/'agent_trigger_dropped_pending_ci'/g) || []).length;
  assert.equal(mentions, 1, 'the pending_ci drop action string must appear exactly once (inside _checkPendingUserGate)');
});
