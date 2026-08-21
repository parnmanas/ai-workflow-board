// Explicit provisioned-boundary index for `.awb/act` / `.awb/chat` run
// workspaces (ticket 9fd27487, review round 3).
//
// worktree-manager's `#listRunWorkspaceLeaves` decides a directory is a leaf by
// LOOKING AT ITS CONTENTS (a marker file, a `.git`, or plain files) and never
// descends past a `.git` — anything under a checked-out repo is that repo's own
// content, not a separate workspace boundary. That holds for the common case,
// but nothing rejects a `workspace_folder` that is a PREFIX of another: Action A
// (`workspace_folder='deploy'`, `repo_ref` set) provisions `.awb/act/deploy`
// with its own `.git`; Action B (`workspace_folder='deploy/scripts'`)
// independently provisions `.awb/act/deploy/scripts` INSIDE it. Both are real,
// independently-provisioned boundaries with their own `.awb-last-used` marker —
// but the content heuristic can never see the second one, because `deploy`'s
// `.git` unconditionally stops descent. A stale `deploy` then recursively
// deletes a fresh `deploy/scripts`; a stale `deploy/scripts` never gets swept
// independently while `deploy` stays fresh.
//
// `provisionRunWorkspace` is the SOLE writer of every leaf under `.awb/act` /
// `.awb/chat` (run-provisioner.ts), so instead of asking worktree-manager to
// reverse-engineer boundaries from directory contents, it just records the
// exact boundary it created. worktree-manager unions this with the existing
// content-heuristic scan (kept for folders provisioned before this manifest
// existed, and as defense-in-depth) rather than replacing it outright.
//
// Stored as a sibling of the kind root (`.awb/.act.manifest.json`, next to
// `.awb/act`), NOT inside it — a stray file directly under `.awb/act` would
// itself trip the "has a file → leaf, stop descending" heuristic and break
// scanning of every real leaf under the root.

import { promises as fsp } from 'node:fs';
import { join, dirname, basename } from 'node:path';

function manifestPath(kindRoot: string): string {
  return join(dirname(kindRoot), `.${basename(kindRoot)}.manifest.json`);
}

async function readManifestRaw(kindRoot: string): Promise<string[]> {
  try {
    const raw = await fsp.readFile(manifestPath(kindRoot), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string' && isValidLeaf(x)) : [];
  } catch {
    return []; // absent / corrupt / unreadable — never blocks the caller
  }
}

// A manifest entry must have the exact shape `provisionRunWorkspace`'s
// `relative(kindRoot, resolve(dir)).split(sep).join('/')` can ever produce: a
// kind-root-relative, forward-slash-joined path with no `.`/`..` segment, no
// leading slash, and no backslash. Every value feeds straight into
// `join(kindRoot, leaf)` for stat/snapshot/sweep, so a corrupt or hand-edited
// manifest file must never smuggle a traversal or absolute path past this
// read boundary — GC's `isUnder` guard already stops an escape from becoming a
// destructive delete, but closing it here too keeps the read side honest
// (review round 4, ticket 9fd27487).
function isValidLeaf(candidate: string): boolean {
  if (!candidate || candidate.includes('\\') || /^[a-zA-Z]:/.test(candidate)) return false;
  if (candidate.startsWith('/')) return false;
  return candidate.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

async function writeManifestRaw(kindRoot: string, leaves: string[]): Promise<void> {
  await fsp.mkdir(dirname(kindRoot), { recursive: true });
  await fsp.writeFile(manifestPath(kindRoot), JSON.stringify(leaves));
}

// Serialize read-modify-write per manifest file so two concurrent
// provisionRunWorkspace calls for DIFFERENT leaves under the same kind root
// (`.awb/act`) never race each other and silently drop one entry. Mirrors the
// chained-promise mutex run-provisioner.ts already uses for per-folder git
// serialization (`withFolderLock`).
const manifestLocks = new Map<string, Promise<void>>();

async function withManifestLock<T>(kindRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = manifestPath(kindRoot);
  const prev = manifestLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  manifestLocks.set(key, prev.then(() => mine));
  const composed = manifestLocks.get(key)!;
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (manifestLocks.get(key) === composed) manifestLocks.delete(key);
  }
}

/**
 * Record `leaf` (kind-root-relative, forward-slash-joined — e.g.
 * `deploy/scripts`, matching the `relDir` strings worktree-manager's
 * `#listRunWorkspaceLeaves` produces) as a provisioned boundary under
 * `kindRoot` (an absolute `.awb/act` or `.awb/chat` path). Idempotent —
 * re-provisioning an existing leaf is a no-op. Best-effort: a write failure
 * must never fail the provisioning it is recording.
 */
export async function recordRunWorkspaceLeaf(kindRoot: string, leaf: string): Promise<void> {
  if (!kindRoot || !leaf) return;
  await withManifestLock(kindRoot, async () => {
    const leaves = await readManifestRaw(kindRoot);
    if (leaves.includes(leaf)) return;
    leaves.push(leaf);
    await writeManifestRaw(kindRoot, leaves).catch(() => {});
  }).catch(() => {});
}

/**
 * Drop `leaf` and any leaf nested under it (`leaf/...`) from the manifest —
 * called once a sweep has recursively removed `leaf`'s directory, so a stale
 * entry never outlives the folder it pointed at. Best-effort.
 */
export async function forgetRunWorkspaceLeaf(kindRoot: string, leaf: string): Promise<void> {
  if (!kindRoot || !leaf) return;
  await withManifestLock(kindRoot, async () => {
    const leaves = await readManifestRaw(kindRoot);
    const next = leaves.filter((l) => l !== leaf && !l.startsWith(`${leaf}/`));
    if (next.length === leaves.length) return;
    await writeManifestRaw(kindRoot, next).catch(() => {});
  }).catch(() => {});
}

/**
 * Read the manifest's leaves under `kindRoot`, self-healing by dropping any
 * entry whose directory no longer exists on disk (e.g. removed by something
 * other than `forgetRunWorkspaceLeaf` — a manual rm, or a folder that predates
 * this manifest and was later cleaned up by the old heuristic-only sweep).
 * Never throws; an absent/corrupt manifest yields `[]`.
 *
 * The whole read→stat→write self-heal sequence runs inside ONE
 * `withManifestLock` acquisition (review round 4, ticket 9fd27487) — an
 * earlier version read+stat'd outside the lock and only took it for the final
 * write, so a `recordRunWorkspaceLeaf` landing in that gap got silently
 * overwritten by this function's stale (pre-record) snapshot the moment it
 * self-healed. Holding the lock across the stat calls too makes this
 * function and every writer (`recordRunWorkspaceLeaf`/`forgetRunWorkspaceLeaf`)
 * strictly serialize, so no interleaving can drop a concurrently-recorded leaf.
 */
export async function readRunWorkspaceLeaves(kindRoot: string): Promise<string[]> {
  return withManifestLock(kindRoot, async () => {
    const leaves = await readManifestRaw(kindRoot);
    if (leaves.length === 0) return [];
    const alive: string[] = [];
    for (const leaf of leaves) {
      const st = await fsp.stat(join(kindRoot, leaf)).catch(() => null);
      if (st?.isDirectory()) alive.push(leaf);
    }
    if (alive.length !== leaves.length) {
      await writeManifestRaw(kindRoot, alive).catch(() => {});
    }
    return alive;
  }).catch(() => []);
}
