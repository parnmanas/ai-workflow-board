// QA: security-inspection checklist model + refresh flow (ticket e1f1bb99 #knowledge).
//
// Covers the additions this ticket layers on the foundation (cfd74638):
//   • checklist item model carries `source` (evidence link) + `added_at` (freshness
//     stamp) — source is preserved, added_at is server-stamped when omitted and
//     preserved when supplied.
//   • refresh_security_checklist dispatches an agent task (room + prompt) WITHOUT
//     creating a SecurityRun, and the prompt instructs WebSearch of the current
//     OWASP Top 10 / stack CVE-GHSA / Node-Express guidance and a write-back via
//     update_security_profile, requiring a `source` per item.
//   • after the agent folds fresh items back in, the next start_security_run prompt
//     renders each item's source link.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { setupKanbanScene, createAgent, createApiKey } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.QA_SECURITY_REFRESH_PORT || '7837';

test('security checklist: source/added_at model + refresh_security_checklist dispatch + writeback', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { ws } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'sec-refresh' });
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'inspector' });
  const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label: 'inspector' });

  const mcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: key.raw_key });
  await mcp.initialize();

  step('create_security_profile with a baseline item carrying a source link');
  const profile = await mcp.callTool('create_security_profile', {
    workspace_id: ws.id,
    name: 'AWB self code-review',
    target_agent_id: agent.id,
    scan_driver: 'code-review',
    checklist: [
      {
        id: 'injection-sql',
        title: 'SQL injection',
        category: 'injection',
        severity_hint: 'critical',
        guidance: 'Use TypeORM parameter binding.',
        source: 'https://cwe.mitre.org/data/definitions/89.html',
        // added_at intentionally omitted → server should stamp it
      },
    ],
  });
  assert.ok(!profile.isError, `create failed: ${JSON.stringify(profile)}`);
  assert.equal(profile.checklist.length, 1);
  assert.equal(profile.checklist[0].source, 'https://cwe.mitre.org/data/definitions/89.html', 'source persisted');
  assert.ok(profile.checklist[0].added_at, 'added_at stamped when omitted');
  const stampedAddedAt = profile.checklist[0].added_at;

  step('refresh_security_checklist — dispatches a task (room + prompt), NO SecurityRun');
  const refresh = await mcp.callTool('refresh_security_checklist', { profile_id: profile.id });
  assert.ok(!refresh.isError, `refresh failed: ${JSON.stringify(refresh)}`);
  assert.ok(refresh.room_id, 'refresh created a ChatRoom');
  assert.equal(refresh.profile_id, profile.id);
  // The prompt is the heart of the agent-driven (no server feed) design:
  assert.match(refresh.prompt, /WebSearch/, 'prompt tells the agent to WebSearch');
  assert.match(refresh.prompt, /OWASP Top 10/, 'prompt covers OWASP Top 10');
  assert.match(refresh.prompt, /package\.json/, 'prompt tells the agent to read package.json for the stack');
  assert.match(refresh.prompt, /CVE\/GHSA|GHSA/, 'prompt covers stack CVE/GHSA advisories');
  assert.match(refresh.prompt, /Node\.js|Express/, 'prompt covers Node/Express advisories');
  assert.match(refresh.prompt, /update_security_profile/, 'prompt writes back via update_security_profile');
  assert.match(refresh.prompt, /REQUIRED for every item/, 'prompt requires a source link per item');

  // A refresh is not a run — the run history stays empty.
  const runsAfterRefresh = await mcp.callTool('list_security_runs', { profile_id: profile.id, workspace_id: ws.id });
  assert.ok(Array.isArray(runsAfterRefresh) && runsAfterRefresh.length === 0, 'refresh does not stack a SecurityRun');

  step('agent writeback: update_security_profile with merged checklist (preserve baseline + add fresh items)');
  const EXPLICIT_ADDED = '2026-06-20T00:00:00.000Z';
  const merged = await mcp.callTool('update_security_profile', {
    profile_id: profile.id,
    workspace_id: ws.id,
    checklist: [
      // baseline item carried through with its original added_at preserved
      {
        id: 'injection-sql',
        title: 'SQL injection',
        category: 'injection',
        severity_hint: 'critical',
        guidance: 'Use TypeORM parameter binding.',
        source: 'https://cwe.mitre.org/data/definitions/89.html',
        added_at: stampedAddedAt,
      },
      // freshly WebSearched OWASP item, source present, added_at omitted → stamped
      {
        id: 'ssrf',
        title: 'Server-Side Request Forgery',
        category: 'ssrf',
        severity_hint: 'high',
        guidance: 'Validate outbound URLs (git clone / fetch).',
        source: 'https://owasp.org/Top10/A10_2021-Server-Side_Request_Forgery_%28SSRF%29/',
      },
      // item with an explicit added_at → preserved verbatim
      {
        id: 'ghsa-example',
        title: 'Stack advisory follow-up',
        category: 'dependencies',
        severity_hint: 'medium',
        guidance: 'Check dependency advisory.',
        source: 'GHSA-xxxx-yyyy-zzzz',
        added_at: EXPLICIT_ADDED,
      },
    ],
  });
  assert.ok(!merged.isError, `update failed: ${JSON.stringify(merged)}`);
  assert.equal(merged.checklist.length, 3, 'full merged checklist replaced (3 items)');

  const byId = Object.fromEntries(merged.checklist.map((c) => [c.id, c]));
  assert.equal(byId['injection-sql'].added_at, stampedAddedAt, 'baseline added_at preserved across writeback');
  assert.ok(byId['ssrf'].source.includes('owasp.org'), 'fresh item keeps its source');
  assert.ok(byId['ssrf'].added_at, 'fresh item without added_at gets stamped');
  assert.equal(byId['ghsa-example'].added_at, EXPLICIT_ADDED, 'explicit added_at preserved verbatim');
  assert.equal(byId['ghsa-example'].source, 'GHSA-xxxx-yyyy-zzzz', 'bare CVE/GHSA id accepted as source');

  step('start_security_run prompt renders the checklist source links');
  const run = await mcp.callTool('start_security_run', { profile_id: profile.id });
  assert.ok(!run.isError, `start failed: ${JSON.stringify(run)}`);
  assert.match(run.prompt, /↳ source: https:\/\/cwe\.mitre\.org\/data\/definitions\/89\.html/, 'run prompt shows the SQLi source link');
  assert.match(run.prompt, /↳ source: GHSA-xxxx-yyyy-zzzz/, 'run prompt shows the GHSA source');

  await mcp.close();
  exitAfterTests(0);
});
