// QA flow: worktree / merge convention board options (worktree 규약 chain, ticket 4ba844ea).
//
// Foundation of the chain — two board scalars (worktree_mode + use_pr) that
// follow-up tickets read through resolveBoardWorktreeMode / resolveBoardUsePr.
// This exercises the real end-to-end persistence path via the update_board MCP
// tool (the surface named in the DoD), not just the pure helpers:
//
// Acceptance:
//   1. A freshly-created board resolves to the regression baseline
//      per_ticket / false (columns auto-added by synchronize:true, DB defaults).
//   2. update_board {worktree_mode:'shared', use_pr:true} persists both — a
//      get_board round-trip reads them back.
//   3. Omitting a field on a later update_board leaves the stored value
//      untouched (no "clear" state — non-null scalars with a default).
//   4. An unknown worktree_mode is rejected (zod enum) rather than stored.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from '../helpers/boot.mjs';
import { setupKanbanScene, createAgentTrio } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';
import {
  resolveBoardWorktreeMode,
  resolveBoardUsePr,
} from '../../dist/common/worktree-config.js';

process.env.PORT = process.env.QA_WORKTREE_CONVENTION_PORT || '7842';

test('update_board round-trips worktree_mode + use_pr; defaults regress to per_ticket/false', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { ws, board } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'wt-convention',
  });
  const trio = await createAgentTrio(app, getDataSourceToken, ws.id);

  const mcp = new McpClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: trio.assignee.key.raw_key,
    clientInfo: { name: 'wt-convention-driver', version: '1.0.0' },
  });
  await mcp.initialize();
  t.after(async () => { await mcp.close(); });

  // (1) Regression baseline — a board that never set either field.
  const fresh = await mcp.callTool('get_board', { board_id: board.id });
  assert.equal(resolveBoardWorktreeMode(fresh.worktree_mode), 'per_ticket', 'default worktree_mode');
  assert.equal(resolveBoardUsePr(fresh.use_pr), false, 'default use_pr');

  // (2) Set both, assert the tool response + a fresh read both reflect it.
  const updated = await mcp.callTool('update_board', {
    board_id: board.id,
    worktree_mode: 'shared',
    use_pr: true,
  });
  assert.ok(!updated?.isError, `update_board should succeed: ${JSON.stringify(updated)}`);
  assert.equal(resolveBoardWorktreeMode(updated.worktree_mode), 'shared');
  assert.equal(resolveBoardUsePr(updated.use_pr), true);

  const afterSet = await mcp.callTool('get_board', { board_id: board.id });
  assert.equal(resolveBoardWorktreeMode(afterSet.worktree_mode), 'shared', 'worktree_mode persisted');
  assert.equal(resolveBoardUsePr(afterSet.use_pr), true, 'use_pr persisted');

  // (3) Omitting use_pr leaves it untouched (no clear state).
  const partial = await mcp.callTool('update_board', {
    board_id: board.id,
    worktree_mode: 'per_ticket',
  });
  assert.ok(!partial?.isError, `partial update should succeed: ${JSON.stringify(partial)}`);
  assert.equal(resolveBoardWorktreeMode(partial.worktree_mode), 'per_ticket', 'worktree_mode changed');
  assert.equal(resolveBoardUsePr(partial.use_pr), true, 'use_pr untouched by omission');

  // (4) Unknown worktree_mode is rejected by the zod enum, not stored.
  const bad = await mcp.callTool('update_board', {
    board_id: board.id,
    worktree_mode: 'per-ticket', // hyphen typo
  });
  assert.ok(bad?.isError, 'invalid worktree_mode must be rejected');

  const afterBad = await mcp.callTool('get_board', { board_id: board.id });
  assert.equal(resolveBoardWorktreeMode(afterBad.worktree_mode), 'per_ticket', 'rejected value not stored');
});
