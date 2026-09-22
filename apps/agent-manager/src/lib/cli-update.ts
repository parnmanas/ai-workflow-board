// Runtime Host 에 설치된 CLI 자체를 최신으로 올린다 — `update_cli` 커맨드의 알맹이.
//
// 매니저 자신의 self-update(self-update.ts)와는 다른 축이다: 저쪽은 awb-agent-manager
// 패키지를, 이쪽은 그 매니저가 spawn 하는 CLI(claude / codex / …)를 올린다. 어떻게
// 올리는지는 CLI 마다 다르므로 어댑터가 `cliUpdate()` 로 알려 주고(자체 업데이터가
// 없으면 null), 여기서는 그 argv 를 해석된 바이너리에 붙여 돌리고 전후 버전을 다시
// 읽는 일만 한다.
//
// **범위는 에이전트가 아니라 장비다.** CLI 는 전역 설치라, 한 에이전트를 통해 올려도
// 같은 호스트의 모든 에이전트·세션이 즉시 새 바이너리를 쓴다. 호출자는 그 사실을
// ack 메시지에 남긴다(hostLabel).

import crossSpawn from 'cross-spawn';
import { hostname } from 'node:os';
import { createAdapter } from './cli-adapters/index.js';
import { checkAuxiliaryCli } from './runtime/runtime-health.js';

/** 업데이터가 이만큼 안 끝나면 죽인다. npm 레지스트리 왕복 + 설치라 넉넉히 잡되,
 *  무한정 기다려 커맨드 ack 를 영원히 붙잡아 두지는 않는다. */
export const CLI_UPDATE_TIMEOUT_MS = 10 * 60 * 1000;

export interface CliUpdateOutcome {
  supported: boolean;
  ok: boolean;
  before: string | null;
  after: string | null;
  detail: string;
  hostLabel: string;
}

export interface CliUpdateDeps {
  /** argv 를 돌리고 (성공여부, 합쳐진 출력)을 돌려준다. 테스트가 갈아끼운다. */
  run?: (bin: string, args: string[], timeoutMs: number) => Promise<{ ok: boolean; output: string }>;
  /** `--version` 재측정. 기본은 부팅 로그와 같은 checkAuxiliaryCli 라 같은 경로 해석을 탄다. */
  probeVersion?: (cli: string) => Promise<string | null>;
  hostLabel?: string;
  log?: (msg: string) => void;
}

function defaultRun(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    // cross-spawn: Windows 의 npm 배치 shim(`claude.cmd`)은 node spawn 으로 직접
    // 실행되지 않는다 — 세션 어댑터와 같은 이유로 여기서도 cross-spawn 을 쓴다.
    const child = crossSpawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    });
    let output = '';
    let settled = false;
    const finish = (ok: boolean, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, output: (output + extra).trim() });
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(false, `\n[timeout after ${timeoutMs}ms]`);
    }, timeoutMs);
    child.stdout?.on('data', (b) => {
      output += String(b);
    });
    child.stderr?.on('data', (b) => {
      output += String(b);
    });
    child.on('error', (err: any) => finish(false, `\n[spawn error: ${err?.message ?? err}]`));
    child.on('close', (code) => finish(code === 0, code === 0 ? '' : `\n[exit ${code}]`));
  });
}

async function defaultProbeVersion(cli: string): Promise<string | null> {
  const r = await checkAuxiliaryCli(cli);
  return r.installed ? (r.version ?? null) : null;
}

/** 출력이 길면 ack 메시지가 통째로 로그를 삼키므로 꼬리만 남긴다 — 실패 사유는
 *  보통 마지막 몇 줄에 있다. */
function tail(output: string, max = 400): string {
  const trimmed = output.trim();
  if (trimmed.length <= max) return trimmed;
  return `…${trimmed.slice(-max)}`;
}

/**
 * 한 CLI 를 올린다. 절대 throw 하지 않고 결과를 돌려준다 — 호출자(커맨드 핸들러)가
 * supported/ok 를 보고 ack 문구를 정한다.
 */
export async function runCliUpdate(cli: string, deps: CliUpdateDeps = {}): Promise<CliUpdateOutcome> {
  const hostLabel = deps.hostLabel ?? hostname() ?? 'this host';
  const run = deps.run ?? defaultRun;
  const probeVersion = deps.probeVersion ?? defaultProbeVersion;
  const log = deps.log ?? (() => {});

  let updater: { args: string[]; label: string } | null = null;
  let bin = cli;
  try {
    const adapter = createAdapter(cli);
    updater = adapter.cliUpdate();
    if (updater) bin = adapter.resolveBin();
  } catch (err: any) {
    return {
      supported: false,
      ok: false,
      before: null,
      after: null,
      detail: `cannot resolve ${cli}: ${err?.message ?? err}`,
      hostLabel,
    };
  }
  if (!updater) {
    return { supported: false, ok: false, before: null, after: null, detail: 'no self-updater', hostLabel };
  }

  const before = await probeVersion(cli);
  log(`[cli-update] ${updater.label} on ${hostLabel} (current ${before ?? 'unknown'})`);
  const result = await run(bin, updater.args, CLI_UPDATE_TIMEOUT_MS);
  const after = await probeVersion(cli);
  log(
    `[cli-update] ${updater.label} ${result.ok ? 'ok' : 'FAILED'}: ${before ?? 'unknown'} → ${after ?? 'unknown'}`,
  );
  return {
    supported: true,
    ok: result.ok,
    before,
    after,
    detail: tail(result.output) || (result.ok ? `${updater.label} finished` : `${updater.label} failed`),
    hostLabel,
  };
}
