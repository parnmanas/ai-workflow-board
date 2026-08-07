// Unit tests for resolveOutreachCredential (ticket 2500fea3 D1) — mirrors
// git-credential-resolution.test.mjs's shape, since outreach-credential.ts
// deliberately copies resolveGitCredential's workspace-scope contract.
// Priority case per the ticket's plan: (c) a credential scoped to a DIFFERENT
// workspace must be REJECTED, not silently resolved to no token — that gap
// is this feature's biggest security risk.

import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OutreachCredentialResolutionError,
  resolveOutreachCredential,
} from '../dist/modules/outreach/outreach-credential.js';

function repoWith(row) {
  return { async findOne() { return row; } };
}

test('no credential_id resolves to null without querying', async () => {
  const resolved = await resolveOutreachCredential(repoWith(null), null, 'ws-1');
  assert.equal(resolved, null);
});

test('a GLOBAL credential (workspace_id=null) resolves regardless of caller workspace', async () => {
  const resolved = await resolveOutreachCredential(repoWith({
    id: 'cred-1', workspace_id: null,
    encrypted_data: JSON.stringify({ token: 'global-token' }),
  }), 'cred-1', 'ws-1');
  assert.deepEqual(resolved, { username: undefined, token: 'global-token' });
});

test('a credential scoped to the SAME workspace resolves', async () => {
  const resolved = await resolveOutreachCredential(repoWith({
    id: 'cred-1', workspace_id: 'ws-1',
    encrypted_data: JSON.stringify({ token: 'ws-token' }),
  }), 'cred-1', 'ws-1');
  assert.deepEqual(resolved, { username: undefined, token: 'ws-token' });
});

test('a credential scoped to a DIFFERENT workspace is rejected, not silently ignored', async () => {
  await assert.rejects(
    resolveOutreachCredential(repoWith({
      id: 'cred-1', workspace_id: 'ws-other',
      encrypted_data: JSON.stringify({ token: 'other-ws-token' }),
    }), 'cred-1', 'ws-1'),
    (err) => err instanceof OutreachCredentialResolutionError && /different workspace/.test(err.message),
  );
});

test('a nonexistent credential id is rejected (never falls back to anonymous)', async () => {
  await assert.rejects(
    resolveOutreachCredential(repoWith(null), 'cred-missing', 'ws-1'),
    (err) => err instanceof OutreachCredentialResolutionError && /does not exist/.test(err.message),
  );
});

test('a legacy Board-scoped credential fails closed until migrated to Workspace scope', async () => {
  await assert.rejects(
    resolveOutreachCredential(repoWith({
      id: 'cred-board', workspace_id: 'ws-1', board_id: 'board-1',
      encrypted_data: JSON.stringify({ token: 'board-token' }),
    }), 'cred-board', 'ws-1'),
    /has not been migrated to Workspace scope/,
  );
});

test('an unreadable credential never falls back to anonymous access', async () => {
  await assert.rejects(
    resolveOutreachCredential(repoWith({
      id: 'cred-1', workspace_id: 'ws-1', encrypted_data: 'enc:corrupted',
    }), 'cred-1', 'ws-1'),
    (err) => err instanceof OutreachCredentialResolutionError && /unreadable/.test(err.message),
  );
});

test('a credential with an empty token reports the real error', async () => {
  await assert.rejects(
    resolveOutreachCredential(repoWith({
      id: 'cred-1', workspace_id: 'ws-1', encrypted_data: JSON.stringify({ token: '' }),
    }), 'cred-1', 'ws-1'),
    /has no token/,
  );
});

test('rejecting a cross-workspace credential never leaks its token in the error message', async () => {
  const secretToken = 'super-secret-outreach-token-xyz';
  let caught = null;
  try {
    await resolveOutreachCredential(repoWith({
      id: 'cred-1', workspace_id: 'ws-other',
      encrypted_data: JSON.stringify({ token: secretToken }),
    }), 'cred-1', 'ws-1');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof OutreachCredentialResolutionError);
  assert.doesNotMatch(caught.message, new RegExp(secretToken));
});
