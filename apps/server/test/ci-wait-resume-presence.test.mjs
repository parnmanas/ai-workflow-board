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

test('GitHubConnectorService exposes run-id/SHA format validators (ticket 778b6dc7 review round 1, P1)', () => {
  const code = stripComments(fs.readFileSync(GITHUB_CONN, 'utf8'));
  assert.match(code, /export\s+function\s+isValidGitHubRunId\s*\(/, 'must expose isValidGitHubRunId()');
  assert.match(code, /export\s+function\s+isValidGitSha\s*\(/, 'must expose isValidGitSha()');
});

test('CiWaitService.registerWait validates run_id and head_sha against their real external formats', () => {
  const code = stripComments(fs.readFileSync(CI_WAIT_SVC, 'utf8'));
  assert.match(code, /isValidGitHubRunId\(runId\)/, 'registerWait must validate run_id via isValidGitHubRunId — a bare non-empty check is not enough (review round 1 finding)');
  assert.match(code, /isValidGitSha\(headShaRaw\)/, 'registerWait must validate head_sha via isValidGitSha when provided');
});

test('CiWaitService source defines the register/cancel/lease-CAS surface', () => {
  assert.ok(fs.existsSync(CI_WAIT_SVC), `expected ${CI_WAIT_SVC} to exist`);
  const code = stripComments(fs.readFileSync(CI_WAIT_SVC, 'utf8'));
  assert.match(code, /class\s+CiWaitService/, 'must export CiWaitService class');
  assert.match(code, /async\s+registerWait\s*\(/, 'must expose registerWait()');
  assert.match(code, /async\s+cancelWait\s*\(/, 'must expose cancelWait()');
  // Lease-based durable outbox (ticket 778b6dc7 review rounds 1+2): the
  // generic mid-delivery CAS must NEVER clear pending_ci_wait (that would
  // repeat the round-1 bug — a crash between claim and side-effect losing
  // the resume forever); only markDelivered may clear it, and it must be
  // pinned to the exact finished context (round 2 — conditioning on
  // pending_ci_wait alone let a stale delivery clear a brand-new wait).
  assert.match(code, /async\s+tryUpdateContext\s*\(/, 'must expose tryUpdateContext() — the generic mid-delivery CAS that never clears pending_ci_wait');
  assert.match(code, /async\s+markDelivered\s*\(\s*ticketId:\s*string,\s*expectedContext:\s*string\s*\)/, 'markDelivered must take the expected finished context, not just a ticketId');
  assert.doesNotMatch(code, /async\s+claimResolved\s*\(/, 'the old single-step claimResolved() must be gone — it is the exact P0 bug the redesign replaces');
  assert.doesNotMatch(code, /async\s+tryRecordOutcome\s*\(/, 'the round-1-only tryRecordOutcome() must be gone — superseded by the generic tryUpdateContext()');

  const tryUpdateContextBody = code.slice(code.indexOf('async tryUpdateContext'), code.indexOf('async markDelivered'));
  assert.doesNotMatch(
    tryUpdateContextBody,
    /pending_ci_wait:\s*false/,
    'tryUpdateContext must NOT clear pending_ci_wait — clearing it here would reopen the P0 crash-loses-the-resume-forever bug',
  );
  assert.match(
    tryUpdateContextBody,
    /update\(\s*\{\s*id:\s*ticketId,\s*pending_ci_wait:\s*true,\s*ci_wait_context:\s*expectedPriorContext\s*\}/,
    'tryUpdateContext must CAS on the exact prior ci_wait_context (not just id) so two racing sweeps cannot both win',
  );

  const markDeliveredBody = code.slice(code.indexOf('async markDelivered'));
  assert.match(
    markDeliveredBody,
    /update\(\s*\{\s*id:\s*ticketId,\s*pending_ci_wait:\s*true,\s*ci_wait_context:\s*expectedContext\s*\}[\s\S]*?pending_ci_wait:\s*false/,
    'markDelivered must CAS on BOTH pending_ci_wait: true AND the exact expectedContext (review round 2) before clearing',
  );
});

test('CiWaitResumeService source defines the sweep loop, env config, bounded timeout, and the lease-based retry-safe delivery', () => {
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
  assert.doesNotMatch(code, /claimResolved\(/, 'must not call the removed single-step claimResolved()');
  assert.match(code, /tryUpdateContext\(/, 'must record the outcome and every delivery-flag flip via the generic CAS');
  assert.match(code, /markDelivered\(/, 'must clear the wait via the final CAS only after delivery is attempted');
  assert.match(code, /dispatchCurrentColumn\(/, 'must resume via TriggerLoopService.dispatchCurrentColumn');
  // Review round 2: outcome-present alone must not be sufficient to deliver —
  // a lease (owner + expiry) must gate entry, and durable per-step flags
  // must prevent re-doing a step that already succeeded.
  assert.match(code, /lease_owner/, 'delivery must be gated by a lease owner field');
  assert.match(code, /lease_expires_at/, 'the lease must carry an expiry so a crashed attempt is reclaimable');
  assert.match(code, /delivery_generation/, 'the lease must carry a generation bumped on each (re)claim');
  assert.match(code, /comment_posted/, 'comment delivery must be tracked by a durable flag, not a non-atomic query-then-act check');
  assert.match(code, /dispatch_done/, 'dispatch delivery must be tracked by a durable flag');
  assert.doesNotMatch(code, /_hasResolutionComment/, 'the round-1 query-based idempotency check must be gone — comment_posted is now the sole source of truth (round 2 finding: query-then-act was itself racy)');

  const deliverBody = code.slice(code.indexOf('private async _deliver'));
  // Lease pre-check: a fresh (unexpired) lease owned by someone else must
  // short-circuit BEFORE any CAS attempt.
  assert.match(deliverBody, /leaseExpiresMs > nowMs/, 'must check the in-memory lease expiry before attempting to claim, so a fresh lease is left alone');
  // The comment try/catch and the dispatch try/catch must each `return`
  // WITHOUT calling markDelivered on failure — that's what makes a partial
  // (comment-succeeded, dispatch-failed) delivery retryable instead of lost.
  const commentSection = deliverBody.slice(
    deliverBody.indexOf('if (!workingOutcome.comment_posted)'),
    deliverBody.indexOf('if (!workingOutcome.dispatch_done)'),
  );
  const commentCatch = commentSection.slice(commentSection.indexOf('} catch (e) {'));
  assert.match(commentCatch, /return;/, 'comment-write failure must return early (not call markDelivered) so the lease expires and the next sweep retries the whole delivery');
  const dispatchSection = deliverBody.slice(deliverBody.indexOf('if (!workingOutcome.dispatch_done)'));
  const dispatchCatch = dispatchSection.slice(dispatchSection.indexOf('} catch (e) {'), dispatchSection.indexOf('markDelivered'));
  assert.match(dispatchCatch, /return;/, 'dispatch failure must return early (not call markDelivered) so the lease expires and the next sweep retries just the dispatch');
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
