// 같은 설치본을 쓰는 다른 매니저가 올린 빌드로 **따라 올라가기**.
//
// 한 장비의 매니저들은 `npm i -g` 로 깔린 패키지 디렉터리 하나를 나눠 쓴다. 한 인스턴스가
// 업데이트하면 디스크는 모두에게 바뀌지만 나머지 프로세스는 옛 코드를 계속 돈다 — 화면에는
// "restart required" 가 남고, 그 프로세스가 나중에 처음 불러오는 모듈은 새 빌드의 파일이다
// (옛 코드 + 새 파일). 한 곳에서 업데이트하면 그 장비의 매니저가 모두 올라가야 깔끔하다.
//
// 따라가는 조건은 **다른 매니저가 설치하고 부팅 검증까지 끝낸 빌드**다(host-shared.ts 의
// 검증 표시). 그래서
//   - 설치 중(잠금)이거나 설치한 쪽이 아직 검증 중이면 기다린다 — 검증이 실패하면 설치한 쪽이
//     디스크를 되돌리고, 따라간 쪽은 되돌려진 빌드를 또 따라가야 한다.
//   - 사람이 셸에서 `npm i -g` 로 바꾼 디스크(표시 없음)는 따라가지 않는다. 그건 예전처럼
//     "Restart to apply" 로 운영자가 고른다 — 세션 안의 에이전트가 테스트로 설치했을 때 그
//     세션을 돌리는 매니저가 저절로 재시작하면 안 된다.
//   - 채널이 off 이거나 다른 버전에 고정된 인스턴스는 따라가지 않는다(운영자의 핀).
// 따라가는 재시작은 부팅 검증을 걸지 않는다 — 그 빌드는 이미 검증됐고, 따라간 쪽의 사정(서버가
// 잠시 안 보임 등)으로 공유 디스크를 되돌리면 멀쩡히 도는 다른 인스턴스까지 끌어내린다.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { HostLockHolder, HostVerifyRecord } from './host-shared.js';
import { HOST_VERIFY_WAIT_MAX_MS } from './host-shared.js';

/** 표시를 본 뒤 이만큼은 디스크가 그대로인지 보고 따라간다(하트비트 한 주기). */
export const FOLLOW_SETTLE_MS = 30_000;
/** 한 버전으로 따라가기를 이만큼 시도해도 그 버전이 아니면 멈춘다. */
export const FOLLOW_MAX_ATTEMPTS = 2;

export type FollowWaitReason = 'install_in_progress' | 'installer_verifying' | 'settling' | 'restart_in_flight';
export type FollowBlockReason =
  | 'channel_off'
  | 'channel_pinned'
  | 'pinned_bad'
  | 'not_installed_by_manager'
  | 'attempts_exhausted';

export type FollowDecision =
  | { action: 'none' }
  | { action: 'wait'; reason: FollowWaitReason; detail: string }
  | { action: 'blocked'; reason: FollowBlockReason; detail: string }
  | { action: 'follow'; version: string; detail: string };

const SEMVER = /^\d+\.\d+\.\d+/;

/** 따라갈지 판정한다 — 순수 함수. */
export function evaluateSharedInstallFollow(input: {
  running: string;
  installed: string;
  channel: string;
  channelOff: boolean;
  restartInFlight: boolean;
  installLockHolder: HostLockHolder | null;
  verify: HostVerifyRecord | null;
  /** 이 인스턴스의 홈 — 자기가 남긴 검증 표시는 "다른 매니저가 설치했다" 가 아니다. */
  ownHome: string;
  pinnedBadVersion: string | null;
  /** 지금 디스크 버전을 처음 본 시각. */
  firstSeenAtMs: number;
  nowMs: number;
  attempts: number;
  settleMs?: number;
  maxAttempts?: number;
}): FollowDecision {
  const { running, installed } = input;
  if (!SEMVER.test(installed) || installed === running) return { action: 'none' };
  if (input.channelOff) {
    return { action: 'blocked', reason: 'channel_off', detail: `update channel is off — staying on v${running}` };
  }
  if (SEMVER.test(input.channel) && input.channel !== installed) {
    return {
      action: 'blocked',
      reason: 'channel_pinned',
      detail: `update channel is pinned to v${input.channel} — not following v${installed}`,
    };
  }
  if (input.restartInFlight) {
    return { action: 'wait', reason: 'restart_in_flight', detail: 'a self-update / restart of this manager is already in flight' };
  }
  if (input.installLockHolder) {
    const h = input.installLockHolder;
    return {
      action: 'wait',
      reason: 'install_in_progress',
      detail: `another process (pid=${h.pid}${h.home ? `, ${h.home}` : ''}) is installing the shared build`,
    };
  }
  if (input.pinnedBadVersion && input.pinnedBadVersion === installed) {
    return {
      action: 'blocked',
      reason: 'pinned_bad',
      detail: `v${installed} on disk is pinned as failed — not following it (operator action required)`,
    };
  }
  const verify = input.verify && input.verify.version === installed ? input.verify : null;
  if (!verify || verify.home === input.ownHome) {
    return {
      action: 'blocked',
      reason: 'not_installed_by_manager',
      detail:
        `v${installed} on disk was not installed by another manager on this machine — ` +
        'restart this manager to load it (admin UI Restart)',
    };
  }
  if (verify.phase === 'verifying' && input.nowMs - verify.at_ms < HOST_VERIFY_WAIT_MAX_MS) {
    return {
      action: 'wait',
      reason: 'installer_verifying',
      detail: `waiting for the manager that installed v${installed} (${verify.home || 'unknown home'}) to verify its boot`,
    };
  }
  const settleMs = input.settleMs ?? FOLLOW_SETTLE_MS;
  if (input.nowMs - input.firstSeenAtMs < settleMs) {
    return { action: 'wait', reason: 'settling', detail: `v${installed} on disk — following once it stays put` };
  }
  if (input.attempts >= (input.maxAttempts ?? FOLLOW_MAX_ATTEMPTS)) {
    return {
      action: 'blocked',
      reason: 'attempts_exhausted',
      detail: `already restarted ${input.attempts} time(s) to load v${installed} and it did not take — restart this manager by hand`,
    };
  }
  return {
    action: 'follow',
    version: installed,
    detail:
      `v${installed} was installed${verify.phase === 'verified' ? ' and verified' : ''} by another manager on this machine ` +
      `(${verify.home || 'unknown home'}) — restarting v${running} to load it`,
  };
}

// ─── 시도 기록(재시작을 넘어 센다) ─────────────────────────────────────────

const FOLLOW_STATE_FILE = 'shared-install-follow.json';

export interface FollowAttempts {
  version: string;
  attempts: number;
  last_at_ms: number;
}

export function followStatePath(home: string): string {
  return join(home, FOLLOW_STATE_FILE);
}

export function readFollowAttempts(home: string, version: string): number {
  try {
    if (!existsSync(followStatePath(home))) return 0;
    const raw = JSON.parse(readFileSync(followStatePath(home), 'utf8'));
    return raw?.version === version && Number.isInteger(raw?.attempts) ? raw.attempts : 0;
  } catch {
    return 0;
  }
}

export function recordFollowAttempt(home: string, version: string, nowMs: number = Date.now()): number {
  const attempts = readFollowAttempts(home, version) + 1;
  try {
    writeFileSync(
      followStatePath(home),
      `${JSON.stringify({ version, attempts, last_at_ms: nowMs } satisfies FollowAttempts)}\n`,
      'utf8',
    );
  } catch {
    /* 못 세면 상한이 늦게 걸릴 뿐 — 따라가기 자체는 막지 않는다 */
  }
  return attempts;
}

/** 그 버전으로 실제로 올라왔으면 기록을 지운다. */
export function clearFollowAttempts(home: string, runningVersion: string): void {
  try {
    if (!existsSync(followStatePath(home))) return;
    const raw = JSON.parse(readFileSync(followStatePath(home), 'utf8'));
    if (raw?.version === runningVersion) unlinkSync(followStatePath(home));
  } catch {
    /* 다음 판정이 버전이 달라 무시한다 */
  }
}
