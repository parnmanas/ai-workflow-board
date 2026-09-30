// "현재 버전" 은 부팅 때 잡은 실행 버전이고, 디스크 설치본은 별개다(self-update.ts
// setRunningVersion / readInstalledVersion / restartRequiredFor).
//
// rolf 재현: 매니저 v1.6.246 이 도는 동안 세션이 `npm i -g awb-agent-manager@1.6.247` 을
// 돌렸다. 예전 코드는 디스크 값을 "현재" 로 읽어 update_manager 를 "already on v1.6.247" 로
// 끝냈고(FAILED ack), 프로세스는 옛 코드로 남았다. 이제
//   1. 레지스트리가 실행 버전보다 새 것이 없으면 upToDate(ok ack) + 디스크 드리프트 안내
//   2. 대상이 이미 디스크에 있으면 설치 없이 재기동만(probe → 부팅 검증 arm → restart)
//   3. 디스크 빌드가 기동 probe 에 실패하면 재기동하지 않는다
//   4. UpdateChecker 는 installed_version / restart_required 를 광고하고 한 번만 로그한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  runSelfUpdate,
  restartManager,
  setRunningVersion,
  getRunningVersion,
  readInstalledVersion,
  restartRequiredFor,
  UpdateChecker,
  UPDATE_CHANNEL_ENV,
  _resetSelfUpdateInFlightForTests,
  _setPendingRestartReasonForTests,
} from '../dist/lib/self-update.js';

const provenance = (version) => async () => ({ ok: true, version, reason: `test provenance v${version}` });

function harness({ running, installed, registry, probeOk = true }) {
  const calls = { install: [], restart: 0, probe: [] };
  const logs = [];
  setRunningVersion(running);
  const ports = {
    installedVersion: () => installed,
    verifyProvenance: async (channel) => (channel === 'latest' ? provenance(registry)() : provenance(channel)()),
    install: async (spec) => { calls.install.push(spec); return { ok: true, detail: 'installed' }; },
    probe: async (input) => { calls.probe.push(input); return probeOk ? { ok: true, detail: `entrypoint reports v${input.expectVersion}` } : { ok: false, detail: 'exit 1 before banner' }; },
    restart: () => { calls.restart += 1; },
  };
  return { calls, logs, ports, log: (m) => logs.push(m) };
}

function withCleanState(fn) {
  return async () => {
    const prev = process.env[UPDATE_CHANNEL_ENV];
    delete process.env[UPDATE_CHANNEL_ENV];
    const stateDir = mkdtempSync(join(tmpdir(), 'awb-self-update-rv-'));
    _resetSelfUpdateInFlightForTests();
    try {
      await fn(stateDir);
    } finally {
      setRunningVersion(null);
      _resetSelfUpdateInFlightForTests();
      _setPendingRestartReasonForTests(null);
      if (prev === undefined) delete process.env[UPDATE_CHANNEL_ENV];
      else process.env[UPDATE_CHANNEL_ENV] = prev;
      rmSync(stateDir, { recursive: true, force: true });
    }
  };
}

test('running version overrides the on-disk read; restartRequiredFor compares them', () => {
  const disk = readInstalledVersion();
  assert.match(disk, /^\d+\.\d+\.\d+/);
  assert.equal(getRunningVersion(), disk, 'without a boot capture the running version falls back to disk');
  setRunningVersion('1.6.246');
  try {
    assert.equal(getRunningVersion(), '1.6.246');
    assert.equal(readInstalledVersion(), disk, 'the disk read is unaffected');
    assert.equal(restartRequiredFor('1.6.246', '1.6.247'), true);
    assert.equal(restartRequiredFor('1.6.247', '1.6.246'), true, 'a downgraded disk also differs');
    assert.equal(restartRequiredFor('1.6.247', '1.6.247'), false);
    assert.equal(restartRequiredFor('e2e', '1.6.247'), false, 'non-semver never demands a restart');
    setRunningVersion('garbage');
    assert.equal(getRunningVersion(), disk, 'a non-semver capture is ignored');
  } finally {
    setRunningVersion(null);
  }
});

test('registry has nothing newer than the RUNNING build → upToDate skip (ok ack), disk drift is noted', withCleanState(async (stateDir) => {
  const h = harness({ running: '1.6.247', installed: '1.6.247', registry: '1.6.247' });
  const r = await runSelfUpdate({ log: h.log, stateDir, ports: h.ports });
  assert.equal(r.changed, false);
  assert.equal(r.upToDate, true, 'nothing to do is not a failure');
  assert.match(r.summary, /already running v1\.6\.247 \(registry has v1\.6\.247\)/);
  assert.equal(h.calls.install.length, 0);
  assert.equal(h.calls.restart, 0);

  _resetSelfUpdateInFlightForTests();
  const drift = harness({ running: '1.6.246', installed: '1.6.247', registry: '1.6.246' });
  const r2 = await runSelfUpdate({ log: drift.log, stateDir, ports: drift.ports });
  assert.equal(r2.upToDate, true);
  assert.match(r2.summary, /disk has v1\.6\.247; use restart_manager \/ SIGUSR2/);
}));

test('target already installed on disk (running is older) → no install, restart only, boot verification armed', withCleanState(async (stateDir) => {
  const h = harness({ running: '1.6.246', installed: '1.6.247', registry: '1.6.247' });
  const dry = await runSelfUpdate({ log: h.log, stateDir, noReExec: true, ports: h.ports });
  assert.equal(dry.changed, true);
  assert.equal(dry.willReExec, false);
  assert.match(dry.summary, /v1\.6\.247 is already installed on disk \(running v1\.6\.246\) — would restart/);
  assert.equal(h.calls.install.length, 0, 'dry run never installs');

  _resetSelfUpdateInFlightForTests();
  const live = harness({ running: '1.6.246', installed: '1.6.247', registry: '1.6.247' });
  const r = await runSelfUpdate({ log: live.log, stateDir, ports: live.ports });
  assert.equal(r.changed, true);
  assert.equal(r.willReExec, true);
  assert.match(r.summary, /already installed on disk \(running v1\.6\.246\); restarting manager to load it/);
  assert.equal(live.calls.install.length, 0, 'the on-disk build is NOT reinstalled');
  assert.deepEqual(live.calls.probe, [{ expectVersion: '1.6.247' }], 'the on-disk build is probed before restarting into it');
  assert.match(live.logs.join('\n'), /running v1\.6\.246, installed v1\.6\.247/);
  assert.match(live.logs.join('\n'), /boot verification armed for v1\.6\.247 \(rollback target v1\.6\.246/);
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.equal(live.calls.restart, 1, 'restart scheduled on the same 1.5s timer as the install path');
}));

test('on-disk build fails its start probe → refuse to restart, keep running build', withCleanState(async (stateDir) => {
  const h = harness({ running: '1.6.246', installed: '1.6.247', registry: '1.6.247', probeOk: false });
  const r = await runSelfUpdate({ log: h.log, stateDir, ports: h.ports });
  assert.equal(r.changed, false);
  assert.match(r.summary, /installed build v1\.6\.247 on disk failed to start/);
  assert.match(r.summary, /staying on running v1\.6\.246/);
  assert.equal(h.calls.restart, 0);
  assert.equal(h.calls.install.length, 0);
}));

test('registry newer than BOTH running and disk → the normal install path still runs', withCleanState(async (stateDir) => {
  const h = harness({ running: '1.6.246', installed: '1.6.246', registry: '1.6.248' });
  const r = await runSelfUpdate({ log: h.log, stateDir, noReExec: true, ports: h.ports });
  assert.equal(r.changed, true);
  assert.match(r.summary, /would run `npm install -g --ignore-scripts awb-agent-manager@1\.6\.248`/);
}));

test('restartManager names both versions when they differ', withCleanState(async () => {
  setRunningVersion('1.6.246');
  const r = await restartManager({ log: () => {}, noReExec: true });
  assert.equal(r.changed, true);
  if (readInstalledVersion() !== '1.6.246') assert.match(r.summary, /running v1\.6\.246 → installed v/);
}));

test('UpdateChecker advertises installed_version / restart_required and logs the drift once', () => {
  const logs = [];
  let installed = '1.6.246';
  const c = new UpdateChecker({ log: (m) => logs.push(m), currentVersion: '1.6.246', installedVersion: () => installed, installMode: 'npm-global' });
  try {
    let s = c.status();
    assert.equal(s.current_version, '1.6.246');
    assert.equal(s.installed_version, '1.6.246');
    assert.equal(s.restart_required, false);
    installed = '1.6.247'; // someone ran `npm i -g` while we run
    s = c.status();
    assert.equal(s.installed_version, '1.6.247');
    assert.equal(s.restart_required, true);
    assert.equal(s.current_version, '1.6.246', 'the running version never follows the disk');
    c.status();
    c.status();
    assert.equal(logs.filter((l) => /restart required/.test(l)).length, 1, 'drift is logged once, not every heartbeat');
    installed = '1.6.246';
    assert.equal(c.status().restart_required, false);
  } finally {
    c.stop();
  }
});
