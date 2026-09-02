// 공유 repo credential 헬퍼 (ticket 622bc350).
//
// agent-manager 의 git-네트워크 프로비저닝 경로들 — worktree-manager 의 컨테이너
// base clone, run-provisioner 의 QA/보안 run clone — 이 각자 credential 주입을
// 라인단위로 중복 구현하던 것을 한 곳으로 통합한다. 새로 생기는 clone/fetch 경로는
// 반드시 이 모듈을 경유하게 해, 어떤 git-네트워크 경로도 구조적으로 credential-blind
// 될 수 없게 만드는 것이 목적이다 (직전까지 반복된 "새 경로 credential 누락 → private
// repo 프로비저닝 실패 → 프로덕션 핫패치" 재발 차단).
//
// 4가지 관심사를 캡슐화한다:
//   1. authenticatedCloneUrl — https(s) clone URL 에 `username:token@host` 주입 (순수)
//   2. scrubOriginUrl        — clone 직후 origin 을 토큰 없는 clean URL 로 되돌림
//   3. installRepoCredential — `.git/awb-credentials`(0600) + credential.helper=store
//   4. maskCredential        — 로그/steps 출력에서 토큰 문자열 마스킹 (순수)
//
// installRepoCredential 은 checkout 의 PRIMARY 디렉터리에서 호출한다: `rev-parse
// --absolute-git-dir` 로 공용 `.git` 을 절대경로로 해석하므로 primary + 링크된
// worktree 가 동일한 credential 파일/헬퍼를 상속한다. 모든 부수효과 함수는
// best-effort(never-throw) — credential 설치 실패가 dispatch 를 막지 않는다.

import { promises as fsp } from 'node:fs';
import { dirname, isAbsolute, join, resolve as pathResolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { terminateDetachedProcessTree } from './process-tree.js';

const GIT_TIMEOUT_MS = 20_000;

// ── clone 정책 (ticket bddb63ee) ─────────────────────────────────────────────
//
// 대형 저장소의 첫 clone 이 고정 20분 wall-clock 에 걸려 프로비저닝이 통째로
// 실패하던 문제를 없앤다. 예산과 clone 전략은 서버가 Repo Resource ⊕ Workspace
// 기본값으로 해석해 `clone_policy` 로 실어 보내고, 여기서 clone argv + 타이머로
// 번역된다. 정책이 없으면(구버전 서버, 미설정 저장소) 아래 시스템 기본값이
// 그대로 적용되므로 **설정이 전혀 없는 기존 저장소도 60분 예산**을 받는다.

/** 시스템 기본 clone wall-clock 예산 — 60분(서버 DEFAULT_CLONE_TIMEOUT_SECONDS 와 동일). */
export const DEFAULT_CLONE_TIMEOUT_MS = 3600_000;
/** 시스템 기본 idle 예산 — 10분. clone 진행 출력이 이만큼 완전히 끊겨야 정지로 본다. */
export const DEFAULT_CLONE_IDLE_TIMEOUT_MS = 600_000;
/** 정책 값의 상한 — 악의적/오타 payload 가 사실상 무한 대기를 만들지 못하게 한다. */
const MAX_CLONE_TIMEOUT_MS = 86_400_000;
const MIN_CLONE_TIMEOUT_MS = 60_000;
/** `--filter` 화이트리스트. `-` 로 시작하는 값이 git 플래그로 해석되는 것을 막는다. */
const CLONE_FILTER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:=+._-]*$/;

/** 서버 ResolvedClonePolicy 의 wire 미러. agent-manager 는 별도 패키지라
 *  ResolvedEnvironmentConfig / HarnessSpec 과 동일하게 형태만 복제한다. */
export interface CloneWirePolicy {
  clone_timeout_seconds?: number | null;
  clone_idle_timeout_seconds?: number | null;
  clone_depth?: number | null;
  clone_filter?: string | null;
  single_branch?: boolean | null;
}

export interface ResolvedCloneOptions {
  /** clone 전체 wall-clock 예산(ms). */
  timeoutMs: number;
  /** 무출력 허용 시간(ms). 0 = idle 판정 비활성. */
  idleTimeoutMs: number;
  /** `git clone` 에 덧붙일 전략 플래그 (`--depth` / `--filter` / `--single-branch`). */
  strategyArgs: string[];
}

function clampMs(seconds: unknown, fallbackMs: number, minMs: number): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return fallbackMs;
  const ms = Math.round(seconds * 1000);
  if (ms <= 0) return minMs === 0 ? 0 : fallbackMs;
  return Math.min(Math.max(ms, minMs), MAX_CLONE_TIMEOUT_MS);
}

/**
 * wire 정책 → 구체적인 타이머/argv. wire 값은 절대 신뢰하지 않는다: 범위를 벗어난
 * 숫자는 clamp 하고, 화이트리스트를 벗어난 filter 나 비정수 depth 는 조용히 버린다
 * (정책 하나가 잘못됐다고 clone 전체를 실패시키지 않는다 — availability-first).
 */
export function resolveCloneOptions(policy?: CloneWirePolicy | null): ResolvedCloneOptions {
  const timeoutMs = clampMs(policy?.clone_timeout_seconds, DEFAULT_CLONE_TIMEOUT_MS, MIN_CLONE_TIMEOUT_MS);
  // idle 은 0(비활성)이 유효값이므로 min 을 0 으로 둔다.
  const rawIdle = policy?.clone_idle_timeout_seconds;
  const idleTimeoutMs = rawIdle === 0
    ? 0
    : clampMs(rawIdle, DEFAULT_CLONE_IDLE_TIMEOUT_MS, 1_000);
  const strategyArgs: string[] = [];
  const depth = policy?.clone_depth;
  if (typeof depth === 'number' && Number.isInteger(depth) && depth > 0) {
    strategyArgs.push(`--depth=${depth}`);
  }
  const filter = typeof policy?.clone_filter === 'string' ? policy.clone_filter.trim() : '';
  if (filter && filter.length <= 64 && CLONE_FILTER_PATTERN.test(filter)) {
    strategyArgs.push(`--filter=${filter}`);
  }
  if (policy?.single_branch === true) strategyArgs.push('--single-branch');
  return { timeoutMs, idleTimeoutMs, strategyArgs };
}

/**
 * flattened SSE event 의 `clone_policy` 필드를 wire 형태로 좁힌다. 객체가 아니면
 * (필드 없음 / null / 구버전 서버 / 손상된 payload) null — 호출자는 그대로
 * `resolveCloneOptions` 에 넘기고 시스템 기본값을 받는다. 개별 키의 값 검증은
 * `resolveCloneOptions` 가 담당하므로 여기서는 형태만 본다. 절대 throw 하지 않는다.
 */
export function parseClonePolicy(raw: unknown): CloneWirePolicy | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const policy: CloneWirePolicy = {
    clone_timeout_seconds: typeof r.clone_timeout_seconds === 'number' ? r.clone_timeout_seconds : undefined,
    clone_idle_timeout_seconds: typeof r.clone_idle_timeout_seconds === 'number' ? r.clone_idle_timeout_seconds : undefined,
    clone_depth: typeof r.clone_depth === 'number' ? r.clone_depth : undefined,
    clone_filter: typeof r.clone_filter === 'string' ? r.clone_filter : undefined,
    single_branch: typeof r.single_branch === 'boolean' ? r.single_branch : undefined,
  };
  return Object.values(policy).some((v) => v !== undefined) ? policy : null;
}

/** repository Resource 의 https 인증 자격. worktree 의 `bootstrapRepo.credential`
 *  과 run-provisioner 의 `RunRepoSpec.credential` 이 공유하는 wire 형태 — 서버가
 *  Resource 토큰을 복호화해 실어보낸 값이다. */
export interface RepoCredential {
  username?: string;
  token: string;
}

interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * 토큰을 argv나 origin URL에 넣지 않고 clone하고, 성공한 repo에 영구 helper를 설치한다.
 *
 * clone 예산/전략은 `policy`(서버가 Repo Resource ⊕ Workspace 로 해석해 실어보낸
 * 값)에서 나오며, 없으면 시스템 기본값(60분 wall-clock / 10분 idle / 전체 clone)이
 * 적용된다. `timeoutMs` 를 명시하면 정책의 wall-clock 예산을 덮어쓴다(호출자 전용
 * escape hatch).
 */
export async function cloneWithRepoCredential(args: {
  url: string;
  dir: string;
  branch?: string;
  credential?: RepoCredential | null;
  timeoutMs?: number;
  policy?: CloneWirePolicy | null;
}): Promise<GitRun> {
  const cleanUrl = args.url.trim();
  const credential = args.credential;
  await fsp.mkdir(dirname(args.dir), { recursive: true });
  let temporaryCredentialFile: string | null = null;
  const configArgs: string[] = [];
  if (credential?.token && /^https?:\/\//i.test(cleanUrl)) {
    temporaryCredentialFile = join(dirname(args.dir), `.awb-clone-credential-${randomUUID()}`);
    const u = new URL(cleanUrl);
    u.username = credential.username || 'x-access-token';
    u.password = credential.token;
    await fsp.writeFile(temporaryCredentialFile, `${u.toString()}\n`, { mode: 0o600 });
    configArgs.push('-c', `credential.helper=store --file=${JSON.stringify(temporaryCredentialFile)}`);
  }
  try {
    const opts = resolveCloneOptions(args.policy);
    const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0
      ? args.timeoutMs
      : opts.timeoutMs;
    const branchArgs = args.branch?.trim() ? ['--branch', args.branch.trim()] : [];
    // `--progress` 는 idle 판정이 켜져 있을 때만 붙인다. git 은 stderr 가 TTY 가
    // 아니면 진행 출력을 아예 내지 않으므로, 이 플래그가 없으면 "정상적으로 오래
    // 걸리는 clone" 과 "완전히 멈춘 clone" 이 구분되지 않아 모든 대형 clone 이
    // idle 로 오판된다. idle 이 꺼져 있으면 stderr 를 깨끗하게 유지한다.
    const progressArgs = opts.idleTimeoutMs > 0 ? ['--progress'] : [];
    const result = await runCloneProcess(
      [...configArgs, 'clone', ...progressArgs, ...opts.strategyArgs, ...branchArgs, '--', cleanUrl, args.dir],
      timeoutMs,
      opts.idleTimeoutMs,
    );
    if (result.ok) await installRepoCredential(args.dir, cleanUrl, credential);
    return result;
  } finally {
    if (temporaryCredentialFile) await fsp.unlink(temporaryCredentialFile).catch(() => {});
  }
}

/** stderr/stdout 누적 상한. 진행 출력이 길어질 수 있으므로 tail 만 남긴다 —
 *  git 의 치명적 오류 메시지는 언제나 마지막에 쓰이므로 진단은 보존된다. */
const CLONE_OUTPUT_TAIL_LIMIT = 64 * 1024;

function appendBounded(buffer: string, chunk: string): string {
  const next = buffer + chunk;
  return next.length > CLONE_OUTPUT_TAIL_LIMIT ? next.slice(next.length - CLONE_OUTPUT_TAIL_LIMIT) : next;
}

/**
 * `git clone` 을 **자체 프로세스 그룹**으로 띄우고 wall-clock + idle 두 예산으로
 * 감시한다. execFile 의 `timeout` 옵션을 쓰지 않는 이유는 두 가지다:
 *
 *   1. execFile 은 **직계 자식에게만** 시그널을 보낸다. `git clone` 은
 *      `git-remote-https` / `index-pack` 같은 하위 프로세스를 띄우므로, 상위만
 *      죽이면 실제로 네트워크/CPU 를 쓰는 자식들이 그대로 살아남아 다음 dispatch
 *      의 clone 대상 디렉터리를 계속 건드린다. `detached: true` 로 그룹 리더를
 *      만들고 그룹 전체에 시그널을 보내야 잔존 프로세스가 남지 않는다.
 *   2. execFile 에는 idle(무출력) 판정이 없다. 진행 중인 clone 은 아무리 오래
 *      걸려도 끊지 않고, 완전히 멈춘 연결만 조기 회수하려면 데이터 수신 시각을
 *      직접 추적해야 한다.
 *
 * 종료 시퀀스는 SIGTERM(그룹) → grace → SIGKILL(그룹) 이다. 첫 신호를 SIGTERM 으로
 * 두는 것은 의도적이다 — `git clone` 은 SIGTERM 핸들러에서 반쯤 만들어진 대상
 * 디렉터리를 스스로 지우므로, 다음 시도가 "destination path already exists" 로
 * 깨지지 않는다. abort 결과는 그 정리가 끝난 뒤에 확정된다(abort 의 (4) 참고).
 */
function runCloneProcess(gitArgs: string[], timeoutMs: number, idleTimeoutMs: number): Promise<GitRun> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let abortReason: string | null = null;
    let wallTimer: NodeJS.Timeout | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    let killBackstop: NodeJS.Timeout | null = null;

    const child = spawn('git', gitArgs, {
      // POSIX: 자체 프로세스 그룹 리더로 만들어 `kill(-pid)` 로 하위까지 한 번에
      // 정리한다. win32 는 그룹 개념이 없어 taskkill /T 로 트리를 정리한다
      // (terminateDetachedProcessTree 가 플랫폼 분기를 담당).
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const clearTimers = () => {
      if (wallTimer) clearTimeout(wallTimer);
      if (idleTimer) clearTimeout(idleTimer);
      wallTimer = null;
      idleTimer = null;
    };

    const clearBackstop = () => {
      if (killBackstop) clearTimeout(killBackstop);
      killBackstop = null;
    };

    // 정리 완료를 기다릴 수 있게 kill promise 를 보관한다. 호출자가 실패를
    // 돌려받은 시점에는 clone 프로세스 그룹이 이미 정리돼 있어야 한다 — 그러지
    // 않으면 호출자가 대상 디렉터리를 지우거나 재시도하는 동안 git 하위
    // 프로세스가 같은 경로를 계속 건드린다.
    let killPromise: Promise<void> | null = null;

    const abort = (reason: string) => {
      if (abortReason || settled) return;
      abortReason = reason;
      clearTimers();
      // 1) 직계 자식에게 먼저 SIGTERM. 그룹 시그널(`kill(-pgid)`)은 detached 가
      //    실제로 적용됐을 때만 유효한데, 그게 실패하면 아래 그룹 정리는 ESRCH 로
      //    아무것도 죽이지 못하고 'close' 도 영영 오지 않아 clone 이 무한 대기에
      //    빠진다. 리더만이라도 확실히 끝내 두면 어떤 경우에도 결과가 확정된다.
      try { child.kill('SIGTERM'); } catch { /* 이미 종료됨 */ }
      const pid = child.pid;
      if (typeof pid === 'number' && pid > 0) {
        // 2) 그룹 전체 정리(SIGTERM → grace → SIGKILL + 생존자 스윕). 시그널은 즉시
        //    발사되고, 완료 대기는 아래 (4) 가 맡는다.
        killPromise = terminateDetachedProcessTree(pid, CLONE_KILL_GRACE_MS).catch(() => {});
      }
      // 3) backstop — SIGTERM 을 무시하는 리더가 있어도 반드시 종료시킨다.
      killBackstop = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* 이미 종료됨 */ }
      }, CLONE_KILL_GRACE_MS + 500);
      killBackstop.unref?.();
      // 4) 정리가 끝나면 'close' 를 기다리지 않고 결과를 확정한다. 'close' 는
      //    자식이 죽어도 **stdio 파이프가 모두 닫혀야** 발사되는데, 살아남은
      //    손자 프로세스가 상속받은 stderr 를 붙들고 있으면 영영 오지 않는다.
      //    그 경우까지 timeout 이 결과를 돌려주지 못하면 clone 전체가 무한
      //    대기에 빠지므로, abort 경로의 확정 조건은 '그룹 정리 완료' 로 둔다.
      void Promise.resolve(killPromise).then(() => finishAbort());
    };

    /** abort 확정 — 그룹 정리 후 결과를 돌려주고, 남은 파이프는 놓아준다. */
    const finishAbort = () => {
      if (settled) return;
      // 파이프를 붙들고 있는 손자 때문에 이벤트 루프가 잡히지 않도록 명시적으로
      // 끊는다. 이 시점의 출력은 이미 버퍼에 모여 있다.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref?.();
      finish(false, `git clone aborted: ${abortReason} — clone process group terminated`);
    };

    const bumpIdle = () => {
      if (idleTimeoutMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => abort(`no clone progress output for ${Math.round(idleTimeoutMs / 1000)}s (clone_idle_timeout_seconds)`),
        idleTimeoutMs,
      );
    };

    wallTimer = setTimeout(
      () => abort(`clone exceeded ${Math.round(timeoutMs / 1000)}s (clone_timeout_seconds)`),
      timeoutMs,
    );
    bumpIdle();

    child.stdout?.on('data', (d) => { stdout = appendBounded(stdout, d.toString()); bumpIdle(); });
    child.stderr?.on('data', (d) => { stderr = appendBounded(stderr, d.toString()); bumpIdle(); });

    const finish = (ok: boolean, extraStderr?: string) => {
      if (settled) return;
      settled = true;
      clearTimers();
      clearBackstop();
      resolve({
        ok,
        stdout,
        stderr: extraStderr ? `${stderr}${stderr && !stderr.endsWith('\n') ? '\n' : ''}${extraStderr}` : stderr,
      });
    };

    child.on('error', (err: any) => {
      clearTimers();
      clearBackstop();
      finish(false, String(err?.message ?? err));
    });
    child.on('close', (code) => {
      // abort 중이면 확정은 finishAbort 가 맡는다 — 리더가 SIGTERM 에 먼저
      // 응답해 'close' 가 빨리 와도 하위 프로세스는 아직 살아 있을 수 있으므로,
      // 그룹 정리가 끝나기 전에 성공/실패를 돌려주지 않는다.
      if (abortReason) return;
      finish(code === 0);
    });
  });
}

/** abort 시 SIGTERM 후 SIGKILL 까지 주는 유예. git clone 이 junk 디렉터리를
 *  스스로 지울 시간을 확보하되, 실패 경로가 지나치게 늘어지지 않는 값. */
const CLONE_KILL_GRACE_MS = 2_000;

/** 모듈 내부 전용 `git -C <cwd> <args...>` 러너. never-throw — 실패는 { ok:false }.
 *  두 소비자(worktree-manager / run-provisioner)의 git 래퍼에 의존하지 않도록 자체
 *  보유해, 이 모듈이 독립적으로 테스트·재사용된다. */
function runGit(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: (stdout ?? '').toString(),
          stderr: (stderr ?? (err as any)?.message ?? '').toString(),
        });
      },
    );
  });
}

/**
 * https(s) URL 이고 토큰이 있으면 `https://username:token@host/…` 형태로 주입한
 * URL 을, 아니면(비-http 원격, 토큰 없음) 원본 URL 을 그대로 반환한다. 순수 함수.
 * username 미지정 시 GitHub 관례인 `x-access-token` 을 쓴다.
 */
export function authenticatedCloneUrl(url: string, cred?: RepoCredential | null): string {
  const clean = (url || '').trim();
  if (!cred?.token || !/^https?:\/\//i.test(clean)) return clean;
  const u = new URL(clean);
  u.username = cred.username || 'x-access-token';
  u.password = cred.token;
  return u.toString();
}

/**
 * clone 직후 origin 에 남은 토큰-embedded URL 을 토큰 없는 clean URL 로 되돌린다.
 * 토큰을 `git remote -v` / 이후 git 프로세스 args 에 남기지 않기 위함 — 인증은
 * installRepoCredential 이 심는 credential.helper 가 담당한다. best-effort.
 */
export async function scrubOriginUrl(cwd: string, cleanUrl: string): Promise<void> {
  const clean = (cleanUrl || '').trim();
  if (!clean) return;
  await runGit(cwd, ['remote', 'set-url', 'origin', clean]);
}

/**
 * checkout 의 공용 `.git` 밑에 `awb-credentials`(0600) 를 쓰고 credential.helper 를
 * `store --file=<절대경로>` 로 설정한다. 이후 이 checkout 및 링크된 worktree 의
 * fetch/pull/push 가 origin 에 토큰을 노출하지 않고 인증된다.
 *
 * credential.helper 는 각 git 호출의 cwd 에서 실행되므로, 상대 경로
 * `.git/awb-credentials` 는 primary checkout 에선 동작하지만 `.awb/wt/<ticket>`
 * (`.git` 이 pointer 파일)안에선 깨진다 → 절대 경로로 고정해 primary 와 모든 링크
 * worktree 가 동일 토큰을 공유하게 한다.
 *
 * `cwd` 에는 PRIMARY checkout 을 넘길 것(`--absolute-git-dir` 이 공용 `.git` 을
 * 가리킨다). 토큰이 없거나 비-https 원격이면 no-op. best-effort — throw 안 함.
 */
export async function installRepoCredential(
  cwd: string,
  url: string,
  cred?: RepoCredential | null,
): Promise<void> {
  const clean = (url || '').trim();
  if (!cred?.token || !/^https?:\/\//i.test(clean)) return;
  const gitDirResult = await runGit(cwd, ['rev-parse', '--absolute-git-dir']);
  if (!gitDirResult.ok) return;
  const rawGitDir = gitDirResult.stdout.trim();
  const absoluteGitDir = isAbsolute(rawGitDir) ? rawGitDir : pathResolve(cwd, rawGitDir);
  const credentialFile = join(absoluteGitDir, 'awb-credentials');
  const u = new URL(clean);
  u.username = cred.username || 'x-access-token';
  u.password = cred.token;
  await fsp.writeFile(credentialFile, `${u.toString()}\n`, { mode: 0o600 });
  await runGit(cwd, ['config', 'credential.helper', `store --file=${JSON.stringify(credentialFile)}`]);
}

/**
 * 로그/steps 출력에서 credential 을 마스킹한다. clone/fetch 실패 stderr 에 인증
 * URL 이 섞여 나오는 경우를 대비한 방어적 치환 — best-effort(순수).
 *
 * 주의: `authenticatedCloneUrl`/`installRepoCredential` 은 토큰을 WHATWG `URL`
 * (`u.password`) 로 심으므로, 토큰에 URL 예약문자(`:` `?` `#` `/` `@` …)가 있으면
 * git stderr 에는 **percent-encoded** 형태(`tok%3A…`)로 나온다. raw 토큰만 치환하면
 * 이 인코딩 형태가 그대로 노출되므로, 인코딩에 의존하지 않는 구조적 마스킹을 1차
 * 방어선으로 둔다:
 *   1. https(s) URL 의 userinfo(`user:pass@`) 전체를 redact — 토큰이 어떻게
 *      인코딩되든 확실히 사라진다.
 *   2. URL 밖(bare)에 노출된 raw 토큰과, URL 이 실제로 만들어내는 encoded 표현을
 *      둘 다 치환 — 1번을 빠져나간 잔여 커버.
 * 토큰이 없어도 1번(userinfo redact)은 수행한다.
 */
export function maskCredential(text: string, cred?: RepoCredential | null): string {
  let out = text || '';
  if (!out) return out;
  // 1. userinfo 를 통째로 redact. userinfo 안의 예약문자는 전부 percent-encode 되므로
  //    literal `/` `@` `공백` 이 없다 → `[^/\s@]+@` 로 안전하게 `@` 앞까지 잡는다.
  out = out.replace(/(https?:\/\/)[^/\s@]+@/gi, '$1***@');
  const token = cred?.token?.trim();
  if (!token) return out;
  // 2. raw 토큰 + URL 이 심는 encoded 표현(= u.password 게터가 돌려주는 값) 둘 다 제거.
  const forms = new Set<string>([token]);
  try {
    const u = new URL('https://x@h.invalid');
    u.password = token;
    if (u.password) forms.add(u.password);
  } catch {
    /* URL 생성 실패는 무시 — raw 치환만 수행 */
  }
  for (const form of forms) {
    if (form) out = out.split(form).join('***');
  }
  return out;
}
