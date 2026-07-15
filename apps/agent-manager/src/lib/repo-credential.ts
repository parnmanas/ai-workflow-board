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
import { isAbsolute, join, resolve as pathResolve } from 'node:path';
import { execFile } from 'node:child_process';

const GIT_TIMEOUT_MS = 20_000;

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
