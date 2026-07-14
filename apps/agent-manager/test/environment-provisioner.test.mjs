// Board environment provisioning (ticket 354d336b). Covers:
//   - parseEnvironmentConfig: defensive event-field parse (object / JSON string
//     / malformed / url-less repo dropped / empty → null)
//   - fingerprintEnvironment: stable across key order, changes with content
//     and with `version`
//   - EnvironmentProvisioner: env_vars + setup_commands path is idempotent
//     (second run skips on the fingerprint marker), a failing setup command
//     returns ok=false WITHOUT a marker, and the failure cooldown suppresses
//     the re-run/re-comment on the next call.
//
// The provisioner reads MANAGED_AGENTS_DIR from AWB_AGENT_MANAGER_HOME at module
// load, so it is dynamic-imported AFTER pointing that env at a temp dir. Tests
// avoid `repositories` so no network/git is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'awb-envprov-'));
process.env.AWB_AGENT_MANAGER_HOME = HOME;

const { parseEnvironmentConfig, resolveBootstrapRepository } = await import('../dist/lib/event-dispatcher.js');
const { EnvironmentProvisioner, fingerprintEnvironment } = await import(
  '../dist/lib/environment-provisioner.js'
);

const AGENT = 'agent-aaaaaaaa';

test('parseEnvironmentConfig: object, JSON string, and null/garbage', () => {
  const obj = {
    repositories: [{ url: 'https://x/r.git', target_dir: 'repos/r' }],
    env_vars: { NODE_ENV: 'development' },
    setup_commands: ['npm ci'],
    setup_timeout_seconds: 120,
    version: 2,
  };
  const fromObj = parseEnvironmentConfig(obj);
  assert.equal(fromObj.repositories.length, 1);
  assert.equal(fromObj.env_vars.NODE_ENV, 'development');
  assert.equal(fromObj.setup_commands[0], 'npm ci');
  assert.equal(fromObj.setup_timeout_seconds, 120);
  assert.equal(fromObj.version, 2);

  const fromStr = parseEnvironmentConfig(JSON.stringify(obj));
  assert.deepEqual(fromStr, fromObj);

  assert.equal(parseEnvironmentConfig(null), null);
  assert.equal(parseEnvironmentConfig(''), null);
  assert.equal(parseEnvironmentConfig('{not json'), null);
  assert.equal(parseEnvironmentConfig({}), null);
  // a config with only timeout/version (nothing to provision) → null
  assert.equal(parseEnvironmentConfig({ setup_timeout_seconds: 60, version: 1 }), null);
});

test('parseEnvironmentConfig: drops repos without a usable url or target_dir', () => {
  const parsed = parseEnvironmentConfig({
    repositories: [
      { url: 'https://x/a.git', target_dir: 'repos/a' }, // ok
      { target_dir: 'repos/b' }, // no url → dropped
      { url: 'https://x/c.git' }, // no target_dir → dropped (server always fills it)
    ],
    setup_commands: ['echo hi'],
  });
  assert.equal(parsed.repositories.length, 1);
  assert.equal(parsed.repositories[0].target_dir, 'repos/a');
  // defaults applied
  assert.equal(parsed.setup_timeout_seconds, 600);
  assert.equal(parsed.version, 0);
});

test('resolveBootstrapRepository: ticket repo wins, board repo is fallback', () => {
  const environment = {
    repositories: [{ url: 'https://example.test/board.git', target_dir: 'repos/board', branch: 'develop', post_clone_commands: [] }],
    env_vars: {}, setup_commands: [], setup_timeout_seconds: 600, version: 0,
  };
  assert.deepEqual(
    resolveBootstrapRepository(
      { url: 'https://example.test/ticket.git', default_branch: 'main' },
      'release',
      environment,
    ),
    { resourceId: '', url: 'https://example.test/ticket.git', branch: 'release' },
  );
  assert.deepEqual(
    resolveBootstrapRepository(null, '', environment),
    { resourceId: '', url: 'https://example.test/board.git', branch: 'develop' },
  );
  assert.equal(resolveBootstrapRepository(null, '', null), null);
});

test('fingerprintEnvironment: stable across key order, sensitive to content + version', () => {
  const a = { repositories: [], env_vars: { A: '1', B: '2' }, setup_commands: ['x'], setup_timeout_seconds: 600, version: 1 };
  const b = { version: 1, setup_timeout_seconds: 600, setup_commands: ['x'], env_vars: { B: '2', A: '1' }, repositories: [] };
  assert.equal(fingerprintEnvironment(a), fingerprintEnvironment(b));

  const changedContent = { ...a, setup_commands: ['y'] };
  assert.notEqual(fingerprintEnvironment(a), fingerprintEnvironment(changedContent));

  const changedVersion = { ...a, version: 2 };
  assert.notEqual(fingerprintEnvironment(a), fingerprintEnvironment(changedVersion));
});

test('provision: success writes a marker and the second run skips it', async () => {
  const prov = new EnvironmentProvisioner();
  const config = {
    repositories: [],
    env_vars: { FOO: 'bar' },
    setup_commands: ['true'], // no-op shell builtin, exit 0
    setup_timeout_seconds: 30,
    version: 0,
  };
  const first = await prov.provision({ agentId: AGENT, config, ticketId: 't1' });
  assert.equal(first.ok, true);
  assert.equal(first.skipped, false);
  const markerDir = join(HOME, 'agents', AGENT, 'env');
  assert.ok(existsSync(join(markerDir, `${first.fingerprint}.json`)), 'success marker written');

  const second = await prov.provision({ agentId: AGENT, config, ticketId: 't2' });
  assert.equal(second.ok, true);
  assert.equal(second.skipped, true, 'second run hits the fingerprint marker');
  assert.equal(second.fingerprint, first.fingerprint);
});

test('provision: a failing setup command returns ok=false, no marker, then cools down', async () => {
  const prov = new EnvironmentProvisioner();
  const config = {
    repositories: [],
    env_vars: {},
    setup_commands: ['exit 7'], // non-zero → must fail
    setup_timeout_seconds: 30,
    version: 99,
  };
  const fail = await prov.provision({ agentId: AGENT, config, ticketId: 't3' });
  assert.equal(fail.ok, false);
  assert.ok(fail.error && fail.error.length > 0, 'error message captured');
  const markerDir = join(HOME, 'agents', AGENT, 'env');
  assert.ok(!existsSync(join(markerDir, `${fail.fingerprint}.json`)), 'NO success marker on failure');
  assert.ok(existsSync(join(markerDir, `${fail.fingerprint}.failed.json`)), 'failure marker written');

  // Second call within the cooldown window: aborts without re-running and is
  // flagged reported (caller must not re-comment).
  const cooled = await prov.provision({ agentId: AGENT, config, ticketId: 't4' });
  assert.equal(cooled.ok, false);
  assert.equal(cooled.reported, true, 'failure cooldown suppresses re-report');
});
