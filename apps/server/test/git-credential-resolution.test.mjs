import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GitCredentialResolutionError,
  resolveGitCredential,
  sanitizeGitError,
} from '../dist/modules/mcp/shared/git-branches.js';

function repoWith(row) {
  return { async findOne() { return row; } };
}

test('registered credential token is passed to Git exactly', async () => {
  const resolved = await resolveGitCredential(repoWith({
    id: 'cred-1', workspace_id: 'ws-1',
    encrypted_data: JSON.stringify({ token: '  github-token-value  ' }),
  }), 'cred-1', 'ws-1');
  assert.deepEqual(resolved, { username: undefined, token: 'github-token-value' });
});

test('an unreadable registered credential never falls back to anonymous Git', async () => {
  await assert.rejects(
    resolveGitCredential(repoWith({
      id: 'cred-1', workspace_id: 'ws-1', encrypted_data: 'enc:corrupted',
    }), 'cred-1', 'ws-1'),
    (err) => err instanceof GitCredentialResolutionError && /unreadable/.test(err.message),
  );
});

test('a registered credential with an empty token reports the real error', async () => {
  await assert.rejects(
    resolveGitCredential(repoWith({
      id: 'cred-1', workspace_id: 'ws-1', encrypted_data: JSON.stringify({ token: '' }),
    }), 'cred-1', 'ws-1'),
    /has no token/,
  );
});

test('Git errors expose the cause without leaking registered credentials', () => {
  const safe = sanitizeGitError(
    "fatal: Authentication failed for 'https://x-access-token:ghp_secret_value@github.com/acme/private.git'",
    { token: 'ghp_secret_value' },
  );
  assert.match(safe, /Authentication failed/);
  assert.doesNotMatch(safe, /ghp_secret_value|x-access-token/);
  assert.match(safe, /https:\/\/\*\*\*@github\.com/);
});
