// 한 장비에서 **같은 설치본을 쓰는 매니저 인스턴스끼리** 나누는 상태.
//
// 배경(PC.VX 2026-11-05 ~ 11-09): 한 장비에 매니저가 두 개(서로 다른
// AWB_AGENT_MANAGER_HOME, 서로 다른 AWB) 돌았다. 둘은 `npm i -g awb-agent-manager` 로 깔린
// **같은 패키지 디렉터리**에서 뜨지만, 업데이트 상태(설치 진행 · 부팅 검증 · 실패 핀)는 각자
// 홈에만 적었다. 그래서
//   - 한쪽이 설치하는 동안 다른 쪽은 그 사실을 모른 채 디스크의 반쯤 바뀐 빌드를 띄우거나
//     같은 전역 prefix 에 동시에 `npm install -g` 를 돌릴 수 있었고,
//   - 한쪽이 올린 빌드를 다른 쪽은 "디스크가 갈렸다(restart required)" 로만 보고 그대로 옛 코드로
//     남았으며(옛 코드가 나중에 lazy import 하는 모듈은 새 빌드의 파일이다),
//   - 한쪽의 거짓 부팅 실패가 그 버전을 자기 홈에만 핀해, 정작 그 버전이 멀쩡히 돌고 있는데도
//     "(v1.6.338 skipped)" 가 화면에 남았다.
// 설치본이 하나면 그 설치본의 상태도 하나여야 한다. 여기가 그 하나다.
//
// ── 위치 ────────────────────────────────────────────────────────────────────
// 매니저 홈들의 **부모 디렉터리**에 `awb-agent-manager-host/` 를 둔다. 기본 홈
// (`%APPDATA%\awb-agent-manager`, `~/.config/awb-agent-manager`)과 그 옆에 만든 홈
// (`awb-agent-manager-<이름>`)이 같은 곳을 본다. 홈 이름이 이 관례를 따르지 않으면(테스트의
// 임시 홈 등) 공유를 끈다 — 임시 홈들이 `/tmp/awb-agent-manager-host` 를 나눠 써서 서로의
// 핀을 읽는 일을 막는다. 관례 밖 위치에서 공유하려면 AWB_AGENT_MANAGER_HOST_DIR 로 지정한다.
// 공유가 꺼졌다는 사실은 부팅 로그에 한 줄로 남는다(describeHostSharing).
//
// ── 무엇을 나누나 ──────────────────────────────────────────────────────────
//   - locks/      프로세스 사이 잠금. 같은 전역 prefix 에 대한 npm 설치를 한 번에 하나로.
//   - installs/<패키지 디렉터리 해시>/  매니저 설치본별 상태 — 실패 핀, 부팅 검증 표시.
//                 nvm 으로 node 가 여러 벌이면 전역 설치본도 여러 벌이고 서로 무관하므로
//                 패키지 디렉터리로 나눈다.
//   - stamps/     "이 장비의 CLI/어댑터가 바뀌었다" 는 알림. 다른 인스턴스가 다음 하트비트에
//                 다시 읽게 한다.
//   - acp-adapters/  운영자가 올린 ACP 어댑터(bundled-acp.ts). 한 장비의 CLI 는 하나다.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_MANAGER_HOME } from './constants.js';
import { isPidAlive } from './orphan-cleanup.js';

/** 공유 디렉터리를 직접 지정한다. 관례 밖 홈에서 인스턴스끼리 공유할 때. */
export const HOST_DIR_ENV = 'AWB_AGENT_MANAGER_HOST_DIR';
export const HOST_DIR_NAME = 'awb-agent-manager-host';

/** 공유를 켜는 홈 이름 — `awb-agent-manager` 와 그 변형(`awb-agent-manager-parnmanas`). */
const HOME_NAME_RE = /^awb-agent-manager(?:[-._].+)?$/i;

/** 이 홈과 공유 디렉터리를 나눌 곳. 공유하지 않으면 null. */
export function hostDirForHome(home: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env[HOST_DIR_ENV]?.trim();
  if (override) return resolve(override);
  const abs = resolve(home);
  const name = basename(abs);
  if (!HOME_NAME_RE.test(name) || name.toLowerCase() === HOST_DIR_NAME) return null;
  return join(dirname(abs), HOST_DIR_NAME);
}

/** 이 프로세스의 공유 디렉터리(매니저 홈 기준). */
export function defaultHostDir(): string | null {
  return hostDirForHome(AGENT_MANAGER_HOME);
}

/** 부팅 로그 한 줄 — 공유가 꺼진 것을 조용히 넘기지 않는다. */
export function describeHostSharing(home: string = AGENT_MANAGER_HOME, env: NodeJS.ProcessEnv = process.env): string {
  const dir = hostDirForHome(home, env);
  if (dir) return `host-shared state: ${dir} (shared with other managers on this machine that use the same install)`;
  return (
    `host-shared state: off — home "${basename(resolve(home))}" is not named awb-agent-manager[-<name>]; ` +
    `set ${HOST_DIR_ENV} to share update state with other managers on this machine`
  );
}

/** 지금 돌고 있는 매니저 패키지의 루트(`<root>/dist/lib/host-shared.js` 의 두 단계 위). */
export function managerPackageDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function normalizedPathKey(path: string): string {
  const abs = resolve(path);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function shortHash(text: string, len = 12): string {
  return createHash('sha256').update(text).digest('hex').slice(0, len);
}

/** 매니저 설치본별 상태 디렉터리. 같은 패키지 디렉터리에서 뜬 인스턴스끼리만 같다. */
export function installStateDir(hostDir: string, packageDir: string = managerPackageDir()): string {
  return join(hostDir, 'installs', shortHash(normalizedPathKey(packageDir)));
}

/** 매니저 전역 설치에 거는 잠금 이름 — 설치본(패키지 디렉터리) 단위. */
export function managerInstallLockName(packageDir: string = managerPackageDir()): string {
  return `manager-install-${shortHash(normalizedPathKey(packageDir))}`;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* 없거나 지울 수 없다 — 읽는 쪽이 낡은 것으로 다룬다 */
  }
}

// ─── 프로세스 사이 잠금 ──────────────────────────────────────────────────────
//
// 파일 하나를 `wx`(없을 때만 만든다)로 만드는 쪽이 잠금을 쥔다. 쥔 쪽의 pid 와 시각을 적어
// 두고, 그 pid 가 죽었거나 너무 오래됐으면(pid 재사용 대비) 낡은 잠금으로 보고 치운다.
// Windows 업데이터 헬퍼(self-update.ts 에 문자열로 박힌 독립 스크립트)도 **같은 형식**으로
// 이 파일을 쥔다 — 형식을 바꾸면 그쪽도 함께 바꿀 것.

export interface HostLockHolder {
  pid: number;
  purpose: string;
  home: string;
  at_ms: number;
}

/** 쥔 쪽이 이보다 오래 붙잡고 있으면 낡은 잠금으로 본다. npm 설치 상한(10분)보다 넉넉히. */
export const HOST_LOCK_STALE_MS = 30 * 60_000;
/** 내용을 아직 못 쓴 갓 만든 파일은 이 시간 동안은 살아 있는 것으로 본다. */
const HOST_LOCK_UNREADABLE_GRACE_MS = 10_000;

export function hostLockPath(hostDir: string, name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
  return join(hostDir, 'locks', `${safe}-${shortHash(name, 8)}.lock`);
}

function parseHolder(raw: any): HostLockHolder | null {
  if (!raw || typeof raw !== 'object') return null;
  const pid = Number(raw.pid);
  const at = Number(raw.at_ms);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(at)) return null;
  return {
    pid,
    purpose: typeof raw.purpose === 'string' ? raw.purpose : '',
    home: typeof raw.home === 'string' ? raw.home : '',
    at_ms: at,
  };
}

export type HostLockState =
  | { state: 'free' }
  | { state: 'held'; holder: HostLockHolder }
  | { state: 'stale'; reason: string };

/** 잠금 파일의 현재 상태. 판정만 하고 아무것도 지우지 않는다. */
export function inspectHostLock(
  path: string,
  opts: { nowMs?: number; staleMs?: number; isAlive?: (pid: number) => boolean } = {},
): HostLockState {
  const nowMs = opts.nowMs ?? Date.now();
  const staleMs = opts.staleMs ?? HOST_LOCK_STALE_MS;
  const isAlive = opts.isAlive ?? isPidAlive;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err: any) {
    return err?.code === 'ENOENT' ? { state: 'free' } : { state: 'stale', reason: `unreadable: ${err?.code ?? err}` };
  }
  let holder: HostLockHolder | null = null;
  try {
    holder = parseHolder(JSON.parse(text));
  } catch {
    holder = null;
  }
  if (!holder) {
    // `wx` 로 만든 직후 내용을 쓰기 전일 수 있다 — 잠깐은 기다린다.
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      return { state: 'free' };
    }
    if (nowMs - mtimeMs < HOST_LOCK_UNREADABLE_GRACE_MS) {
      return { state: 'held', holder: { pid: 0, purpose: '(being written)', home: '', at_ms: mtimeMs } };
    }
    return { state: 'stale', reason: 'malformed lock file' };
  }
  if (!isAlive(holder.pid)) return { state: 'stale', reason: `holder pid=${holder.pid} is gone` };
  if (nowMs - holder.at_ms > staleMs) {
    return { state: 'stale', reason: `held by pid=${holder.pid} for over ${Math.round(staleMs / 60_000)}min` };
  }
  return { state: 'held', holder };
}

export class HostLockBusyError extends Error {
  readonly code = 'EHOSTLOCKBUSY';
  constructor(readonly holder: HostLockHolder, readonly path: string) {
    super(
      `${path} is held by pid=${holder.pid} (${holder.purpose || 'unknown'}` +
        `${holder.home ? `, home ${holder.home}` : ''}) since ${new Date(holder.at_ms).toISOString()}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 잠금을 쥔다. 다른 살아 있는 프로세스가 쥐고 있으면 `waitMs` 까지 기다리고, 그래도 못 쥐면
 * HostLockBusyError 를 던진다. 돌려준 함수로 푼다(자기 pid 가 적힌 파일만 지운다).
 */
export async function acquireHostLock(
  path: string,
  purpose: string,
  opts: {
    waitMs?: number;
    pollMs?: number;
    staleMs?: number;
    home?: string;
    onWait?: (holder: HostLockHolder) => void;
    /**
     * 잠금을 다른 프로세스 이름으로 쥔다 — 매니저가 곧 종료하고 업데이터 헬퍼가 이어서 설치할 때,
     * 매니저가 내려가는 순간부터 헬퍼가 잠금을 잡기까지의 틈을 없앤다(PC.VX 11-05: 그 틈에 예약
     * 작업이 매니저를 띄워 설치 도중의 빌드로 부팅했다). 헬퍼는 자기 pid 가 적힌 잠금을 쥔 것으로 본다.
     */
    holderPid?: number;
  } = {},
): Promise<() => void> {
  const deadline = Date.now() + (opts.waitMs ?? 0);
  const pollMs = opts.pollMs ?? 1000;
  const holderPid = opts.holderPid ?? process.pid;
  let announced = false;
  mkdirSync(dirname(path), { recursive: true });
  for (;;) {
    const mine: HostLockHolder = { pid: holderPid, purpose, home: opts.home ?? AGENT_MANAGER_HOME, at_ms: Date.now() };
    try {
      writeFileSync(path, JSON.stringify(mine), { encoding: 'utf8', flag: 'wx' });
      return () => {
        const current = inspectHostLock(path, { isAlive: () => true, staleMs: Number.POSITIVE_INFINITY });
        if (current.state === 'held' && current.holder.pid === holderPid) removeFile(path);
      };
    } catch (err: any) {
      // Windows 는 지워지는 중인 파일에 EPERM 을 준다 — 곧 사라지므로 다시 돈다.
      if (err?.code !== 'EEXIST' && err?.code !== 'EPERM') throw err;
    }
    const state = inspectHostLock(path, { staleMs: opts.staleMs });
    if (state.state === 'stale' || state.state === 'free') {
      if (state.state === 'stale') removeFile(path);
      continue;
    }
    if (Date.now() >= deadline) throw new HostLockBusyError(state.holder, path);
    if (!announced) {
      announced = true;
      opts.onWait?.(state.holder);
    }
    await sleep(Math.max(10, Math.min(pollMs, deadline - Date.now())));
  }
}

/** 공유 디렉터리가 없으면(공유 꺼짐) 잠그지 않고 그냥 돈다. */
export async function withHostLock<T>(
  hostDir: string | null,
  name: string,
  purpose: string,
  fn: () => Promise<T>,
  opts: Parameters<typeof acquireHostLock>[2] = {},
): Promise<T> {
  if (!hostDir) return fn();
  const release = await acquireHostLock(hostLockPath(hostDir, name), purpose, opts);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** 다른 프로세스가 지금 그 잠금을 쥐고 있는가(낡은 잠금은 쥔 것이 아니다). */
export function liveHostLockHolder(hostDir: string | null, name: string): HostLockHolder | null {
  if (!hostDir) return null;
  const state = inspectHostLock(hostLockPath(hostDir, name));
  return state.state === 'held' ? state.holder : null;
}

// ─── 변경 알림(stamp) ────────────────────────────────────────────────────────
//
// 한 인스턴스가 이 장비의 CLI 나 ACP 어댑터를 올리면, 다른 인스턴스는 그 사실을 모른 채
// 몇 시간 동안 옛 버전을 보고했다(CLI 설치본 재열거는 3시간 주기다). 올린 쪽이 stamp 를
// 남기고, 다른 쪽은 하트비트마다 stamp 시각만 비교해 바뀌었을 때 다시 읽는다.

export type HostStampTopic = 'cli-installs' | 'acp-adapters';

function stampPath(hostDir: string, topic: HostStampTopic): string {
  return join(hostDir, 'stamps', `${topic}.json`);
}

export function bumpHostStamp(hostDir: string | null, topic: HostStampTopic, detail = ''): void {
  if (!hostDir) return;
  try {
    writeJson(stampPath(hostDir, topic), { at_ms: Date.now(), pid: process.pid, home: AGENT_MANAGER_HOME, detail });
  } catch {
    /* 알림 실패가 업데이트 결과를 바꾸지는 않는다 — 다른 인스턴스는 주기 재열거에서 따라온다 */
  }
}

/** stamp 를 남긴 시각과 남긴 프로세스. 없으면 null. */
export function readHostStamp(hostDir: string | null, topic: HostStampTopic): { at_ms: number; pid: number } | null {
  if (!hostDir) return null;
  const raw = readJson(stampPath(hostDir, topic));
  const at = Number(raw?.at_ms);
  const pid = Number(raw?.pid);
  return Number.isFinite(at) ? { at_ms: at, pid: Number.isInteger(pid) ? pid : 0 } : null;
}

/**
 * stamp 를 지켜보다 **다른 프로세스가** 남긴 새 stamp 만 알려준다. 처음 한 번은 기준만 잡는다
 * (부팅 직후에는 어차피 전부 새로 읽었다).
 */
export class HostStampWatcher {
  #seen = new Map<HostStampTopic, number>();
  constructor(private readonly hostDir: string | null) {}

  changed(topic: HostStampTopic): boolean {
    const stamp = readHostStamp(this.hostDir, topic);
    const at = stamp?.at_ms ?? 0;
    if (!this.#seen.has(topic)) {
      this.#seen.set(topic, at);
      return false;
    }
    const prev = this.#seen.get(topic)!;
    if (at === prev) return false;
    this.#seen.set(topic, at);
    return Boolean(stamp) && stamp!.pid !== process.pid;
  }
}

// ─── 매니저 설치본의 부팅 검증 표시 ─────────────────────────────────────────
//
// 설치한 인스턴스가 새 빌드의 부팅 검증(하트비트 1회 성공)을 기다리는 동안 다른 인스턴스는
// 그 빌드로 따라 올라가지 않는다 — 검증이 실패하면 설치한 쪽이 디스크를 되돌리기 때문이다.
// 검증은 **어느 인스턴스든** 그 빌드로 하트비트를 한 번 성공하면 끝난다(빌드는 하나다).

export interface HostVerifyRecord {
  version: string;
  previous_version: string;
  phase: 'verifying' | 'verified';
  home: string;
  pid: number;
  at_ms: number;
}

/** 검증을 기다리는 표시가 이보다 오래되면 설치한 쪽이 돌아오지 못한 것으로 본다. */
export const HOST_VERIFY_WAIT_MAX_MS = 12 * 60_000;

export function hostVerifyPath(stateDir: string): string {
  return join(stateDir, 'boot-verify.json');
}

export function readHostVerify(stateDir: string | null): HostVerifyRecord | null {
  if (!stateDir) return null;
  const raw = readJson(hostVerifyPath(stateDir));
  if (!raw || typeof raw !== 'object') return null;
  const version = typeof raw.version === 'string' ? raw.version : '';
  if (!/^\d+\.\d+\.\d+/.test(version)) return null;
  const phase = raw.phase === 'verified' ? 'verified' : raw.phase === 'verifying' ? 'verifying' : null;
  if (!phase) return null;
  return {
    version,
    previous_version: typeof raw.previous_version === 'string' ? raw.previous_version : '',
    phase,
    home: typeof raw.home === 'string' ? raw.home : '',
    pid: Number.isInteger(Number(raw.pid)) ? Number(raw.pid) : 0,
    at_ms: Number.isFinite(Number(raw.at_ms)) ? Number(raw.at_ms) : 0,
  };
}

export function writeHostVerify(stateDir: string | null, record: Omit<HostVerifyRecord, 'home' | 'pid' | 'at_ms'>): void {
  if (!stateDir) return;
  try {
    writeJson(hostVerifyPath(stateDir), {
      ...record,
      home: AGENT_MANAGER_HOME,
      pid: process.pid,
      at_ms: Date.now(),
    } satisfies HostVerifyRecord);
  } catch {
    /* 표시를 못 남기면 다른 인스턴스가 검증을 기다리지 않을 뿐이다 */
  }
}

export function clearHostVerify(stateDir: string | null): void {
  if (stateDir) removeFile(hostVerifyPath(stateDir));
}

/** 그 버전이 아직 검증 중인가(낡은 표시는 검증 중이 아니다). */
export function hostVerifyPending(
  record: HostVerifyRecord | null,
  version: string,
  nowMs: number = Date.now(),
): boolean {
  return Boolean(
    record && record.phase === 'verifying' && record.version === version && nowMs - record.at_ms < HOST_VERIFY_WAIT_MAX_MS,
  );
}
