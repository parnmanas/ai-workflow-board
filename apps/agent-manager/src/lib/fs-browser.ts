// FS Browser handler — reverse-RPC target. The server emits fs_request over
// SSE, we perform the op against the local filesystem, and POST the result
// back to /api/fs/responses/:request_id (handled by event-dispatcher).
//
// Scope enforcement lives here: every path is resolved to an absolute
// realpath then matched against the realpath of each configured root, which
// blocks both `..` tricks and symlinks that escape scope.

import { promises as fsp, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as pathResolve, sep as PATH_SEP } from 'node:path';
import { log } from './logging.js';
import type { FsBrowser as FsBrowserContract, FsBrowserResult } from './event-dispatcher.js';
import type { AwbConfig } from './rest.js';

const DEFAULT_LIST_LIMIT = 5000;
const DEFAULT_READ_CAP = 5 * 1024 * 1024; // 5 MB
const BINARY_SNIFF_BYTES = 512;

export interface FsBrowserSection {
  enabled?: boolean;
  roots?: string[];
}

interface FsHandleArgs {
  op: string;
  path: string;
  offset?: number;
  limit?: number;
  // mkdir-only: name of the new directory to create under `path` (which must
  // be the existing parent). Validated for separators / `..` / empty before
  // being joined, so the caller cannot smuggle a traversal through the name
  // field even if the parent passes scope check.
  name?: string;
}

export class FsBrowser implements FsBrowserContract {
  /**
   * Always-on as of ST-7 follow-up. The legacy opt-in gate
   * (`fs_browser.enabled`) was removed because the only callers are
   * AWB-admin-authenticated UI surfaces — the manager's filesystem is
   * already implicitly trusted to anyone who can reach the AWB admin
   * dashboard, so requiring an explicit config section was friction
   * without a corresponding security gain.
   */
  private rawRoots: string[];
  private roots: string[] = [];
  private hasExplicitRoots: boolean;

  constructor(_config: AwbConfig, fsSection?: FsBrowserSection | null) {
    this.rawRoots = Array.isArray(fsSection?.roots)
      ? fsSection!.roots!.filter((r): r is string => typeof r === 'string' && !!r)
      : [];
    this.hasExplicitRoots = this.rawRoots.length > 0;
    this.resolveRootsSync();
  }

  private resolveRootsSync(): void {
    for (const root of this.rawRoots) {
      try {
        const abs = pathResolve(root);
        const real = realpathSync(abs);
        this.roots.push(real);
      } catch (err: any) {
        log(`[fs-browser] scope root unreachable, dropped: ${root} (${err?.code || err?.message})`);
      }
    }
    if (this.hasExplicitRoots && this.roots.length === 0) {
      log('[fs-browser] explicit roots configured but none resolved — falling back to unrestricted browsing');
    } else if (this.roots.length > 0) {
      log(`[fs-browser] enabled with ${this.roots.length} configured root(s): ${this.roots.join(', ')}`);
    } else {
      log('[fs-browser] enabled (unrestricted — no fs_browser.roots configured; UI starts at $HOME)');
    }
  }

  /**
   * Enumerate filesystem roots usable as starting points. Windows: probe
   * each letter A-Z for an accessible drive root and report the live ones
   * (`C:\`, `D:\`, …). UNIX: a single `/` since there is only one root
   * volume. Result is shaped for the picker's drive-list mode (the user
   * "goes up" from `C:\` and lands here to switch drives).
   */
  private async listDrives(): Promise<Array<{ name: string; path: string }>> {
    if (process.platform !== 'win32') {
      return [{ name: '/', path: '/' }];
    }
    const probes: Promise<{ name: string; path: string } | null>[] = [];
    for (let code = 65; code <= 90; code++) {
      const letter = String.fromCharCode(code);
      const root = `${letter}:\\`;
      probes.push(
        fsp.access(root).then(
          () => ({ name: `${letter}:`, path: root }),
          () => null,
        ),
      );
    }
    const results = await Promise.all(probes);
    return results.filter((r): r is { name: string; path: string } => r !== null);
  }

  /**
   * Suggested starting points for the picker when no explicit roots are
   * set. Order matters — picker uses the first hit that contains cwd.
   */
  private defaultStartingPoints(): string[] {
    const out = new Set<string>();
    try {
      const home = realpathSync(pathResolve(homedir()));
      if (home) out.add(home);
    } catch { /* no $HOME available */ }
    try {
      const cwd = realpathSync(process.cwd());
      if (cwd) out.add(cwd);
    } catch { /* unlikely */ }
    return Array.from(out);
  }

  async handle(req: FsHandleArgs): Promise<FsBrowserResult> {
    if (!req || typeof req !== 'object') {
      return { ok: false, error: 'Malformed request', code: 'PATH_INVALID' };
    }
    const op = req.op;

    if (op === 'roots') {
      // When the operator hasn't pinned roots, expose the default starting
      // points (home + cwd) so the picker has somewhere meaningful to land.
      // `enabled` is always true now — the field is kept on the wire for
      // back-compat with older clients that gate UI on it.
      const advertisedRoots = this.roots.length > 0 ? this.roots.slice() : this.defaultStartingPoints();
      return {
        ok: true,
        data: {
          cwd: process.cwd(),
          roots: advertisedRoots,
          enabled: true,
          platform: process.platform,
        },
      };
    }

    if (op === 'drives') {
      // Cross-drive navigation on Windows. The picker calls this when the
      // user goes "up" from a drive root (`C:\`) — UNIX-style filesystems
      // collapse to a single `/` so the call still resolves to a sensible
      // shape there. Drives outside the configured roots scope are still
      // listed (operator hasn't typically pinned C:/D:/E: explicitly); the
      // subsequent `list` call gates by the same scope check as everything
      // else, so a drive returned here may still 403 on traversal.
      return { ok: true, data: { drives: await this.listDrives() } };
    }

    const rawPath = req.path;
    if (typeof rawPath !== 'string' || !rawPath) {
      return { ok: false, error: 'path is required', code: 'PATH_INVALID' };
    }
    if (!rawPath.startsWith(PATH_SEP) && !/^[A-Za-z]:[\\/]/.test(rawPath)) {
      return { ok: false, error: 'path must be absolute', code: 'PATH_INVALID' };
    }

    let realPath: string;
    try {
      realPath = await fsp.realpath(pathResolve(rawPath));
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err), code: err?.code || 'ENOENT' };
    }

    // Scope enforcement only kicks in when roots are explicitly configured.
    // Without a roots list, the picker can browse anywhere on the manager
    // host (intentional default for ST-7 single-operator setups).
    if (this.roots.length > 0 && !this.inScope(realPath)) {
      return { ok: false, error: `Path outside configured roots: ${rawPath}`, code: 'SCOPE_DENIED' };
    }

    try {
      switch (op) {
        case 'list':
          return { ok: true, data: await this.list(realPath) };
        case 'stat':
          return { ok: true, data: await this.stat(realPath) };
        case 'read':
          return {
            ok: true,
            data: await this.read(realPath, req.offset ?? 0, req.limit ?? DEFAULT_READ_CAP),
          };
        case 'mkdir':
          return { ok: true, data: await this.mkdir(realPath, req.name) };
        default:
          return { ok: false, error: `Unknown op: ${op}`, code: 'PATH_INVALID' };
      }
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err), code: err?.code || 'FS_ERROR' };
    }
  }

  private inScope(realPath: string): boolean {
    for (const root of this.roots) {
      if (realPath === root) return true;
      if (realPath.startsWith(root + PATH_SEP)) return true;
    }
    return false;
  }

  private async list(realPath: string): Promise<any> {
    const stat = await fsp.stat(realPath);
    if (!stat.isDirectory()) {
      const err: any = new Error(`Not a directory: ${realPath}`);
      err.code = 'ENOTDIR';
      throw err;
    }
    const entries = await fsp.readdir(realPath, { withFileTypes: true });
    const limit = DEFAULT_LIST_LIMIT;
    const truncated = entries.length > limit;
    const slice = truncated ? entries.slice(0, limit) : entries;

    const out = await Promise.all(
      slice.map(async (dirent) => {
        const full = `${realPath}${PATH_SEP}${dirent.name}`;
        let type: 'directory' | 'symlink' | 'file' | 'other' = 'other';
        let size = 0;
        let mtime = '';
        let mode = 0;
        let isSymlink = false;
        try {
          const lst = await fsp.lstat(full);
          mode = lst.mode;
          size = Number(lst.size) || 0;
          mtime = lst.mtime.toISOString();
          if (lst.isSymbolicLink()) {
            isSymlink = true;
            // Follow the link so the picker sees the *effective* kind —
            // a link to a directory should be navigable as a directory,
            // not filtered out as `type: 'symlink'`. Broken links fall
            // back to `type: 'symlink'` so the entry still surfaces.
            try {
              const tgt = await fsp.stat(full);
              if (tgt.isDirectory()) type = 'directory';
              else if (tgt.isFile()) type = 'file';
              else type = 'symlink';
            } catch {
              type = 'symlink';
            }
          } else if (lst.isDirectory()) type = 'directory';
          else if (lst.isFile()) type = 'file';
        } catch {
          /* permission etc. — keep name, leave type='other' */
        }
        return { name: dirent.name, type, size, mtime, mode, is_symlink: isSymlink };
      }),
    );

    return { path: realPath, entries: out, truncated };
  }

  private async mkdir(parentRealPath: string, name: string | undefined): Promise<any> {
    // Validate the name in isolation — scope check on the parent doesn't help
    // if the name itself escapes (e.g., `../foo`). Reject anything containing
    // a path separator, traversal token, or that resolves to empty.
    if (typeof name !== 'string') {
      const err: any = new Error('name is required');
      err.code = 'PATH_INVALID';
      throw err;
    }
    const trimmed = name.trim();
    if (!trimmed || trimmed === '.' || trimmed === '..') {
      const err: any = new Error('name must be a non-empty single path segment');
      err.code = 'PATH_INVALID';
      throw err;
    }
    if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
      const err: any = new Error('name must not contain path separators');
      err.code = 'PATH_INVALID';
      throw err;
    }

    const parentStat = await fsp.stat(parentRealPath);
    if (!parentStat.isDirectory()) {
      const err: any = new Error(`Parent is not a directory: ${parentRealPath}`);
      err.code = 'ENOTDIR';
      throw err;
    }

    const target = `${parentRealPath}${PATH_SEP}${trimmed}`;
    // Non-recursive: surface EEXIST when the folder already exists so the UI
    // can show a useful error. The picker only ever creates a single level.
    await fsp.mkdir(target);

    const st = await fsp.stat(target);
    return {
      path: target,
      type: 'directory' as const,
      size: Number(st.size) || 0,
      mtime: st.mtime.toISOString(),
      mode: st.mode,
    };
  }

  private async stat(realPath: string): Promise<any> {
    const st = await fsp.lstat(realPath);
    let type: 'directory' | 'symlink' | 'file' | 'other' = 'other';
    let realTarget: string | undefined;
    if (st.isSymbolicLink()) {
      type = 'symlink';
      try {
        realTarget = await fsp.realpath(realPath);
      } catch {
        /* broken link */
      }
    } else if (st.isDirectory()) type = 'directory';
    else if (st.isFile()) type = 'file';
    return {
      path: realPath,
      real_path: realTarget,
      type,
      size: Number(st.size) || 0,
      mtime: st.mtime.toISOString(),
      mode: st.mode,
    };
  }

  private async read(realPath: string, offset: number, limit: number): Promise<any> {
    const st = await fsp.stat(realPath);
    if (!st.isFile()) {
      const err: any = new Error(`Not a file: ${realPath}`);
      err.code = 'EISDIR';
      throw err;
    }
    const off = Math.max(0, Math.floor(Number(offset) || 0));
    const cap = Math.min(Math.max(1, Math.floor(Number(limit) || DEFAULT_READ_CAP)), DEFAULT_READ_CAP);
    const remaining = Math.max(0, Number(st.size) - off);
    const readBytes = Math.min(remaining, cap);
    const truncated = readBytes < remaining;

    const fh = await fsp.open(realPath, 'r');
    try {
      const buf = Buffer.alloc(readBytes);
      if (readBytes > 0) {
        await fh.read(buf, 0, readBytes, off);
      }
      const binary = this.looksBinary(buf);
      return {
        path: realPath,
        content: binary ? buf.toString('base64') : buf.toString('utf8'),
        encoding: binary ? 'base64' : 'utf8',
        size: Number(st.size) || 0,
        read_bytes: readBytes,
        offset: off,
        truncated,
        mtime: st.mtime.toISOString(),
      };
    } finally {
      await fh.close();
    }
  }

  private looksBinary(buf: Buffer): boolean {
    const scan = Math.min(buf.length, BINARY_SNIFF_BYTES);
    for (let i = 0; i < scan; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  }
}
