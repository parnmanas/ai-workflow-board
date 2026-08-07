import { createAdapter } from '../cli-adapters/index.js';
import {
  getRuntimeDescriptor,
  KNOWN_RUNTIME_IDS,
} from './runtime-registry.js';
import type { RuntimeCapabilities } from './runtime-types.js';
import { probeRuntimeCommand, type RuntimeProbeResult } from './probe-command.js';
import {
  listHermesProfiles as defaultListHermesProfiles,
  resolveHermesAcpCommand,
} from './hermes/hermes-command.js';

export type { RuntimeProbeResult } from './probe-command.js';
export { probeRuntimeCommand } from './probe-command.js';

export interface RuntimeHealth extends RuntimeProbeResult {
  capabilities: RuntimeCapabilities;
  /** Hermes 전용: Runtime Host가 지금 열거할 수 있는 프로파일 이름 목록.
   *  다른 런타임에서는 undefined; `[]`는 "설치는 됐지만 named profile 없음"
   *  (또는 열거 실패)을 뜻하며 `healthy`를 의심할 근거가 되지 않는다. */
  profiles?: string[];
}

export type RuntimeCapabilityReport = Record<string, RuntimeHealth>;

export interface RuntimeProbeCommand {
  command: string;
  args: string[];
}

export interface RuntimeDiscoveryOptions {
  resolveCommand?: (runtimeId: string) => RuntimeProbeCommand | Promise<RuntimeProbeCommand>;
  probe?: (command: string, args: string[]) => Promise<RuntimeProbeResult>;
  listHermesProfiles?: () => Promise<string[]>;
}

export async function resolveRuntimeProbeCommand(runtimeId: string): Promise<RuntimeProbeCommand> {
  if (runtimeId === 'hermes') {
    const { command, argsPrefix } = await resolveHermesAcpCommand();
    return { command, args: [...argsPrefix, '--help'] };
  }
  return {
    command: createAdapter(runtimeId).resolveBin(),
    args: ['--version'],
  };
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
  const listHermesProfiles = options.listHermesProfiles ?? defaultListHermesProfiles;
  const rows = await Promise.all(
    KNOWN_RUNTIME_IDS.map(async (runtimeId) => {
      const capabilities = getRuntimeDescriptor(runtimeId).capabilities;
      try {
        const { command, args } = await resolveCommand(runtimeId);
        const result = await probe(command, args);
        // 프로파일 열거는 best-effort이자 부가적이다: 여기서의 실패가
        // `healthy`(주 프로브만을 반영)를 절대 뒤집으면 안 된다.
        const profiles = runtimeId === 'hermes' && result.installed
          ? await listHermesProfiles().catch(() => [])
          : undefined;
        return [
          runtimeId,
          { ...result, capabilities, ...(profiles ? { profiles } : {}) },
        ] as const;
      } catch {
        return [
          runtimeId,
          {
            installed: false,
            healthy: false,
            version: null,
            reason: 'probe_unavailable',
            capabilities,
            ...(runtimeId === 'hermes' ? { profiles: [] } : {}),
          },
        ] as const;
      }
    }),
  );
  return Object.fromEntries(rows);
}
