// ACP 어댑터를 **운영자가** 올리는 경로 (`update_acp_adapter`).
//
// 어댑터는 매니저 의존성으로 번들되지만 범위(`^0.84.0`)에 묶여, 새 어댑터가 나와도 매니저를
// 다시 깔아서는 따라오지 않는다. 그래서 여기서 매니저 홈(`acp-adapters/`)에 최신을 설치하고,
// 해석(bundled-acp.ts `resolveAcpAdapter`)이 managed/bundled 중 더 새 것을 고른다.
//
// 이미 돌고 있는 세션은 옛 어댑터 프로세스를 그대로 쓴다 — 새 세션이나 세션 Restart 부터
// 새 어댑터다. 그 사실은 ack 문구에 싣는다.

import crossSpawn from 'cross-spawn';
import { mkdir } from 'node:fs/promises';

import { managedAdapterRoot, resolveAcpAdapter } from './bundled-acp.js';

/** 어댑터 하나 설치 상한. npm 레지스트리 왕복 + 의존성 몇 개라 넉넉히. */
export const ACP_ADAPTER_UPDATE_TIMEOUT_MS = 5 * 60_000;

export interface AcpAdapterUpdateResult {
  package: string;
  ok: boolean;
  /** 업데이트 전/후에 **실제로 쓰이는** 어댑터 버전(managed/bundled 중 더 새 것). */
  before: string | null;
  after: string | null;
  /** 업데이트 후 어느 쪽이 쓰이는지. */
  source: 'managed' | 'bundled' | null;
  detail: string;
}

export type RunCommand = (
  cmd: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ ok: boolean; output: string }>;

/**
 * `pkg` 의 최신을 매니저 홈에 설치한다. 던지지 않는다 — 실패는 결과의 `ok:false` 와 `detail` 로.
 *
 * `--prefix` 로 홈 디렉터리에 **로컬** 설치한다(`-g` 아님): 전역 prefix 를 건드리지 않으므로
 * 권한 상승이 필요 없고, 다른 CLI 설치와 레이스하지 않으며, 매니저 업데이트에도 살아남는다.
 * 같은 홈을 쓰는 설치끼리는 한 `node_modules` 를 공유하므로 호출자가 직렬화한다.
 */
export async function updateManagedAcpAdapter(
  pkg: string,
  bin: string,
  deps: { run?: RunCommand; log?: (msg: string) => void } = {},
): Promise<AcpAdapterUpdateResult> {
  const run = deps.run ?? defaultRun;
  const log = deps.log ?? (() => {});
  const root = managedAdapterRoot();
  const before = resolveAcpAdapter(pkg, bin)?.version ?? null;
  try {
    await mkdir(root, { recursive: true });
  } catch (err: any) {
    return { package: pkg, ok: false, before, after: before, source: null, detail: `cannot create ${root}: ${err?.message ?? err}` };
  }
  const args = ['install', '--prefix', root, '--no-audit', '--no-fund', `${pkg}@latest`];
  log(`[acp-adapter] npm ${args.join(' ')}`);
  const r = await run('npm', args, ACP_ADAPTER_UPDATE_TIMEOUT_MS);
  const resolved = resolveAcpAdapter(pkg, bin);
  const after = resolved?.version ?? null;
  if (!r.ok) {
    return {
      package: pkg,
      ok: false,
      before,
      after,
      source: resolved?.source ?? null,
      detail: `${pkg}: npm install failed — ${tail(r.output)}`,
    };
  }
  const moved = before !== after;
  return {
    package: pkg,
    ok: true,
    before,
    after,
    source: resolved?.source ?? null,
    detail: moved
      ? `${pkg} ${before ?? '?'} → ${after ?? '?'} (${resolved?.source ?? '?'}) — new sessions use it; restart open sessions to pick it up`
      : `${pkg} ${after ?? '?'} is already the newest available (${resolved?.source ?? '?'})`,
  };
}

function tail(output: string, max = 400): string {
  const t = output.trim();
  return t.length <= max ? t : `…${t.slice(-max)}`;
}

function defaultRun(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    // cross-spawn: Windows 의 `npm` 은 `npm.cmd` shim 이라 node spawn 으로 직접 실행되지 않는다.
    const child = crossSpawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: process.env });
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
    child.stdout?.on('data', (b) => { output += String(b); });
    child.stderr?.on('data', (b) => { output += String(b); });
    child.on('error', (err: any) => finish(false, `\n[spawn error: ${err?.message ?? err}]`));
    child.on('close', (code) => finish(code === 0, code === 0 ? '' : `\n[exit ${code}]`));
  });
}
