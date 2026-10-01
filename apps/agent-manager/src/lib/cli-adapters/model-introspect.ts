// Best-effort model enumeration helpers shared by CLI adapters' listModels().
//
// Key finding (ticket 999f47bf research): the Claude CLI embeds its `/model`
// picker list directly in the installed binary — it is NOT a live API fetch.
// Grepping the executable for `claude-<family>-<ver>` strings therefore yields
// the exact model set THIS install accepts, and auto-updates when the operator
// upgrades the CLI. That is genuinely per-install "dynamic", more accurate than
// anything we could hardcode in the adapter. Everything here is best-effort:
// every path collapses to [] / a curated fallback rather than throwing, because
// the heartbeat that consumes it must never wedge on model inspection.

import { execFileSync } from 'node:child_process';
import { promises as fsp, readFileSync, statSync } from 'node:fs';

import { parseWindowsShimTargets } from '../cli-resolver.js';

/**
 * Scan an installed CLI binary for embedded strings matching `pattern`.
 * Prefers the `strings(1)` utility (streams, never loads the whole binary
 * into a JS string); falls back to reading the file ourselves on platforms
 * where `strings` is absent (Windows). Returns [] on any failure.
 */
export async function scanBinaryStrings(binPath: string, pattern: RegExp): Promise<string[]> {
  const out = new Set<string>();
  const target = resolveShimTarget(binPath, REAL_SHIM_IO);
  try {
    const raw = execFileSync('strings', ['-n', '6', target], {
      encoding: 'latin1',
      timeout: 4000,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    collectMatches(raw, pattern, out);
    if (out.size) return [...out];
  } catch {
    /* `strings` missing (Windows) or failed — fall through to a direct read */
  }
  try {
    const stat = await fsp.stat(target);
    // Skip non-files (literal-name fallback when bin resolution failed) and
    // pathologically large files so a bad path can't blow up memory.
    if (!stat.isFile() || stat.size > 400 * 1024 * 1024) return [...out];
    const buf = await fsp.readFile(target);
    collectMatches(buf.toString('latin1'), pattern, out);
  } catch {
    /* unreadable — give up, return whatever we already collected (likely []) */
  }
  return [...out];
}

/** `resolveShimTarget` 의 IO 시임. `windowsShimIsUsable` 과 같은 모양으로 주입하는
 *  이유도 같다 — win32 경로 의미론은 Linux 에서 stat 되지 않으므로, 실제 파일 없이
 *  POSIX CI 에서 이 판단을 테스트할 수 있어야 한다. */
export interface ShimResolveIO {
  read: (path: string) => string | null;
  isFile: (path: string) => boolean;
}

export const REAL_SHIM_IO: ShimResolveIO = {
  read: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
};

/**
 * Windows 배치 shim 을 건네받았으면 그 shim 이 실행하는 실제 바이너리로 바꿔 준다.
 *
 * npm 은 Windows 에서 symlink 대신 `claude.cmd` 같은 160바이트 배치 shim 을 떨어뜨리고,
 * cli-resolver 는 `.exe` 를 못 찾으면 그 shim 을 정상 후보로 채택한다(`resolved via shim`).
 * 그 경로를 그대로 스캔하면 배치 스크립트 160바이트를 읽는 셈이라 **매치가 0개**가 되고,
 * 호출자는 그것을 "이 설치는 모델을 안 싣는다" 로 오해해 하드코딩 폴백으로 내려간다 —
 * 그래서 Linux 호스트는 새 모델을 바로 보는데 Windows 호스트만 영구히 옛 폴백 목록에
 * 묶여 있었다(실측 2026-10-01: ralf 의 claude 는 rolf 와 같은 2.1.286 인데도 Opus 5.5 가
 * 영영 안 보였다 — resolveBin 이 160바이트 `claude.cmd` 를 돌려줬기 때문이다).
 * 폴백은 조용해서 staleness 처럼 보이지만 재열거로 절대 낫지 않는다.
 *
 * shim 이 아니거나 대상을 못 찾으면 받은 경로를 그대로 돌려준다 — 판단은 항상 best-effort 다.
 */
export function resolveShimTarget(binPath: string, io: ShimResolveIO): string {
  if (!/\.(cmd|bat)$/i.test(binPath)) return binPath;
  const contents = io.read(binPath);
  if (contents === null) return binPath;
  for (const candidate of parseWindowsShimTargets(contents, binPath)) {
    if (io.isFile(candidate)) return candidate;
  }
  return binPath;
}

function collectMatches(text: string, pattern: RegExp, out: Set<string>): void {
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
  const re = new RegExp(pattern.source, flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.add(m[0]);
    if (out.size > 500) break; // safety valve against unbounded noise
  }
}

/**
 * Reduce a set of `claude-<family>-<ver>` ids to the single newest per family,
 * dropping dated / -v1 / -fast variants (the pattern that feeds this only
 * matches clean `family-major` or `family-major-minor` forms). Major-only ids
 * are required for Claude Code 2.1.220's Opus 5 and Sonnet 5. Returns at most
 * one id per family in a stable opus→sonnet→haiku→fable order for a tidy
 * dropdown.
 */
export function latestPerFamily(ids: string[]): string[] {
  const best = new Map<string, { id: string; key: number[] }>();
  for (const id of ids) {
    const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?$/.exec(id);
    if (!m) continue;
    const fam = m[1];
    const key = [Number(m[2]), Number(m[3] ?? 0)];
    const cur = best.get(fam);
    if (!cur || cmpKey(key, cur.key) > 0) best.set(fam, { id, key });
  }
  const order = ['opus', 'sonnet', 'haiku', 'fable'];
  return order.filter((f) => best.has(f)).map((f) => best.get(f)!.id);
}

function cmpKey(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Order-preserving de-dupe. */
export function dedupe(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}
