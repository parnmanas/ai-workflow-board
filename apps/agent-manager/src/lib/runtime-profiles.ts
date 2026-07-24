import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { constants as fsConstants } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import type { RuntimeProfileSpec } from './cli-adapters/base.js';

export interface RuntimeLaunch {
  bin: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  baseUrl: string;
  healthUrl: string;
}

export interface RuntimeProvider {
  name: string;
  capabilities: readonly string[];
  validate(profile: RuntimeProfileSpec): string[];
  build(profile: RuntimeProfileSpec): RuntimeLaunch;
  claudeEnv(profile: RuntimeProfileSpec, launch: RuntimeLaunch): Record<string, string>;
}

const providers = new Map<string, RuntimeProvider>();

export function registerRuntimeProvider(provider: RuntimeProvider): void {
  const name = provider.name.trim().toLowerCase();
  if (!name) throw new Error('Runtime provider name must not be empty');
  providers.set(name, provider);
}

export function listRuntimeProviders(): Array<{ name: string; capabilities: readonly string[] }> {
  return [...providers.values()].map(({ name, capabilities }) => ({ name, capabilities }));
}

export function getRuntimeProvider(name: string): RuntimeProvider {
  const provider = providers.get(String(name).trim().toLowerCase());
  if (!provider) {
    throw new Error(
      `Unknown runtime provider "${name}". Registered providers: ${[...providers.keys()].join(', ') || '(none)'}`,
    );
  }
  return provider;
}

function platformBinDir(venv: string): string {
  return join(venv, process.platform === 'win32' ? 'Scripts' : 'bin');
}

function resolveFrom(profile: RuntimeProfileSpec, value: string): string {
  if (isAbsolute(value)) return value;
  return resolve(profile.cwd || process.cwd(), value);
}

function venvExecutable(profile: RuntimeProfileSpec, name: string): string {
  if (!profile.venv) return name;
  return join(
    platformBinDir(resolveFrom(profile, profile.venv)),
    process.platform === 'win32' ? `${name}.exe` : name,
  );
}

function resolvePython(profile: RuntimeProfileSpec): string {
  if (profile.python) return resolveFrom(profile, profile.python);
  if (profile.venv) return venvExecutable(profile, 'python');
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}

function baseUrl(profile: RuntimeProfileSpec): string {
  return (profile.base_url || `http://127.0.0.1:${profile.port || 8000}`).replace(/\/$/, '');
}

function buildGeneric(profile: RuntimeProfileSpec, credentialEnv: Record<string, string> = {}): RuntimeLaunch {
  const cwd = profile.cwd ? resolveFrom(profile, profile.cwd) : undefined;
  let bin: string;
  let args: string[];
  if (profile.module) {
    bin = resolvePython(profile);
    args = ['-m', profile.module, ...(profile.extra_args ?? [])];
  } else if (profile.executable) {
    bin = profile.venv && !isAbsolute(profile.executable)
      ? venvExecutable(profile, profile.executable)
      : resolveFrom(profile, profile.executable);
    args = [...(profile.extra_args ?? [])];
  } else if (profile.command) {
    const [head, ...tail] = profile.command.trim().split(/\s+/);
    bin = profile.venv && !isAbsolute(head) ? venvExecutable(profile, head) : head;
    args = [...tail, ...(profile.extra_args ?? [])];
  } else {
    throw new Error(
      `Runtime profile "${profile.provider}" has no command, module, or executable. ` +
      'Set one launch field, or use shutdown_policy="reuse" with an existing endpoint.',
    );
  }
  const url = baseUrl(profile);
  const binDir = profile.venv ? platformBinDir(resolveFrom(profile, profile.venv)) : null;
  return {
    bin,
    args,
    cwd,
    env: {
      ...process.env,
      ...(binDir ? { VIRTUAL_ENV: resolveFrom(profile, profile.venv!), PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` } : {}),
      ...(profile.env ?? {}),
      ...credentialEnv,
    },
    baseUrl: url,
    healthUrl: profile.health_check
      ? new URL(profile.health_check, `${url}/`).toString()
      : `${url}/health`,
  };
}

function genericValidation(profile: RuntimeProfileSpec): string[] {
  const issues: string[] = [];
  if (!profile.model?.trim()) issues.push('model is required');
  const launchCount = [profile.command, profile.module, profile.executable].filter(Boolean).length;
  if (launchCount > 1) issues.push('set only one of command, module, or executable');
  if (profile.shutdown_policy !== 'reuse' && launchCount === 0) {
    issues.push('command, module, or executable is required unless shutdown_policy is "reuse"');
  }
  if (profile.port !== undefined && (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535)) {
    issues.push('port must be an integer from 1 to 65535');
  }
  if (profile.credential_required && !profile.credential_ref) {
    issues.push('credential_ref is required when credential_required is true');
  }
  return issues;
}

const genericProvider: RuntimeProvider = {
  name: 'generic',
  capabilities: ['openai_compatible', 'managed_process'],
  validate: genericValidation,
  build: buildGeneric,
  claudeEnv: (profile, launch) => ({
    ANTHROPIC_BASE_URL: launch.baseUrl,
    ...(profile.claude?.env ?? {}),
  }),
};

registerRuntimeProvider(genericProvider);
registerRuntimeProvider({
  ...genericProvider,
  name: 'vllm',
  capabilities: ['openai_compatible', 'managed_process', 'venv'],
  validate(profile) {
    return genericValidation({
      ...profile,
      module: profile.module || (!profile.command && !profile.executable ? 'vllm.entrypoints.openai.api_server' : undefined),
    });
  },
  build(profile) {
    const normalized = profile.module || profile.command || profile.executable
      ? profile
      : { ...profile, module: 'vllm.entrypoints.openai.api_server' };
    const launch = buildGeneric(normalized);
    const hasModel = launch.args.some((arg) => arg === '--model');
    const hasPort = launch.args.some((arg) => arg === '--port');
    return {
      ...launch,
      args: [
        ...launch.args,
        ...(hasModel ? [] : ['--model', profile.model]),
        ...(hasPort || !profile.port ? [] : ['--port', String(profile.port)]),
      ],
    };
  },
});

export function validateRuntimeProfile(profile: RuntimeProfileSpec): void {
  if (!profile || typeof profile !== 'object') throw new Error('Runtime profile must be an object');
  const issues = getRuntimeProvider(profile.provider).validate(profile);
  if (profile.venv) {
    const venv = resolveFrom(profile, profile.venv);
    if (!existsSync(venv)) issues.push(`venv does not exist: ${venv}`);
    const python = resolvePython(profile);
    if (profile.module && !existsSync(python)) issues.push(`venv Python does not exist: ${python}`);
  }
  if (issues.length) throw new Error(`Invalid runtime profile (${profile.provider}): ${issues.join('; ')}`);
}

export async function assertRuntimeExecutable(launch: RuntimeLaunch): Promise<void> {
  if (!isAbsolute(launch.bin)) return;
  try {
    await access(launch.bin, fsConstants.X_OK);
  } catch {
    throw new Error(`Runtime executable is missing or not executable: ${launch.bin}`);
  }
}

export class RuntimeLease {
  constructor(
    readonly profile: RuntimeProfileSpec,
    readonly launch: RuntimeLaunch,
    readonly child: ChildProcess | null,
  ) {}

  claudeEnv(): Record<string, string> {
    return getRuntimeProvider(this.profile.provider).claudeEnv(this.profile, this.launch);
  }

  async close(): Promise<void> {
    if (!this.child || this.profile.shutdown_policy === 'reuse' || this.profile.shutdown_policy === 'manager_exit' || this.child.exitCode !== null) return;
    const exited = new Promise<void>((resolveExit) => this.child!.once('exit', () => resolveExit()));
    if (process.platform !== 'win32' && this.child.pid) {
      try { process.kill(-this.child.pid, 'SIGTERM'); } catch { this.child.kill('SIGTERM'); }
    } else {
      this.child.kill('SIGTERM');
    }
    await Promise.race([exited, new Promise<void>((resolveWait) => setTimeout(resolveWait, 5_000))]);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGKILL');
      await Promise.race([exited, new Promise<void>((resolveWait) => setTimeout(resolveWait, 1_000))]);
    }
  }
}

async function healthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function startRuntimeProfile(
  profile: RuntimeProfileSpec,
  credentialEnv: Record<string, string> = {},
): Promise<RuntimeLease> {
  validateRuntimeProfile(profile);
  const provider = getRuntimeProvider(profile.provider);
  if (profile.shutdown_policy === 'reuse') {
    const launch = profile.command || profile.module || profile.executable
      ? provider.build(profile)
      : { ...buildGeneric({ ...profile, command: process.execPath }), bin: '', args: [] };
    if (!(await healthy(launch.healthUrl))) {
      throw new Error(`Runtime endpoint is not healthy: ${launch.healthUrl}`);
    }
    return new RuntimeLease(profile, launch, null);
  }

  const launch = provider.build(profile);
  Object.assign(launch.env, credentialEnv);
  await assertRuntimeExecutable(launch);
  if (await healthy(launch.healthUrl)) {
    return new RuntimeLease({ ...profile, shutdown_policy: 'reuse' }, launch, null);
  }
  const child = crossSpawn(launch.bin, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let spawnError: Error | null = null;
  child.once('error', (error) => { spawnError = error; });
  const deadline = Date.now() + (profile.startup_timeout_ms ?? 120_000);
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new Error(`Runtime failed to start (${launch.bin}): ${(spawnError as Error).message}`);
    }
    if (child.exitCode !== null) {
      throw new Error(`Runtime exited before becoming ready (exit code ${child.exitCode})`);
    }
    if (await healthy(launch.healthUrl)) return new RuntimeLease(profile, launch, child);
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  const lease = new RuntimeLease(profile, launch, child);
  await lease.close();
  throw new Error(
    `Runtime startup timed out after ${profile.startup_timeout_ms ?? 120_000}ms; health check: ${launch.healthUrl}`,
  );
}
