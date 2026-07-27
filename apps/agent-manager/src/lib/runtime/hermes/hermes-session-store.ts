import { promises as fsp } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type HermesSessionOwnershipErrorCode =
  | 'hermes_session_not_found'
  | 'hermes_session_owner_mismatch'
  | 'hermes_session_lease_mismatch'
  | 'hermes_session_cwd_mismatch';

export class HermesSessionOwnershipError extends Error {
  readonly code: HermesSessionOwnershipErrorCode;

  constructor(code: HermesSessionOwnershipErrorCode, message: string) {
    super(message);
    this.name = 'HermesSessionOwnershipError';
    this.code = code;
  }
}

export interface HermesSessionRecord {
  runId: string;
  agentId: string;
  sessionId: string;
  leaseId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
}

export interface HermesSessionIdentity {
  runId: string;
  agentId: string;
  leaseId: string;
  cwd: string;
}

export class HermesSessionStore {
  readonly #path: string;
  readonly #records = new Map<string, HermesSessionRecord>();
  #loaded = false;
  #writeQueue = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(this.#path, 'utf8'));
      if (!Array.isArray(parsed)) return;
      for (const value of parsed) {
        if (
          value
          && typeof value === 'object'
          && typeof value.runId === 'string'
          && typeof value.agentId === 'string'
          && typeof value.sessionId === 'string'
          && typeof value.leaseId === 'string'
          && typeof value.cwd === 'string'
        ) {
          this.#records.set(value.runId, {
            ...value,
            cwd: resolve(value.cwd),
          });
        }
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  get(runId: string): HermesSessionRecord | null {
    return this.#records.get(runId) ?? null;
  }

  require(identity: HermesSessionIdentity): HermesSessionRecord {
    const record = this.#records.get(identity.runId);
    if (!record) {
      throw new HermesSessionOwnershipError(
        'hermes_session_not_found',
        `No Hermes session is recorded for run ${identity.runId}`,
      );
    }
    if (record.agentId !== identity.agentId) {
      throw new HermesSessionOwnershipError(
        'hermes_session_owner_mismatch',
        `Hermes session for run ${identity.runId} belongs to another Agent`,
      );
    }
    if (record.leaseId !== identity.leaseId) {
      throw new HermesSessionOwnershipError(
        'hermes_session_lease_mismatch',
        `Hermes session for run ${identity.runId} belongs to another worktree lease`,
      );
    }
    if (resolve(record.cwd) !== resolve(identity.cwd)) {
      throw new HermesSessionOwnershipError(
        'hermes_session_cwd_mismatch',
        `Hermes session for run ${identity.runId} belongs to another working directory`,
      );
    }
    return record;
  }

  async set(
    identity: HermesSessionIdentity,
    sessionId: string,
  ): Promise<HermesSessionRecord> {
    const now = new Date().toISOString();
    const existing = this.#records.get(identity.runId);
    const record: HermesSessionRecord = {
      ...identity,
      cwd: resolve(identity.cwd),
      sessionId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.#records.set(identity.runId, record);
    await this.#persist();
    return record;
  }

  async delete(runId: string): Promise<boolean> {
    const deleted = this.#records.delete(runId);
    if (deleted) await this.#persist();
    return deleted;
  }

  #persist(): Promise<void> {
    this.#writeQueue = this.#writeQueue.then(async () => {
      await fsp.mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temp = `${this.#path}.${process.pid}.tmp`;
      await fsp.writeFile(
        temp,
        JSON.stringify(Array.from(this.#records.values()), null, 2),
        { mode: 0o600 },
      );
      await fsp.rename(temp, this.#path);
    });
    return this.#writeQueue;
  }
}

