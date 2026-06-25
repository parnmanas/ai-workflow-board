#!/usr/bin/env node
// Seed the security-inspection catalogue into a live AWB workspace (ticket cfd74638).
//
// Idempotent: matches existing profiles by their stable `key:<key>` tag and
// UPDATEs in place, otherwise CREATEs. Re-running never duplicates. Mirrors
// scripts/seed-qa-scenarios.mjs.
//
// Drives the AWB MCP surface over HTTP (create/update/list_security_profile),
// reusing the canonical test MCP client. Authenticate with an agent API key
// (Bearer) or run against a server in MCP_DEV_MODE.
//
// Usage:
//   node apps/server/scripts/seed-security-profiles.mjs \
//     --base-url http://localhost:7701 \
//     --workspace <workspace_id> \
//     --agent <target_agent_id> \
//     [--board <board_id>] \
//     [--resource <target_resource_id>] \
//     [--api-key <key>] \
//     [--only awb-self-code-review] \
//     [--dry-run]
//
// Env fallbacks: AWB_BASE_URL, AWB_WORKSPACE_ID, AWB_SECURITY_AGENT_ID, AWB_BOARD_ID, AWB_API_KEY.
//
// Build first so dist/ has the catalogue: (cd apps/server && npm run build)

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpClient } from '../test/helpers/mcp-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'dry-run') { out.dryRun = true; continue; }
    out[key] = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args['base-url'] || process.env.AWB_BASE_URL || 'http://localhost:7701';
  const workspaceId = args.workspace || process.env.AWB_WORKSPACE_ID;
  const agentId = args.agent || process.env.AWB_SECURITY_AGENT_ID;
  const boardId = args.board || process.env.AWB_BOARD_ID || null;
  const resourceId = args.resource || null;
  const apiKey = args['api-key'] || process.env.AWB_API_KEY || '';
  const only = args.only ? String(args.only).split(',').map((s) => s.trim()).filter(Boolean) : undefined;

  if (!workspaceId || !agentId) {
    console.error('ERROR: --workspace <id> and --agent <target_agent_id> are required.\n');
    console.error('See the header of this file for usage.');
    process.exit(2);
  }

  // Pull the catalogue from the compiled server bundle (single source of truth).
  const seedModUrl = pathToFileURL(path.join(DIST, 'modules', 'security', 'security-seed-profiles.js')).href;
  const { buildProfileCreatePayloads, keyTag } = await import(seedModUrl).catch((e) => {
    console.error(`ERROR: could not import compiled catalogue at ${seedModUrl}`);
    console.error('Build the server first: (cd apps/server && npm run build)');
    console.error(String(e?.message || e));
    process.exit(2);
  });

  const payloads = buildProfileCreatePayloads({
    workspace_id: workspaceId,
    target_agent_id: agentId,
    board_id: boardId,
    target_resource_id: resourceId,
    created_by: 'seed-security-profiles',
    only,
  });

  console.log(`Seeding ${payloads.length} security profile(s) → workspace ${workspaceId}`
    + (boardId ? ` board ${boardId}` : ' (workspace-scope)')
    + (only ? ` [filter: ${only.join(', ')}]` : '')
    + (args.dryRun ? '  [DRY RUN]' : ''));

  const mcp = new McpClient({ baseUrl, apiKey, clientInfo: { name: 'seed-security-profiles', version: '1.0.0' } });
  await mcp.initialize();

  // Existing profiles in the same scope, indexed by their key tag.
  const listScope = boardId ? boardId : '';
  const existing = await mcp.callTool('list_security_profiles', { workspace_id: workspaceId, board_id: listScope });
  if (existing?.isError) throw new Error(`list_security_profiles failed: ${JSON.stringify(existing.error)}`);
  const byKey = new Map();
  for (const s of Array.isArray(existing) ? existing : []) {
    const tag = (s.tags || []).find((t) => typeof t === 'string' && t.startsWith('key:'));
    if (tag) byKey.set(tag.slice(4), s);
  }

  let created = 0, updated = 0;
  for (const p of payloads) {
    const { _key, ...payload } = p;
    const prior = byKey.get(_key);
    if (args.dryRun) {
      console.log(`  ${prior ? 'UPDATE' : 'CREATE'}  ${_key.padEnd(32)} ${payload.name}`);
      continue;
    }
    if (prior) {
      const res = await mcp.callTool('update_security_profile', { profile_id: prior.id, workspace_id: workspaceId, ...payload });
      if (res?.isError) throw new Error(`update ${_key} failed: ${JSON.stringify(res.error)}`);
      updated++;
      console.log(`  UPDATED  ${_key.padEnd(32)} ${res.id}`);
    } else {
      const res = await mcp.callTool('create_security_profile', payload);
      if (res?.isError) throw new Error(`create ${_key} failed: ${JSON.stringify(res.error)}`);
      created++;
      byKey.set(_key, res);
      console.log(`  CREATED  ${_key.padEnd(32)} ${res.id}`);
    }
  }

  await mcp.close();
  console.log(`\nDone. created=${created} updated=${updated} total=${payloads.length}.`);
  // Silence the keyword warning: keyTag is part of the public catalogue API.
  void keyTag;
}

main().catch((e) => {
  console.error('\nSeed failed:', e?.message || e);
  process.exit(1);
});
