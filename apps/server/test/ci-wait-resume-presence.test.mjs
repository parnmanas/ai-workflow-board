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

test('CiWaitService source defines the register/cancel/transactional-claim surface', () => {
  assert.ok(fs.existsSync(CI_WAIT_SVC), `expected ${CI_WAIT_SVC} to exist`);
  const code = stripComments(fs.readFileSync(CI_WAIT_SVC, 'utf8'));
  assert.match(code, /class\s+CiWaitService/, 'must export CiWaitService class');
  assert.match(code, /async\s+registerWait\s*\(/, 'must expose registerWait()');
  assert.match(code, /async\s+cancelWait\s*\(/, 'must expose cancelWait()');
  // Transactional delivery claim (ticket 778b6dc7 review round 3): the
  // phase-1 CAS must NEVER clear pending_ci_wait (round 1 — a crash between
  // claim and side-effect must not lose the resume forever); only
  // claimDelivery may clear it, and it must do so in the SAME DB
  // transaction as the caller's side effect (round 3 — two separate durable
  // writes, however leased/sequenced, can never fully close the
  // crash-between-them window; only a transaction can).
  assert.match(code, /async\s+tryUpdateContext\s*\(/, 'must expose tryUpdateContext() — the phase-1 CAS that never clears pending_ci_wait');
  assert.match(code, /async\s+claimDelivery\s*\(\s*ticketId:\s*string,\s*expectedContext:\s*string,\s*withinTx:/, 'claimDelivery must take the expected finished context AND a withinTx callback run on the same transaction manager');
  assert.doesNotMatch(code, /async\s+claimResolved\s*\(/, 'the round-1 single-step claimResolved() must be gone');
  assert.doesNotMatch(code, /async\s+tryRecordOutcome\s*\(/, 'the round-1-only tryRecordOutcome() must be gone — superseded by the generic tryUpdateContext()');
  assert.doesNotMatch(code, /async\s+markDelivered\s*\(/, 'the round-2 markDelivered() (a SEPARATE CAS from the side effect) must be gone — superseded by claimDelivery\'s single transaction');
  assert.doesNotMatch(code, /lease_owner|lease_expires_at|delivery_generation/, 'the round-2 lease fields must be gone — a transaction replaces coordination-by-lease entirely');

  const tryUpdateContextBody = code.slice(code.indexOf('async tryUpdateContext'), code.indexOf('async claimDelivery'));
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

  const claimDeliveryBody = code.slice(code.indexOf('async claimDelivery'));
  assert.match(claimDeliveryBody, /this\.dataSource\.transaction\(/, 'claimDelivery must run inside a single DB transaction');
  assert.match(
    claimDeliveryBody,
    /manager\.getRepository\(Ticket\)\.update\(\s*\{\s*id:\s*ticketId,\s*pending_ci_wait:\s*true,\s*ci_wait_context:\s*expectedContext\s*\}[\s\S]*?pending_ci_wait:\s*false/,
    'claimDelivery must CAS on BOTH pending_ci_wait: true AND the exact expectedContext (review round 2) using the transaction manager, before clearing',
  );
  assert.match(claimDeliveryBody, /await\s+withinTx\(manager\)/, 'the caller\'s side effect must run with the SAME transaction manager, not a fresh connection — that is what makes it atomic with the CAS (review round 3)');
});

test('CiWaitResumeService source defines the sweep loop, env config, bounded timeout, and the transactional-claim delivery', () => {
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
  assert.doesNotMatch(code, /markDelivered\(/, 'must not call the removed round-2 markDelivered() — claimDelivery replaces it');
  assert.doesNotMatch(code, /lease_owner|lease_expires_at|delivery_generation/, 'the round-2 lease fields must be gone from the resumer too');
  assert.match(code, /tryUpdateContext\(/, 'must record the outcome via the phase-1 CAS');
  assert.match(code, /claimDelivery\(/, 'must claim delivery (CAS + side effect, one transaction) via CiWaitService.claimDelivery');
  assert.match(code, /dispatchCurrentColumn\(/, 'must resume via TriggerLoopService.dispatchCurrentColumn');
  // Review round 3: the comment insert must carry a globally-unique dedupe
  // key on the SAME nullable-unique idempotency column the silent-exit
  // fallback already uses — defense in depth alongside the transaction.
  assert.match(code, /operational_recurrence_key/, 'the resolution comment must carry a dedupe key for defense-in-depth idempotency');
  assert.match(code, /\.orIgnore\(\)/, 'the comment insert must use insert-or-ignore so a hypothetical duplicate attempt cannot throw/duplicate');

  const deliverBody = code.slice(code.indexOf('private async _deliver'));
  assert.match(deliverBody, /claimDelivery\(ticket\.id,\s*rawContext,/, '_deliver must claim delivery keyed on the exact rawContext it was given');
  assert.match(deliverBody, /if\s*\(!claimed\)\s*return;/, '_deliver must stop when the claim is lost (already delivered, or racing attempt won)');

  // Ordering (review round 3 latent bug): dispatchCurrentColumn refuses to
  // emit while pending_ci_wait is still true (trigger-loop.service.ts's
  // pending gate), so the dispatch call MUST textually follow the
  // claimDelivery call (which durably clears the flag first), never precede
  // it — an earlier draft called dispatch before the claim and was always a
  // silent no-op against the real gate.
  const claimIdx = deliverBody.indexOf('claimDelivery(');
  const dispatchIdx = deliverBody.indexOf('dispatchCurrentColumn(');
  assert.ok(claimIdx >= 0 && dispatchIdx >= 0, 'both claimDelivery and dispatchCurrentColumn calls must be present in _deliver');
  assert.ok(dispatchIdx > claimIdx, 'dispatchCurrentColumn must be called AFTER claimDelivery — pending_ci_wait must already be false or the real gate silently drops the dispatch');
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
  // headline chokepoint. Each entry pairs a file with a regex proving the
  // flags appear in the same boolean expression / query chain.
  //
  // ticket e630b530 이 `pending_merge_lease`(랜딩 lease 대기)를 네 번째
  // flavor 로 추가하면서 패턴을 확장했다 — CI-wait parity 요구는 그대로 두고
  // 신규 flavor 를 **함께** 요구하도록 강화한 것이지 완화한 것이 아니다.
  // 어느 한 flavor 라도 한 지점에서 빠지면 여기서 걸린다.
  const sites = [
    {
      file: path.join(SRC_DIR, 'modules', 'agents', 'trigger-loop.service.ts'),
      patterns: [
        /pending_user_action \|\| ticket\.pending_on_tickets \|\| ticket\.pending_ci_wait \|\| ticket\.pending_merge_lease\) \{/, // _autoAdvanceUnassigned
        /pending_user_action \|\| ticket\.pending_on_tickets \|\| ticket\.pending_ci_wait \|\| ticket\.pending_merge_lease\) \{\s*\n\s*this\.logService\.info\('MCP', 'dispatchCurrentColumn/,
        /pending_user_action \|\| ticket\.pending_on_tickets \|\| ticket\.pending_ci_wait \|\| ticket\.pending_merge_lease\) throw new Error\('Pending ticket cannot be redispatched'\)/,
        /!freshForGate\?\.pending_user_action && !freshForGate\?\.pending_on_tickets && !freshForGate\?\.pending_ci_wait && !freshForGate\?\.pending_merge_lease\) return false/,
        /fresh\.pending_user_action \|\| fresh\.pending_on_tickets \|\| fresh\.pending_ci_wait \|\| fresh\.pending_merge_lease \|\| fresh\.archived_at/,
      ],
    },
    {
      file: path.join(SRC_DIR, 'modules', 'agents', 'dispatch-reconciler.service.ts'),
      patterns: [
        /pending_user_action \|\| ticket\.pending_on_tickets \|\| ticket\.pending_ci_wait \|\| ticket\.pending_merge_lease\)/g,
      ],
      minMatches: 2,
    },
    {
      file: path.join(SRC_DIR, 'modules', 'agents', 'stuck-ticket-detector.service.ts'),
      patterns: [
        /pending_user_action \|\| liveTicket\.pending_on_tickets \|\| liveTicket\.pending_ci_wait \|\| liveTicket\.pending_merge_lease\)/,
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
