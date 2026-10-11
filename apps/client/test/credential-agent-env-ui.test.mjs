// Credentials form: Google OAuth JSON import, Custom key/value rows, and the
// env-name preview for "Expose to agents as environment variables".
//
// The preview must name exactly what the server will deliver — the examples
// below are the same ones apps/server/test/credential-agent-env.test.mjs pins
// for the server's rule. If one side changes, both tests have to.
//
// 실행:  node --import tsx --test apps/client/test/credential-agent-env-ui.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  AGENT_ENV_PROVIDERS,
  agentEnvName,
  agentEnvNames,
  customRowsProblem,
  gitHostOrigin,
  parseGoogleOAuthJson,
} from '../src/components/admin/credentialAgentEnv.logic.ts';

test('env name preview matches the server rule', () => {
  assert.equal(agentEnvName('GOOGLE', 'client_id'), 'GOOGLE_CLIENT_ID');
  assert.equal(agentEnvName('GOOGLE', 'refresh_token'), 'GOOGLE_REFRESH_TOKEN');
  assert.equal(agentEnvName('', 'REDDIT_CLIENT_ID'), 'REDDIT_CLIENT_ID');
  assert.equal(agentEnvName('X', 'client-id'), 'X_CLIENT_ID');
  assert.equal(agentEnvName('google_', 'client_id'), 'GOOGLE_CLIENT_ID', 'typed prefix is normalized like the server');
});

test('only non-CLI providers offer exposure', () => {
  assert.deepEqual([...AGENT_ENV_PROVIDERS].sort(), ['custom', 'git_http', 'github', 'gitlab', 'google_oauth', 'openai']);
});

test('a git host previews its origin, and env vars only once a prefix is given', () => {
  assert.equal(gitHostOrigin('https://lfs.parnmanas.com/txiv/emberdelve.git/info/lfs'), 'https://lfs.parnmanas.com');
  assert.equal(gitHostOrigin('lfs.parnmanas.com'), null);
  assert.deepEqual(agentEnvNames('git_http', '', ['url', 'username', 'token']), []);
  assert.deepEqual(agentEnvNames('git_http', 'forgejo', ['token']), ['FORGEJO_TOKEN']);
  assert.deepEqual(agentEnvNames('custom', '', ['TOKEN']), ['TOKEN']);
});

test('Cloud Console download (installed / web) fills client id + secret', () => {
  for (const wrapper of ['installed', 'web']) {
    const parsed = parseGoogleOAuthJson(JSON.stringify({
      [wrapper]: {
        client_id: '123.apps.googleusercontent.com',
        project_id: 'p',
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        client_secret: 'GOCSPX-abc',
        redirect_uris: ['http://localhost'],
      },
    }));
    assert.equal(parsed.ok, true, wrapper);
    assert.deepEqual(parsed.fields, { client_id: '123.apps.googleusercontent.com', client_secret: 'GOCSPX-abc' });
    assert.equal(parsed.kind, 'client');
  }
});

test('authorized-user JSON also brings the refresh token', () => {
  const parsed = parseGoogleOAuthJson(JSON.stringify({
    type: 'authorized_user',
    client_id: 'id',
    client_secret: 'secret',
    refresh_token: '1//rt',
  }));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.fields, { client_id: 'id', client_secret: 'secret', refresh_token: '1//rt' });
  assert.equal(parsed.kind, 'authorized_user');
});

test('a service-account key or junk is refused with a reason', () => {
  const sa = parseGoogleOAuthJson(JSON.stringify({ type: 'service_account', client_id: '1', private_key: 'k' }));
  assert.equal(sa.ok, false);
  assert.match(sa.error, /service-account/);
  assert.match(parseGoogleOAuthJson('not json').error, /valid JSON/);
  assert.match(parseGoogleOAuthJson('{"web": {"client_id": "x"}}').error, /client_secret/);
});

test('Custom rows: blank rows are ignored, bad / duplicate / valueless keys are named', () => {
  assert.equal(customRowsProblem([{ key: '', value: '' }, { key: 'A', value: '1' }], []), null);
  assert.match(customRowsProblem([{ key: '', value: 'v' }], []), /needs a key/);
  assert.match(customRowsProblem([{ key: '1BAD', value: 'v' }], []), /1BAD/);
  assert.match(customRowsProblem([{ key: 'A', value: '1' }, { key: 'A', value: '2' }], []), /used twice/);
  assert.match(customRowsProblem([{ key: 'TOKEN', value: 'v' }], ['TOKEN']), /used twice/);
  assert.match(customRowsProblem([{ key: 'A', value: '' }], []), /no value/);
});

test('the form sends removals explicitly and exposure only for non-CLI providers', () => {
  const src = readFileSync(new URL('../src/components/admin/CredentialManager.tsx', import.meta.url), 'utf8');
  assert.match(src, /remove_fields: removedFields/, 'a removed Custom key must reach PATCH as remove_fields');
  assert.match(src, /AGENT_ENV_PROVIDERS\.has\(formProvider\)\s*\n?\s*\? \{ agent_env: formAgentEnv/, 'exposure is only sent for non-CLI providers');
});
