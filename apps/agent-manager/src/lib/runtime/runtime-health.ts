import crossSpawn from 'cross-spawn';
import { createAdapter } from '../cli-adapters/index.js';
import {
  getRuntimeDescriptor,
  KNOWN_RUNTIME_IDS,
} from './runtime-registry.js';
import type { RuntimeCapabilities } from './runtime-types.js';

export interface RuntimeProbeResult {
  installed: boolean;
  healthy: boolean;
  version: string | null;
  reason: string | null;
}

export interface RuntimeHealth extends RuntimeProbeResult {
  capabilities: RuntimeCapabilities;
}

export type RuntimeCapabilityReport = Record<string, RuntimeHealth>;

export interface RuntimeProbeCommand {
  command: string;
  args: string[];
}

export interface RuntimeDiscoveryOptions {
  resolveCommand?: (runtimeId: string) => RuntimeProbeCommand;
  probe?: (command: string, args: string[]) => Promise<RuntimeProbeResult>;
}

const PROBE_TIMEOUT_MS = 2_500;
const MAX_PROBE_OUTPUT = 16 * 1024;

function firstVersionLine(output: string): string | null {
  const line = output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ? line.slice(0, 160) : null;
}

export function resolveRuntimeProbeCommand(runtimeId: string): RuntimeProbeCommand {
  if (runtimeId === 'hermes') {
    return {
      command: process.env.HERMES_ACP_COMMAND?.trim() || 'hermes-acp',
      args: ['--help'],
    };
  }
  return {
    command: createAdapter(runtimeId).resolveBin(),
    args: ['--version'],
  };
}

export async function probeRuntimeCommand(
  command: string,
  args: string[],
): Promise<RuntimeProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    let started = false;
    const finish = (result: RuntimeProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = crossSpawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.once('spawn', () => {
      started = true;
    });
    const append = (chunk: Buffer | string) => {
      if (output.length >= MAX_PROBE_OUTPUT) return;
      output += String(chunk).slice(0, MAX_PROBE_OUTPUT - output.length);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish({
        installed: false,
        healthy: false,
        version: null,
        reason: error.code === 'ENOENT' ? 'not_found' : 'not_executable',
      });
    });
    child.once('close', (code) => {
      finish({
        installed: true,
        healthy: code === 0,
        version: firstVersionLine(output),
        reason: code === 0 ? null : 'probe_failed',
      });
    });
    const timer = setTimeout(() => {
      if (started) child.kill();
      finish({
        installed: started,
        healthy: false,
        version: firstVersionLine(output),
        reason: 'probe_timeout',
      });
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
}

/**
 * Discovers all registered runtimes once at Runtime Host boot. The resulting
 * report is cached by the caller and reused by every heartbeat, so a slow or
 * broken executable never stalls the 30-second presence loop.
 */
export async function discoverRuntimeCapabilities(
  options: RuntimeDiscoveryOptions = {},
): Promise<RuntimeCapabilityReport> {
  const resolveCommand = options.resolveCommand ?? resolveRuntimeProbeCommand;
  const probe = options.probe ?? probeRuntimeCommand;
  const rows = await Promise.all(
    KNOWN_RUNTIME_IDS.map(async (runtimeId) => {
      const capabilities = getRuntimeDescriptor(runtimeId).capabilities;
      try {
        const { command, args } = resolveCommand(runtimeId);
        const result = await probe(command, args);
        return [runtimeId, { ...result, capabilities }] as const;
      } catch {
        return [
          runtimeId,
          {
            installed: false,
            healthy: false,
            version: null,
            reason: 'probe_unavailable',
            capabilities,
          },
        ] as const;
      }
    }),
  );
  return Object.fromEntries(rows);
}
