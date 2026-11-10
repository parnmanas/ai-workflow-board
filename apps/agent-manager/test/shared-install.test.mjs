// 한 장비에서 같은 설치본을 쓰는 매니저 여러 개(PC.VX 2026-11-05 ~ 11-09)의 업데이트 상태 공유.
//
// 이 파일이 증명하는 것:
//   - 공유 디렉터리는 관례 이름의 홈끼리만 생기고(임시 홈은 공유하지 않는다), 같은 패키지에서 뜬
//     인스턴스끼리 같은 설치본 상태를 본다.
//   - 설치 잠금은 프로세스 사이에서 한 번에 하나이고, 죽은 쥔 쪽의 잠금은 치운다.
//   - 다른 매니저가 설치하고 검증한 빌드로만 따라간다(검증 중·설치 중·사람이 손으로 깐 빌드는 아님).
//   - 하트비트 성공은 지금 버전(과 지나온 버전)을 가리키는 핀을 지우고, 공유 검증 표시를 "검증됨" 으로 한다.
//   - 지금 돌고 있는 버전의 실패는 보고하지 않는다("(up to date) ⚠ (vX skipped)" 모순).
//   - 서비스 이름은 홈마다 다르고(기본 홈은 예전 이름 그대로), 남의 작업을 깨우지 않는다.
//   - Windows 에서 절대 경로 실행 파일은 셸을 거치지 않는다(`C:\Program Files\nodejs\node.exe`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HostStampWatcher,
  acquireHostLock,
  bumpHostStamp,
  hostDirForHome,
  hostLockPath,
  inspectHostLock,
  installStateDir,
  readHostVerify,
  writeHostVerify,
  HostLockBusyError,
} from '../dist/lib/host-shared.js';
import {
  FOLLOW_SETTLE_MS,
  evaluateSharedInstallFollow,
  readFollowAttempts,
  recordFollowAttempt,
} from '../dist/lib/shared-install-follow.js';
import {
  clearRefutedUpdateFailures,
  failureProjection,
  getRunningVersion,
  restartRequiredFor,
  runningFailureFree,
  useShellFor,
  resolveReexecStrategy,
  UpdateChecker,
} from '../dist/lib/self-update.js';
import { readUpdatePin, writeUpdatePin } from '../dist/lib/self-update-rollback.js';
import { launchdLabelForHome, serviceNameForHome, windowsHiddenLauncher } from '../dist/lib/service-install.js';
import {
  decodeSchtasksOutput,
  parseLaunchctlPrint,
  parseTasklistImage,
  taskXmlBelongsToHome,
} from '../dist/lib/service-supervision.js';
import { decideServiceHandback } from '../dist/lib/service-handback.js';

function tmp(t, prefix = 'awb-shared-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ─── 공유 디렉터리 ──────────────────────────────────────────────────────────

test('hostDirForHome: 관례 이름의 홈끼리 같은 공유 디렉터리를 보고, 임시 홈은 공유하지 않는다', () => {
  const env = {};
  const a = hostDirForHome('/u/.config/awb-agent-manager', env);
  const b = hostDirForHome('/u/.config/awb-agent-manager-parnmanas', env);
  assert.equal(a, '/u/.config/awb-agent-manager-host');
  assert.equal(a, b);
  assert.equal(hostDirForHome('/tmp/awb-boot-rollback-x1', env), null, '테스트 임시 홈끼리 핀을 나누면 안 된다');
  assert.equal(hostDirForHome('/u/.config/awb-agent-manager-host', env), null);
  assert.equal(hostDirForHome('/srv/kakao', { AWB_AGENT_MANAGER_HOST_DIR: '/srv/shared' }), '/srv/shared');
});

test('installStateDir: 같은 패키지 디렉터리끼리만 같은 설치본 상태를 본다', () => {
  assert.equal(installStateDir('/h', '/g/node_modules/awb-agent-manager'), installStateDir('/h', '/g/node_modules/awb-agent-manager'));
  assert.notEqual(installStateDir('/h', '/g/node_modules/awb-agent-manager'), installStateDir('/h', '/nvm/v22/node_modules/awb-agent-manager'));
});

// ─── 설치 잠금 ──────────────────────────────────────────────────────────────

test('acquireHostLock: 한 번에 하나 — 살아 있는 다른 프로세스가 쥐면 기다리다 실패한다', async (t) => {
  const dir = tmp(t);
  const path = hostLockPath(dir, 'manager-install-x');
  // 다른 살아 있는 프로세스가 쥔 잠금
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  t.after(() => holder.kill());
  mkdirSync(join(dir, 'locks'), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid: holder.pid, purpose: 'manager-install', home: '/other', at_ms: Date.now() }));
  await assert.rejects(acquireHostLock(path, 'test', { waitMs: 150, pollMs: 20 }), (err) => err instanceof HostLockBusyError && err.holder.pid === holder.pid);
  assert.equal(inspectHostLock(path).state, 'held');
});

test('acquireHostLock: 죽은 쥔 쪽의 잠금은 치우고 쥔다 — 풀면 파일이 사라진다', async (t) => {
  const dir = tmp(t);
  const path = hostLockPath(dir, 'manager-install-x');
  mkdirSync(join(dir, 'locks'), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid: 4194303, purpose: 'manager-install', home: '/gone', at_ms: Date.now() }));
  assert.equal(inspectHostLock(path).state, 'stale');
  const release = await acquireHostLock(path, 'test', { waitMs: 0 });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, process.pid);
  release();
  assert.equal(existsSync(path), false);
});

test('acquireHostLock: 다른 pid 이름으로 쥘 수 있다(매니저가 헬퍼 몫으로 미리 쥔다)', async (t) => {
  const dir = tmp(t);
  const path = hostLockPath(dir, 'manager-install-x');
  const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  t.after(() => helper.kill());
  await acquireHostLock(path, 'manager-install (updater helper)', { holderPid: helper.pid });
  const state = inspectHostLock(path);
  assert.equal(state.state, 'held');
  assert.equal(state.holder.pid, helper.pid, '매니저가 내려가도 잠금은 헬퍼가 쥔 것으로 보인다');
});

test('HostStampWatcher: 다른 프로세스가 남긴 변경만 알린다', (t) => {
  const dir = tmp(t);
  const w = new HostStampWatcher(dir);
  assert.equal(w.changed('cli-installs'), false, '처음은 기준만 잡는다');
  bumpHostStamp(dir, 'cli-installs');
  assert.equal(w.changed('cli-installs'), false, '자기 변경은 다시 읽을 필요가 없다');
  mkdirSync(join(dir, 'stamps'), { recursive: true });
  writeFileSync(join(dir, 'stamps', 'cli-installs.json'), JSON.stringify({ at_ms: Date.now() + 1, pid: process.pid + 1 }));
  assert.equal(w.changed('cli-installs'), true);
  assert.equal(w.changed('cli-installs'), false);
});

// ─── 따라가기 판정 ──────────────────────────────────────────────────────────

const base = {
  running: '1.6.336',
  installed: '1.6.338',
  channel: 'latest',
  channelOff: false,
  restartInFlight: false,
  installLockHolder: null,
  verify: { version: '1.6.338', previous_version: '1.6.335', phase: 'verified', home: '/kakaovx', pid: 1, at_ms: 0 },
  ownHome: '/parnmanas',
  pinnedBadVersion: null,
  firstSeenAtMs: 0,
  nowMs: FOLLOW_SETTLE_MS + 1,
  attempts: 0,
};

test('따라가기: 다른 매니저가 설치·검증한 빌드면 재시작해 싣는다', () => {
  const d = evaluateSharedInstallFollow(base);
  assert.equal(d.action, 'follow');
  assert.equal(d.version, '1.6.338');
});

test('따라가기: 설치 중·검증 중·안정 대기 중에는 기다린다', () => {
  assert.equal(evaluateSharedInstallFollow({ ...base, installLockHolder: { pid: 9, purpose: 'x', home: '/kakaovx', at_ms: 0 } }).reason, 'install_in_progress');
  assert.equal(evaluateSharedInstallFollow({ ...base, verify: { ...base.verify, phase: 'verifying', at_ms: base.nowMs - 1000 } }).reason, 'installer_verifying');
  assert.equal(evaluateSharedInstallFollow({ ...base, firstSeenAtMs: base.nowMs - 1000 }).reason, 'settling');
  assert.equal(evaluateSharedInstallFollow({ ...base, restartInFlight: true }).reason, 'restart_in_flight');
});

test('따라가기: 설치한 쪽이 돌아오지 못한 낡은 검증 표시는 기다리지 않는다', () => {
  const d = evaluateSharedInstallFollow({ ...base, verify: { ...base.verify, phase: 'verifying', at_ms: 0 }, nowMs: 13 * 60_000 });
  assert.equal(d.action, 'follow');
});

test('따라가기: 사람이 손으로 깐 빌드·자기가 깐 빌드·핀·off·고정 채널·상한은 따라가지 않는다', () => {
  assert.equal(evaluateSharedInstallFollow({ ...base, verify: null }).reason, 'not_installed_by_manager');
  assert.equal(evaluateSharedInstallFollow({ ...base, verify: { ...base.verify, home: '/parnmanas' } }).reason, 'not_installed_by_manager');
  assert.equal(evaluateSharedInstallFollow({ ...base, verify: { ...base.verify, version: '1.6.337' } }).reason, 'not_installed_by_manager');
  assert.equal(evaluateSharedInstallFollow({ ...base, pinnedBadVersion: '1.6.338' }).reason, 'pinned_bad');
  assert.equal(evaluateSharedInstallFollow({ ...base, channel: 'off', channelOff: true }).reason, 'channel_off');
  assert.equal(evaluateSharedInstallFollow({ ...base, channel: '1.6.336' }).reason, 'channel_pinned');
  assert.equal(evaluateSharedInstallFollow({ ...base, attempts: 2 }).reason, 'attempts_exhausted');
  assert.equal(evaluateSharedInstallFollow({ ...base, installed: '1.6.336' }).action, 'none');
});

test('따라가기 시도 기록은 버전별로 재시작을 넘어 센다', (t) => {
  const home = tmp(t);
  assert.equal(readFollowAttempts(home, '1.6.338'), 0);
  recordFollowAttempt(home, '1.6.338');
  recordFollowAttempt(home, '1.6.338');
  assert.equal(readFollowAttempts(home, '1.6.338'), 2);
  assert.equal(readFollowAttempts(home, '1.6.339'), 0, '다른 버전은 새로 센다');
});

test('UpdateChecker.followSharedInstallNow: 다른 매니저가 검증한 빌드가 디스크에 있으면 probe 뒤 재시작한다', async (t) => {
  const home = tmp(t);
  const hostDir = tmp(t);
  const running = getRunningVersion();
  const [maj, min, patch] = running.split('.').map((n) => Number.parseInt(n, 10));
  const newer = `${maj}.${min}.${patch + 1}`;
  const installDir = installStateDir(hostDir);
  mkdirSync(installDir, { recursive: true });
  writeFileSync(
    join(installDir, 'boot-verify.json'),
    JSON.stringify({ version: newer, previous_version: running, phase: 'verified', home: '/other-home', pid: 1, at_ms: Date.now() }),
  );
  let now = 1_000_000;
  const restarts = [];
  const probes = [];
  const checker = new UpdateChecker({
    log: () => {},
    stateDir: home,
    hostDir,
    installMode: 'npm-global',
    updateChannel: 'latest',
    currentVersion: running,
    installedVersion: () => newer,
    now: () => new Date(now),
    probeInstalled: async (v) => {
      probes.push(v);
      return { ok: true, reportedVersion: v, detail: 'ok' };
    },
    restartForFollow: async () => {
      restarts.push(newer);
      return { changed: true, summary: 'restarting', willReExec: false };
    },
  });
  t.after(() => checker.stop());
  assert.equal((await checker.followSharedInstallNow()).reason, 'settling', '처음 본 순간에는 기다린다');
  now += FOLLOW_SETTLE_MS + 1;
  assert.equal((await checker.followSharedInstallNow()).action, 'follow');
  assert.deepEqual(probes, [newer]);
  assert.deepEqual(restarts, [newer]);
  assert.equal(readFollowAttempts(home, newer), 1);
});

// ─── 실패 기록 ──────────────────────────────────────────────────────────────

test('runningFailureFree: 지금(또는 지나온) 버전의 실패는 보고하지 않는다', () => {
  const failure = { failed: '1.6.338', reason: 'boot verification failed' };
  assert.deepEqual(runningFailureFree(failure, '1.6.338'), { failed: null, reason: null });
  assert.deepEqual(runningFailureFree(failure, '1.6.340'), { failed: null, reason: null });
  assert.deepEqual(runningFailureFree(failure, '1.6.336'), failure);
});

test('restartRequiredFor: 설치 도중 읽지 못한 디스크 버전(0.0.0)은 재시작 사유가 아니다', () => {
  assert.equal(restartRequiredFor('1.6.336', '0.0.0'), false);
  assert.equal(restartRequiredFor('1.6.336', '1.6.338'), true);
});

test('clearRefutedUpdateFailures: 하트비트가 성공한 버전의 핀은 홈·공유 양쪽에서 지우고 검증 표시는 검증됨으로 한다', (t) => {
  const home = tmp(t);
  const hostDir = tmp(t);
  const running = getRunningVersion();
  const installDir = installStateDir(hostDir);
  const refuted = { version: '0.0.1', badVersion: running, reason: `boot verification failed (bad build v${running})`, pinnedAtMs: 1 };
  writeUpdatePin(refuted, home);
  writeUpdatePin(refuted, installDir);
  writeHostVerify(installDir, { version: running, previous_version: '0.0.1', phase: 'verifying' });
  clearRefutedUpdateFailures({ stateDir: home, hostDir, log: () => {} });
  assert.equal(readUpdatePin(home), null);
  assert.equal(readUpdatePin(installDir), null);
  assert.equal(readHostVerify(installDir).phase, 'verified');
  assert.deepEqual(failureProjection(home, installDir), { failed: null, reason: null });
});

test('clearRefutedUpdateFailures: 아직 올라가지 못한(더 새) 버전의 핀은 남긴다', (t) => {
  const home = tmp(t);
  const running = getRunningVersion();
  const [maj, min, patch] = running.split('.').map((n) => Number.parseInt(n, 10));
  const newer = `${maj}.${min}.${patch + 1}`;
  writeUpdatePin({ version: running, badVersion: newer, reason: 'boot verification failed', pinnedAtMs: 1 }, home);
  clearRefutedUpdateFailures({ stateDir: home, hostDir: null, log: () => {} });
  assert.equal(readUpdatePin(home).badVersion, newer);
});

// ─── 서비스 이름 · 소유 ─────────────────────────────────────────────────────

test('serviceNameForHome: 기본 홈은 예전 이름, 다른 홈은 홈 이름에서 딴 접미사', () => {
  const env = { APPDATA: 'C:\\Users\\parn\\AppData\\Roaming' };
  assert.equal(serviceNameForHome('C:\\Users\\parn\\AppData\\Roaming\\awb-agent-manager', env, 'win32'), 'awb-agent-manager');
  assert.equal(
    serviceNameForHome('C:\\Users\\parn\\AppData\\Roaming\\awb-agent-manager-parnmanas', env, 'win32'),
    'awb-agent-manager-parnmanas',
    'PC.VX 의 손으로 만든 작업 이름과 같다',
  );
  const linuxEnv = { XDG_CONFIG_HOME: '/home/p/.config' };
  assert.equal(serviceNameForHome('/home/p/.config/awb-agent-manager', linuxEnv, 'linux'), 'awb-agent-manager');
  assert.match(serviceNameForHome('/srv/kakao', linuxEnv, 'linux'), /^awb-agent-manager-kakao-[0-9a-f]{6}$/);
  assert.equal(launchdLabelForHome('/Users/p/.config/awb-agent-manager-b', { XDG_CONFIG_HOME: '/Users/p/.config' }, 'darwin'), 'com.awb.agent-manager.b');
});

test('windowsHiddenLauncher: 기본 홈이 아니면 그 홈을 작업 프로세스에 싣는다', () => {
  const plain = windowsHiddenLauncher({ execPath: 'C:\\m\\main.js', nodeBin: 'C:\\node.exe' });
  assert.doesNotMatch(plain, /AWB_AGENT_MANAGER_HOME/);
  const withHome = windowsHiddenLauncher({ execPath: 'C:\\m\\main.js', nodeBin: 'C:\\node.exe', home: 'C:\\h\\awb-agent-manager-b' });
  assert.match(withHome, /shell\.Environment\("PROCESS"\)\("AWB_AGENT_MANAGER_HOME"\) = "C:\\h\\awb-agent-manager-b"/);
});

test('taskXmlBelongsToHome: 다른 홈의 launcher 를 띄우는 작업은 내 것이 아니다', () => {
  const xml =
    '<Exec><Command>C:\\WINDOWS\\System32\\wscript.exe</Command><Arguments>"C:\\Users\\parn\\AppData\\Roaming\\awb-agent-manager-parnmanas\\service\\launch-hidden.vbs"</Arguments></Exec>';
  assert.equal(taskXmlBelongsToHome(xml, 'C:\\Users\\parn\\AppData\\Roaming\\awb-agent-manager-parnmanas'), true);
  assert.equal(taskXmlBelongsToHome(xml, 'C:\\Users\\parn\\AppData\\Roaming\\awb-agent-manager'), false);
  // launcher 없이 node 를 직접 띄우는 예전 작업은 이름이 곧 소유다.
  assert.equal(taskXmlBelongsToHome('<Command>C:\\Program Files\\nodejs\\node.exe</Command>', 'C:\\x'), true);
});

test('decodeSchtasksOutput / parseTasklistImage / parseLaunchctlPrint', () => {
  const xml = '<?xml version="1.0" encoding="UTF-16"?><Task/>';
  assert.equal(decodeSchtasksOutput(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')])), xml);
  assert.equal(decodeSchtasksOutput(Buffer.from(xml, 'utf16le')), xml);
  assert.equal(decodeSchtasksOutput(Buffer.from(xml, 'utf8')), xml);
  assert.equal(parseTasklistImage('"wscript.exe","104608","Console","1","12,345 K"\r\n'), 'wscript.exe');
  assert.equal(parseTasklistImage('INFO: No tasks are running which match the specified criteria.\r\n'), null);
  const print = 'gui/501/com.awb.agent-manager = {\n\tstate = running\n\tpid = 4242\n\tenvironment = {\n\t\tAWB_AGENT_MANAGER_HOME => /Users/p/.config/awb-agent-manager-b\n\t}\n}';
  assert.deepEqual(parseLaunchctlPrint(print), { pid: 4242, home: '/Users/p/.config/awb-agent-manager-b' });
  assert.deepEqual(parseLaunchctlPrint('state = not running\n'), { pid: null, home: null });
});

test('resolveReexecStrategy: 이 홈의 launchd 작업이 있으면 launchd 로 재기동한다', () => {
  assert.equal(resolveReexecStrategy({ systemdManaged: false, platform: 'darwin', launchdJob: true }), 'launchd');
  assert.equal(resolveReexecStrategy({ systemdManaged: false, platform: 'darwin', launchdJob: false }), 'detached');
  assert.equal(resolveReexecStrategy({ systemdManaged: true, platform: 'darwin', launchdJob: true }), 'systemd');
});

test('decideServiceHandback: 서비스 밖이라고 확인될 때만, 그리고 6시간에 한 번만 넘긴다', () => {
  const sup = { kind: 'task', name: 'awb-agent-manager', isServiceProcess: false, relaunch: ['schtasks', '/Run', '/TN', 'awb-agent-manager'] };
  assert.equal(decideServiceHandback({ supervision: null, lastHandbackAtMs: null, nowMs: 0 }).action, 'none');
  assert.equal(decideServiceHandback({ supervision: { ...sup, isServiceProcess: true }, lastHandbackAtMs: null, nowMs: 0 }).action, 'none');
  assert.equal(decideServiceHandback({ supervision: { ...sup, isServiceProcess: null }, lastHandbackAtMs: null, nowMs: 0 }).action, 'none', '판별하지 못하면 넘기지 않는다');
  assert.equal(decideServiceHandback({ supervision: sup, lastHandbackAtMs: null, nowMs: 0 }).action, 'handback');
  assert.equal(decideServiceHandback({ supervision: sup, lastHandbackAtMs: 0, nowMs: 60 * 60_000 }).action, 'wait');
  assert.equal(decideServiceHandback({ supervision: sup, lastHandbackAtMs: 0, nowMs: 7 * 60 * 60_000 }).action, 'handback');
});

test('useShellFor: Windows 에서 절대 경로 실행 파일은 셸을 거치지 않는다', () => {
  assert.equal(useShellFor('C:\\Program Files\\nodejs\\node.exe', 'win32'), false);
  assert.equal(useShellFor('npm', 'win32'), true);
  assert.equal(useShellFor('npm', 'linux'), false);
});
