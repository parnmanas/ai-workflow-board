// Regression — ticket c90653d9: `sync_github_resource` must authenticate with
// the target resource's STORED credential when the caller doesn't pass one
// explicitly.
//
// Before the fix the tool gated (`isEnabled`) and fetched (`fetchRepoInfo`)
// using only the explicit `credential_id` argument. Syncing a saved Resource
// that had a Credential attached — but without re-passing that credential —
// therefore fell back to the (usually unset) global GITHUB_TOKEN and failed
// with "GitHub token not configured. Add a credential or set global token in
// Admin Settings.", even though the resource was properly authenticated. That
// is exactly the symptom the reporter reproduced.
//
// This is an offline behaviour test: a fake MCP server captures the registered
// tool handlers, and a fake GitHubConnectorService records which credentialId
// it was asked to authenticate with (no network, no DB). We assert the
// resource's stored credential is threaded through, that an explicit argument
// still wins, and that the empty-global-token path still errors.

import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerGitHubTools } from '../dist/modules/mcp/tools/github-tools.js';

// --- fakes ------------------------------------------------------------------

function makeFakeServer() {
  const handlers = new Map();
  return {
    handlers,
    tool(name, _desc, _schema, handler) { handlers.set(name, handler); },
  };
}

// Simulates a deployment with NO global GITHUB_TOKEN: only 'cred-valid'
// resolves to a usable token. Records every credentialId it is handed.
function makeFakeGithubService() {
  const calls = { isEnabled: [], fetchRepoInfo: [] };
  return {
    calls,
    async isEnabled(credentialId) {
      calls.isEnabled.push(credentialId ?? null);
      return credentialId === 'cred-valid';
    },
    async fetchRepoInfo(owner, repo, credentialId) {
      calls.fetchRepoInfo.push(credentialId ?? null);
      return {
        full_name: `${owner}/${repo}`,
        description: 'desc',
        html_url: `https://github.com/${owner}/${repo}`,
        default_branch: 'main',
        language: 'TypeScript',
        topics: [],
        stargazers_count: 0,
        updated_at: '2026-01-01T00:00:00Z',
        readme_content: '',
        file_tree: [],
      };
    },
  };
}

function makeResourceRow(over = {}) {
  return {
    id: 'res-1',
    workspace_id: 'ws-1',
    board_id: null,
    credential_id: 'cred-valid',
    name: 'AWB',
    description: '',
    type: 'repository',
    url: 'https://github.com/parnmanas/ai-workflow-board.git',
    content: '',
    file_data: '',
    file_name: '',
    file_mimetype: '',
    default_branch: 'main',
    tags: '[]',
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

function makeFakeDataSource(resourceRow) {
  const repo = {
    async findOne({ where }) {
      if (
        resourceRow &&
        where.id === resourceRow.id &&
        where.workspace_id === resourceRow.workspace_id
      ) {
        return resourceRow;
      }
      return null;
    },
    async save(r) { return r; },
    create(obj) { return { id: 'res-new', ...obj }; },
  };
  return { getRepository() { return repo; } };
}

function makeCtx(resourceRow) {
  const githubService = makeFakeGithubService();
  const ctx = {
    dataSource: makeFakeDataSource(resourceRow),
    githubService,
    // embedResource() early-returns when embeddings are disabled → no DB touch.
    embeddingService: { async isEnabled() { return false; } },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { ctx, githubService };
}

function getSyncHandler(ctx) {
  const server = makeFakeServer();
  registerGitHubTools(server, ctx);
  const handler = server.handlers.get('sync_github_resource');
  assert.ok(handler, 'sync_github_resource must be registered');
  return handler;
}

function parseResult(res) {
  const text = res?.content?.[0]?.text ?? '';
  let body = {};
  try { body = JSON.parse(text); } catch { /* leave empty */ }
  return { isError: !!res?.isError, body };
}

// --- tests ------------------------------------------------------------------

test('sync uses the resource\'s stored credential when none is passed (the fix)', async () => {
  const row = makeResourceRow({ credential_id: 'cred-valid' });
  const { ctx, githubService } = makeCtx(row);
  const handler = getSyncHandler(ctx);

  const res = await handler({
    workspace_id: 'ws-1',
    url: 'https://github.com/parnmanas/ai-workflow-board',
    resource_id: 'res-1',
    // credential_id intentionally omitted — the resource carries 'cred-valid'.
  });
  const { isError } = parseResult(res);

  assert.equal(isError, false, 'sync must succeed using the resource credential, not fail on global token');
  assert.deepEqual(githubService.calls.isEnabled, ['cred-valid'], 'isEnabled must be gated on the resource credential');
  assert.deepEqual(githubService.calls.fetchRepoInfo, ['cred-valid'], 'fetchRepoInfo must auth with the resource credential');
  // A fallback sync must not disturb the resource's stored credential.
  assert.equal(row.credential_id, 'cred-valid', 'stored credential_id must be left intact on a fallback sync');
});

test('an explicit credential_id still wins over the resource\'s stored one', async () => {
  const row = makeResourceRow({ credential_id: 'cred-stale' });
  const { ctx, githubService } = makeCtx(row);
  const handler = getSyncHandler(ctx);

  const res = await handler({
    workspace_id: 'ws-1',
    url: 'https://github.com/parnmanas/ai-workflow-board',
    resource_id: 'res-1',
    credential_id: 'cred-valid',
  });
  const { isError } = parseResult(res);

  assert.equal(isError, false, 'sync must succeed with the explicit credential');
  assert.deepEqual(githubService.calls.fetchRepoInfo, ['cred-valid'], 'explicit credential must take precedence');
  assert.equal(row.credential_id, 'cred-valid', 'an explicit credential must be persisted onto the resource');
});

test('no resource credential + no global token still errors (fallback unchanged)', async () => {
  const row = makeResourceRow({ credential_id: null });
  const { ctx, githubService } = makeCtx(row);
  const handler = getSyncHandler(ctx);

  const res = await handler({
    workspace_id: 'ws-1',
    url: 'https://github.com/parnmanas/ai-workflow-board',
    resource_id: 'res-1',
  });
  const { isError, body } = parseResult(res);

  assert.equal(isError, true, 'with no credential and no global token, sync must still error');
  assert.match(body.error || '', /token not configured/i);
  assert.deepEqual(githubService.calls.fetchRepoInfo, [], 'must not attempt a fetch without a token');
});

test('create path (no resource_id) threads the explicit credential', async () => {
  const { ctx, githubService } = makeCtx(null); // no stored resource
  const handler = getSyncHandler(ctx);

  const res = await handler({
    workspace_id: 'ws-1',
    url: 'https://github.com/parnmanas/ai-workflow-board',
    credential_id: 'cred-valid',
  });
  const { isError } = parseResult(res);

  assert.equal(isError, false, 'create-new sync must succeed with an explicit credential');
  assert.deepEqual(githubService.calls.isEnabled, ['cred-valid']);
  assert.deepEqual(githubService.calls.fetchRepoInfo, ['cred-valid']);
});
