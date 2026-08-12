// Static regression guard (ticket 7a4b14b4, review round 2): the
// hermes-live-chat-delivery seed scenario's Agent Logs lookup (step 5) must
// query by the owning Runtime Host's agent id, not the managed Hermes Agent's.
//
// error-log-uploader.ts uploads under the Runtime Host's OWN identity (see
// apps/agent-manager/src/lib/error-log-uploader.ts and the wire proof in
// apps/server/test/agent-error-logs-hermes.test.mjs) — a scenario that filters
// Agent Logs by the managed Hermes Agent's id would always see zero rows and
// false-fail even when the failure branch genuinely occurred and was logged
// correctly. This test pins the scenario data itself so a future edit can't
// silently regress back to the managed-agent id without a test failing.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', '..', 'dist');

test('hermes-live-chat-delivery seed scenario queries Agent Logs by the Runtime Host id, not the managed Hermes Agent id', async () => {
  const seed = await import(pathToFileURL(path.join(DIST, 'modules', 'qa', 'qa-seed-scenarios.js')).href);

  const scenario = seed.QA_SEED_SCENARIOS.find((s) => s.key === 'hermes-live-chat-delivery');
  assert.ok(scenario, 'hermes-live-chat-delivery scenario should exist in the seed catalogue');

  const step0 = scenario.steps.find((s) => s.idx === 0);
  assert.match(step0.action, /\{\{hermes_host_agent_id\}\}/,
    'step 0 must capture the owning Runtime Host id as {{hermes_host_agent_id}}, separate from {{hermes_agent_id}}');

  const step5 = scenario.steps.find((s) => s.idx === 5);
  assert.equal(step5.params.agent_id, '{{hermes_host_agent_id}}',
    'step 5 must filter Agent Logs by {{hermes_host_agent_id}} (the uploader\'s real identity), not {{hermes_agent_id}}');
  assert.doesNotMatch(step5.action, /agent_id=\{\{hermes_agent_id\}\}/,
    'step 5 action text must not instruct filtering by the managed Hermes Agent id');
});
