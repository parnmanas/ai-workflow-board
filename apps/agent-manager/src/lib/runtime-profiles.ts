import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import type { RuntimeProfileSpec } from './cli-adapters/base.js';
import { terminateDetachedProcessTree } from './process-tree.js';

interface AdapterLaunch {
  bin: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  baseUrl: string;
  healthUrl: string;
}

function resolveFrom(cwd: string | undefined, value: string): string {
  if (isAbsolute(value)) return value;
  return resolve(cwd || process.cwd(), value);
}

function venvBin(venv: string, name: string): string {
  return join(
    venv,
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? `${name}.exe` : name,
  );
}

function expand(value: string, profile: RuntimeProfileSpec): string {
  return value
    .replaceAll('{backend_base_url}', profile.base_url)
    .replaceAll('{model}', profile.model)
    .replaceAll('{adapter_base_url}', profile.adapter?.base_url ?? '');
}

function buildAdapter(profile: RuntimeProfileSpec, credentialEnv: Record<string, string>): AdapterLaunch {
  const adapter = profile.adapter!;
  const cwd = adapter.cwd ? resolveFrom(profile.cwd, adapter.cwd) : profile.cwd;
  const venv = adapter.venv ? resolveFrom(cwd, adapter.venv) : undefined;
  let bin: string;
  let args: string[];
  if (adapter.module) {
    bin = adapter.python
      ? resolveFrom(cwd, adapter.python)
      : venv
        ? venvBin(venv, 'python')
        : process.platform === 'win32' ? 'python.exe' : 'python3';
    args = ['-m', adapter.module, ...(adapter.args ?? []).map(value => expand(value, profile))];
  } else if (adapter.executable) {
    bin = venv && !isAbsolute(adapter.executable)
      ? venvBin(venv, adapter.executable)
      : resolveFrom(cwd, adapter.executable);
    args = (adapter.args ?? []).map(value => expand(value, profile));
  } else if (adapter.command) {
    const [head, ...tail] = adapter.command.trim().split(/\s+/);
    bin = venv && !isAbsolute(head) ? venvBin(venv, head) : head;
    args = [...tail, ...(adapter.args ?? [])].map(value => expand(value, profile));
  } else {
    bin = '';
    args = [];
  }
  const baseUrl = adapter.base_url.replace(/\/$/, '');
  const authEnv = profile.auth_env || 'ANTHROPIC_AUTH_TOKEN';
  const secret = credentialEnv[authEnv] || credentialEnv.ANTHROPIC_API_KEY || '';
  const binDir = venv ? join(venv, process.platform === 'win32' ? 'Scripts' : 'bin') : '';
  return {
    bin,
    args,
    cwd,
    env: {
      ...process.env,
      ...(binDir ? { VIRTUAL_ENV: venv, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` } : {}),
      AWB_BACKEND_BASE_URL: profile.base_url,
      AWB_BACKEND_MODEL: profile.model,
      ...(adapter.env
        ? Object.fromEntries(Object.entries(adapter.env).map(([key, value]) => [key, expand(value, profile)]))
        : {}),
      ...(secret ? { [authEnv]: secret } : {}),
    },
    baseUrl,
    healthUrl: new URL(adapter.health_check || '/health', `${baseUrl}/`).toString(),
  };
}

export function validateRuntimeProfile(profile: RuntimeProfileSpec): void {
  const issues: string[] = [];
  if (profile.kind && profile.kind !== 'claude-backend') issues.push('kind must be "claude-backend"');
  if (!['anthropic-compatible', 'openai-compatible'].includes(profile.protocol)) {
    issues.push('protocol must be anthropic-compatible or openai-compatible');
  }
  if (!profile.base_url) issues.push('base_url is required');
  if (!profile.model) issues.push('model is required');
  if (profile.protocol === 'openai-compatible' && !profile.adapter) issues.push('adapter is required');
  if (profile.protocol === 'anthropic-compatible' && profile.adapter) issues.push('adapter must be omitted');
  if (profile.credential_required && !profile.credential_ref) issues.push('credential_ref is required');
  if (profile.adapter) {
    const count = [profile.adapter.command, profile.adapter.module, profile.adapter.executable].filter(Boolean).length;
    if (count > 1) issues.push('adapter must set only one of command, module, or executable');
    if (profile.adapter.lifecycle !== 'reuse' && count === 0) issues.push('adapter launch command is required unless lifecycle is reuse');
  }
  if (issues.length) throw new Error(`Invalid Claude backend profile (${profile.id}): ${issues.join('; ')}`);
}

async function healthy(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

export class RuntimeLease {
  #release: (() => Promise<void>) | null;
  #closed = false;

  constructor(
    readonly profile: RuntimeProfileSpec,
    readonly launch: AdapterLaunch | null,
    readonly child: ChildProcess | null,
    readonly credentialEnv: Record<string, string>,
    release: (() => Promise<void>) | null = null,
  ) {
    this.#release = release;
  }

  claudeEnv(): Record<string, string> {
    const secret = this.credentialEnv[this.profile.auth_env || 'ANTHROPIC_AUTH_TOKEN']
      || this.credentialEnv.ANTHROPIC_API_KEY;
    return {
      ...(this.profile.env ?? {}),
      ANTHROPIC_BASE_URL: this.launch?.baseUrl ?? this.profile.base_url.replace(/\/$/, ''),
      ...(secret ? { ANTHROPIC_AUTH_TOKEN: secret } : {}),
      ...(this.profile.protocol === 'openai-compatible' && !secret
        ? { ANTHROPIC_AUTH_TOKEN: 'awb-local-adapter' }
        : {}),
    };
  }

  claudeExecutable(): string | null {
    return this.profile.claude_executable ?? null;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#release) return this.#release();
    await this.terminate(false);
  }

  async terminate(managerDrain = false): Promise<void> {
    if (!this.child || this.profile.adapter?.lifecycle === 'reuse') return;
    if (!managerDrain && this.profile.adapter?.lifecycle === 'manager_exit') return;
    const exited = this.child.exitCode !== null || this.child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>(resolveExit => this.child!.once('exit', () => resolveExit()));
    if (this.child.pid) await terminateDetachedProcessTree(this.child.pid);
    await Promise.race([exited, new Promise<void>(resolveWait => setTimeout(resolveWait, 1_000))]);
  }
}

interface SharedRuntime {
  refs: number;
  lease: Promise<RuntimeLease>;
}
const sharedRuntimes = new Map<string, SharedRuntime>();

async function startUnshared(
  profile: RuntimeProfileSpec,
  credentialEnv: Record<string, string>,
): Promise<RuntimeLease> {
  validateRuntimeProfile(profile);
  if (!profile.adapter) return new RuntimeLease(profile, null, null, credentialEnv);
  const launch = buildAdapter(profile, credentialEnv);
  if (profile.adapter.lifecycle === 'reuse') {
    if (!(await healthy(launch.healthUrl))) throw new Error(`Adapter endpoint is not healthy: ${launch.healthUrl}`);
    return new RuntimeLease(profile, launch, null, credentialEnv);
  }
  if (isAbsolute(launch.bin)) {
    try {
      await access(launch.bin, fsConstants.X_OK);
    } catch {
      throw new Error(`Adapter executable is missing or not executable: ${launch.bin}`);
    }
  }
  if (await healthy(launch.healthUrl)) return new RuntimeLease(profile, launch, null, credentialEnv);
  const child = crossSpawn(launch.bin, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let spawnError: Error | null = null;
  child.once('error', error => { spawnError = error; });
  const timeout = profile.adapter.startup_timeout_ms ?? 120_000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`Adapter failed to start (${launch.bin}): ${(spawnError as Error).message}`);
    if (child.exitCode !== null) throw new Error(`Adapter exited before becoming ready (exit code ${child.exitCode})`);
    if (await healthy(launch.healthUrl)) return new RuntimeLease(profile, launch, child, credentialEnv);
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  const lease = new RuntimeLease(profile, launch, child, credentialEnv);
  await lease.terminate(true);
  throw new Error(`Adapter startup timed out after ${timeout}ms; health check: ${launch.healthUrl}`);
}

export async function startRuntimeProfile(
  profile: RuntimeProfileSpec,
  credentialEnv: Record<string, string> = {},
): Promise<RuntimeLease> {
  if (!profile.adapter) return startUnshared(profile, credentialEnv);
  const key = JSON.stringify(profile);
  let shared = sharedRuntimes.get(key);
  if (!shared) {
    shared = { refs: 0, lease: startUnshared(profile, credentialEnv) };
    sharedRuntimes.set(key, shared);
    shared.lease.catch(() => sharedRuntimes.delete(key));
  }
  shared.refs += 1;
  const owned = await shared.lease;
  return new RuntimeLease(profile, owned.launch, owned.child, credentialEnv, async () => {
    const current = sharedRuntimes.get(key);
    if (!current) return;
    current.refs = Math.max(0, current.refs - 1);
    if (current.refs > 0 || profile.adapter?.lifecycle === 'manager_exit') return;
    sharedRuntimes.delete(key);
    await owned.terminate();
  });
}

export function runtimeCredentialEnv(
  profile: RuntimeProfileSpec,
  credentialId: string | null | undefined,
  agentCredentialEnv: Record<string, string> | undefined,
): Record<string, string> {
  if (!profile.credential_ref) return {};
  if (!credentialId || credentialId !== profile.credential_ref) {
    throw new Error(
      `Claude backend profile "${profile.id}" references credential ${profile.credential_ref}, ` +
      'but the selected agent credential does not match',
    );
  }
  const secret = agentCredentialEnv?.ANTHROPIC_API_KEY;
  if (!secret) {
    if (profile.credential_required) throw new Error(`Claude backend profile "${profile.id}" requires an API-key credential`);
    return {};
  }
  return { [profile.auth_env || 'ANTHROPIC_AUTH_TOKEN']: secret };
}

export async function shutdownRuntimeProfiles(): Promise<void> {
  const entries = [...sharedRuntimes.values()];
  sharedRuntimes.clear();
  await Promise.allSettled(entries.map(async entry => (await entry.lease).terminate(true)));
}
