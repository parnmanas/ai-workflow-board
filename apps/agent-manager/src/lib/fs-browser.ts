// FS Browser handler — reverse-RPC target. The server emits fs_request over
// SSE, we perform the op against the local filesystem, and POST the result
// back to /api/fs/responses/:request_id (handled by event-dispatcher).
//
// Scope enforcement lives here: every path is resolved to an absolute
// realpath then matched against the realpath of each configured root, which
// blocks both `..` tricks and symlinks that escape scope.

import { promises as fsp, realpathSync } from 'node:fs';
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
}

export class FsBrowser implements FsBrowserContract {
  private enabled: boolean;
  private rawRoots: string[];
  private roots: string[] = [];

  constructor(_config: AwbConfig, fsSection?: FsBrowserSection | null) {
    this.enabled = !!fsSection && fsSection.enabled !== false;
    this.rawRoots = Array.isArray(fsSection?.roots)
      ? fsSection!.roots!.filter((r): r is string => typeof r === 'string' && !!r)
      : [];
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
    if (this.enabled && this.roots.length === 0) {
      log('[fs-browser] fs_browser section present but no valid roots — requests will be denied');
    } else if (this.enabled) {
      log(`[fs-browser] enabled with ${this.roots.length} root(s): ${this.roots.join(', ')}`);
    }
  }

  async handle(req: FsHandleArgs): Promise<FsBrowserResult> {
    if (!req || typeof req !== 'object') {
      return { ok: false, error: 'Malformed request', code: 'PATH_INVALID' };
    }
    const op = req.op;

    if (op === 'roots') {
      return {
        ok: true,
        data: {
          cwd: process.cwd(),
          roots: this.roots.slice(),
          enabled: this.enabled && this.roots.length > 0,
        },
      };
    }

    if (!this.enabled || this.roots.length === 0) {
      return { ok: false, error: 'File browsing is disabled on this agent', code: 'FS_BROWSER_DISABLED' };
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

    if (!this.inScope(realPath)) {
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
        try {
          const st = await fsp.lstat(full);
          mode = st.mode;
          size = Number(st.size) || 0;
          mtime = st.mtime.toISOString();
          if (st.isDirectory()) type = 'directory';
          else if (st.isSymbolicLink()) type = 'symlink';
          else if (st.isFile()) type = 'file';
        } catch {
          /* permission etc. — keep name, leave type='other' */
        }
        return { name: dirent.name, type, size, mtime, mode };
      }),
    );

    return { path: realPath, entries: out, truncated };
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
