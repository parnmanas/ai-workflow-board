// "이 CLI 의 최신 배포 버전은 몇인가" — `update_cli` 버튼이 눌릴 필요가 있는지
// 판정하는 입력. 매니저 자신의 UpdateChecker(self-update.ts)가 awb-agent-manager
// 에 대해 하는 일을, 그 매니저가 spawn 하는 CLI 들에 대해 한다.
//
// 이게 없으면 화면은 "설치된 버전" 만 알고 최신 여부를 모르므로, Update 버튼이
// 영원히 눌리는 채로 남고 운영자는 눌러 보기 전에는 올릴 게 있는지 알 수 없다.
// (실제 신고: 이미 최신인 CLI 의 버튼이 계속 활성이라 몇 번이고 다시 눌렀다.)
//
// 질의는 `npm view <spec> version` 하나뿐이다 — CLI 마다 다른 배포 채널을
// 추측하지 않는다. 어떤 패키지를 볼지는 어댑터가 `updatePackage()` 로 알려 주고,
// 그 값이 null 인 CLI(자체 업데이터가 없거나 npm 배포가 아닌 것)는 결과에서
// **키 자체가 빠진다** — "최신을 모른다" 가 "최신이다" 로 둔갑하면 안 된다.

import { spawn } from 'node:child_process';
import { createAdapter } from './cli-adapters/index.js';

/** self-update 의 npm view 와 같은 상한. 레지스트리 왕복 한 번이다. */
export const NPM_VIEW_TIMEOUT_MS = 30_000;

/** 최신 버전 재조회 주기. CLI 배포는 시간 단위로 움직이므로 하트비트(30초)와
 *  같은 박자로 레지스트리를 칠 이유가 없다. 방금 올린 직후에는 update_cli 가
 *  이 타이머와 무관하게 한 번 더 읽어, 버튼이 즉시 비활성으로 접힌다. */
export const CLI_LATEST_REFRESH_MS = 3 * 60 * 60 * 1000;

export interface CliLatestDeps {
  /** `npm view <spec> version` 대체. 성공 시 stdout 을 그대로 돌려준다. */
  npmView?: (spec: string) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  log?: (msg: string) => void;
}

function defaultNpmView(spec: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Windows 는 npm.cmd 라 shell:true 가 필요하다(self-update.runAsync 와 같은 이유).
    const child = spawn('npm', ['view', spec, 'version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      stderr += `\n[timeout after ${NPM_VIEW_TIMEOUT_MS}ms]`;
      finish(false);
    }, NPM_VIEW_TIMEOUT_MS);
    child.stdout?.on('data', (b) => {
      stdout += String(b);
    });
    child.stderr?.on('data', (b) => {
      stderr += String(b);
    });
    child.on('error', (err: any) => {
      stderr += `\n[spawn error: ${err?.message ?? err}]`;
      finish(false);
    });
    child.on('close', (code) => finish(code === 0));
  });
}

/** `npm view <pkg> version` 은 bare 버전 한 줄만 찍는다("1.2.3\n"). 그 외의
 *  출력(경고 섞임, 빈손)은 파싱 실패로 보고 버린다 — 잘못 읽은 값으로 "업데이트
 *  있음" 을 만들어 내는 것이 모르는 것보다 나쁘다. */
export function parseNpmViewVersion(stdout: string): string | null {
  const last = stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  return last && /^\d+\.\d+\.\d+/.test(last) ? last : null;
}

/**
 * 주어진 CLI 들의 최신 배포 버전을 모은다(cliType → 버전). 같은 npm 패키지를
 * 공유하는 CLI(deepseek → claude)는 레지스트리를 한 번만 치고 결과를 함께
 * 받는다 — 설치본이 하나이므로 최신 기준도 하나다.
 *
 * 절대 throw 하지 않는다. 조회에 실패한 CLI 는 키가 빠질 뿐이고, 호출자(하트비트)는
 * 그 CLI 를 "최신 여부 모름" 으로 계속 표시한다.
 */
export async function fetchCliLatestVersions(
  clis: Iterable<string>,
  deps: CliLatestDeps = {},
): Promise<Record<string, string>> {
  const npmView = deps.npmView ?? defaultNpmView;
  const log = deps.log ?? (() => {});

  // npm 스펙 → 그 스펙을 공유하는 cliType 들.
  const bySpec = new Map<string, string[]>();
  for (const cli of clis) {
    let spec: string | null = null;
    try {
      spec = createAdapter(cli).updatePackage();
    } catch {
      // 어댑터가 없는 이름(gh/git 처럼 같은 probe 에 섞여 오는 것들) — 조용히 건너뛴다.
      continue;
    }
    if (!spec) continue;
    const list = bySpec.get(spec) ?? [];
    if (!list.includes(cli)) list.push(cli);
    bySpec.set(spec, list);
  }

  const out: Record<string, string> = {};
  for (const [spec, sharing] of bySpec) {
    try {
      const r = await npmView(spec);
      const version = r.ok ? parseNpmViewVersion(r.stdout) : null;
      if (!version) {
        const reason =
          (r.stderr.trim() || r.stdout.trim() || 'no output').split('\n').filter(Boolean).pop() ?? '';
        log(`[cli-latest] npm view ${spec} failed: ${reason.slice(0, 200)}`);
        continue;
      }
      for (const cli of sharing) out[cli] = version;
    } catch (err: any) {
      log(`[cli-latest] npm view ${spec} threw: ${err?.message ?? err}`);
    }
  }
  return out;
}
