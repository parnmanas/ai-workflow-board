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
import { promises as fsp } from 'node:fs';

/**
 * Scan an installed CLI binary for embedded strings matching `pattern`.
 * Prefers the `strings(1)` utility (streams, never loads the whole binary
 * into a JS string); falls back to reading the file ourselves on platforms
 * where `strings` is absent (Windows). Returns [] on any failure.
 */
export async function scanBinaryStrings(binPath: string, pattern: RegExp): Promise<string[]> {
  const out = new Set<string>();
  try {
    const raw = execFileSync('strings', ['-n', '6', binPath], {
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
    const stat = await fsp.stat(binPath);
    // Skip non-files (literal-name fallback when bin resolution failed) and
    // pathologically large files so a bad path can't blow up memory.
    if (!stat.isFile() || stat.size > 400 * 1024 * 1024) return [...out];
    const buf = await fsp.readFile(binPath);
    collectMatches(buf.toString('latin1'), pattern, out);
  } catch {
    /* unreadable — give up, return whatever we already collected (likely []) */
  }
  return [...out];
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
 * matches clean `family-major-minor` / `fable-major` forms). Returns at most
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
