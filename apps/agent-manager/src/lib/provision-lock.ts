import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

interface ProvisionLockOptions {
  timeoutMs: number;
  staleMs: number;
  heartbeatMs: number;
}

// Names are never reused, even by retries in the same process. A delayed
// unlink can only remove the owner it inspected; rmdir cannot remove owners.
async function removeOwner(lockDir: string, ownerPath: string): Promise<void> {
  await fs.unlink(ownerPath).catch(() => {});
  await fs.rmdir(lockDir).catch(() => {});
}

async function recoverStaleOwners(lockDir: string, staleMs: number): Promise<void> {
  const names = await fs.readdir(lockDir);
  if (names.length === 0) {
    if (Date.now() - (await fs.stat(lockDir)).mtimeMs > staleMs) {
      await fs.rmdir(lockDir);
    }
    return;
  }
  for (const name of names) {
    // Preserve legacy owner.json and unknown entries: their names can be
    // reused, so checking their contents cannot make a later unlink safe.
    const match = /^owner-([1-9][0-9]*)-([0-9a-f-]{36})\.json$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid)) continue;
    const ownerPath = join(lockDir, name);
    if (Date.now() - (await fs.stat(ownerPath)).mtimeMs <= staleMs) continue;
    try {
      process.kill(pid, 0);
    } catch (err: any) {
      // Only ESRCH proves death. In particular, permission errors must not
      // authorize recovery. The filename identifies even a partial write.
      if (err?.code === 'ESRCH') await removeOwner(lockDir, ownerPath);
    }
  }
}

export async function withProvisionDirectoryLock<T>(
  worktreesRoot: string,
  options: ProvisionLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const lockDir = join(worktreesRoot, '.provision.lock');
  const deadline = Date.now() + options.timeoutMs;
  await fs.mkdir(worktreesRoot, { recursive: true });
  let mkdirRetries = 0;
  for (;;) {
    const token = randomUUID();
    const name = `owner-${process.pid}-${token}.json`;
    const ownerPath = join(lockDir, name);
    let created = false;
    let acquired = false;
    try {
      await fs.mkdir(lockDir);
      mkdirRetries = 0;
      created = true;
      await fs.writeFile(ownerPath, JSON.stringify({ token, pid: process.pid }), { flag: 'wx' });
      // A stale empty directory may have been removed while this creator was
      // suspended. If it published into a successor, it must withdraw.
      const names = await fs.readdir(lockDir);
      acquired = names.length === 1 && names[0] === name;
    } catch (err: any) {
      // Windows may leave a just-removed directory delete-pending. Its mkdir
      // then reports a permission/busy error instead of EEXIST. This grants
      // no ownership or recovery rights: retry mkdir only, with a short bound,
      // and retain the original error for a real permission failure.
      if (!created && ['EPERM', 'EACCES', 'EBUSY'].includes(err?.code)) {
        if (++mkdirRetries >= 80 || Date.now() >= deadline) throw err;
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      mkdirRetries = 0;
      if (err?.code !== 'EEXIST' && err?.code !== 'ENOENT') throw err;
    } finally {
      if (created && !acquired) await removeOwner(lockDir, ownerPath);
    }
    if (acquired) {
      const heartbeat = setInterval(() => {
        void fs.utimes(ownerPath, new Date(), new Date()).catch(() => {});
      }, options.heartbeatMs);
      heartbeat.unref?.();
      try {
        return await fn();
      } finally {
        clearInterval(heartbeat);
        await removeOwner(lockDir, ownerPath);
      }
    }
    await recoverStaleOwners(lockDir, options.staleMs).catch(() => {});
    if (Date.now() >= deadline) {
      throw new Error(`provision lock timeout: ${lockDir} (legacy owner.json or unknown entries require manual cleanup while managers are stopped)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
