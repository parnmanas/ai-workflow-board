// Regression-grep — ticket 8496e831 (supervisor staleness clock reset by
// death-triggered lock release).
//
// `AllocationService.getAllocatedTickets` computes `my_last_update_at`
// from the MAX of two sources: the agent's own comments and ActivityLog
// rows where `actor_id` is the agent. The activity query used to filter
// only on actor_id, so the lock-lifecycle rows the server itself emits
// (`trigger_source` of `agent_claim` / `agent_release`) — which include
// the force-release that fires when a manager crashes mid-session —
// were folded into the staleness clock. That reset
// `TicketSupervisorService`'s clock to the lock-death moment and
// silenced its force_respawn resend cadence for a full staleness window
// (default 30 min) right when it should have been firing.
//
// The fix is structural: the `latestActivity` query in
// allocation.service.ts must filter `trigger_source NOT IN
// ('agent_claim', 'agent_release')`. This test is the regression guard
// against a future refactor dropping that filter — it greps the source
// (after stripping comments so the prose in the file header doesn't
// false-positive) and fails if the filter or the lifecycle tokens are
// missing from the latestActivity block.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ALLOCATION = path.resolve(
  __dirname,
  '..',
  'src',
  'modules',
  'agents',
  'allocation.service.ts',
);

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

test('allocation.service.ts source exists', () => {
  assert.ok(fs.existsSync(ALLOCATION), `expected ${ALLOCATION} to exist`);
});

test('latestActivity query exists and is scoped to the agent', () => {
  const code = stripComments(fs.readFileSync(ALLOCATION, 'utf8'));
  assert.match(
    code,
    /const\s+latestActivity\s*=/,
    'latestActivity query must still be the source of activity-driven staleness',
  );
  assert.match(
    code,
    /a\.actor_id\s*=\s*:agentId/,
    'latestActivity must remain scoped to the calling agent via actor_id',
  );
});

test('latestActivity excludes agent_claim / agent_release lifecycle rows', () => {
  const code = stripComments(fs.readFileSync(ALLOCATION, 'utf8'));

  // Isolate the latestActivity builder so we assert against the right
  // query — otherwise a future filter applied to latestComments could
  // false-positive these checks.
  const block = code.slice(code.indexOf('const latestActivity'));
  assert.ok(block.length > 0, 'could not locate latestActivity block');

  assert.match(
    block,
    /trigger_source\s+NOT\s+IN/i,
    "latestActivity must apply a `trigger_source NOT IN (...)` filter so " +
      "lock-lifecycle bookkeeping doesn't contaminate my_last_update_at. " +
      "Without it a death-triggered force-release resets the supervisor's " +
      'staleness clock and silences force_respawn for a full window. ' +
      'See ticket 8496e831.',
  );

  for (const token of ['agent_claim', 'agent_release']) {
    assert.match(
      block,
      new RegExp(`['"]${token}['"]`),
      `latestActivity exclusion list must include '${token}' — both ` +
        'lock-lifecycle trigger_sources are server-emitted and would ' +
        "otherwise reset the supervisor's staleness clock on lock churn.",
    );
  }
});

test('agent comment path is still folded into staleness (regression guard)', () => {
  const code = stripComments(fs.readFileSync(ALLOCATION, 'utf8'));
  // The fix must not over-correct by also dropping the comment-driven
  // signal — agent comments are the strongest "the agent did real work"
  // marker, and the staleness clock would never advance during a long-
  // running task without them.
  assert.match(
    code,
    /const\s+latestComments\s*=/,
    'latestComments query must remain the primary "agent did work" signal',
  );
  assert.match(
    code,
    /c\.author_type\s*=\s*'agent'/,
    'latestComments must keep filtering to author_type=agent',
  );
});
