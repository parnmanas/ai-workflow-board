import { isAbsolute } from 'node:path';
import { resolveCliBin } from '../cli-resolver.js';
import {
  getRuntimeDescriptor,
  KNOWN_RUNTIME_IDS,
  createRuntimeCliAdapter,
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
    command: createRuntimeCliAdapter(runtimeId).resolveBin(),
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

export interface CliResolutionResult extends RuntimeProbeResult {
  /** probe에 실제로 쓰인 절대경로. PATH lookup이 literal 이름으로 fallback했거나
   *  경로 해석 자체가 실패하면 null — "설치는 됐지만 어디 있는지 모른다"가 아니라
   *  "PATH가 이 절대경로를 골랐다"를 드러내, 같은 버전의 중복 바이너리나 잘못된
   *  경로 우선순위 선택(ticket 702d0ebe의 codex snap/npm-global 사례)을 기동
   *  로그만으로 판별할 수 있게 한다. */
  resolvedPath: string | null;
}

/**
 * `codex`/`claude`/`gh`/`git` 같은 CLI를 discoverRuntimeCapabilities와 동일한
 * 방식으로 probe하되, `resolveCliBin`(ticket 702d0ebe/ce65cf25에서 검증된
 * well-known 후보 → PATH lookup 순서, Windows `where`/POSIX `command -v`
 * 모두 지원)으로 먼저 절대경로를 구해 그 경로로 probe한다 — 어떤 실행 파일이
 * 선택됐는지가 실제로 실행에 쓰인 값과 항상 일치한다. 절대 throw하지 않는다 —
 * 경로 해석이 실패해도, probe 자체가 실패해도 discoverRuntimeCapabilities의
 * catch 분기와 동일한 `probe_unavailable` 형태로 degrade한다(기동 자체를
 * 막지 않는다).
 */
export async function checkAuxiliaryCli(
  command: string,
  probe: (command: string, args: string[]) => Promise<RuntimeProbeResult> = probeRuntimeCommand,
  resolveBin: (cliType: string) => string = resolveCliBin,
): Promise<CliResolutionResult> {
  let resolvedPath: string | null = null;
  try {
    const bin = resolveBin(command);
    if (isAbsolute(bin)) resolvedPath = bin;
  } catch {
    // 경로 해석 자체가 throw해도 무시 — 아래 probe가 literal 이름으로 계속
    // 시도한다(기존 fallback 동작 유지).
  }
  try {
    const result = await probe(resolvedPath ?? command, ['--version']);
    return { ...result, resolvedPath };
  } catch {
    return { installed: false, healthy: false, version: null, reason: 'probe_unavailable', resolvedPath };
  }
}

/**
 * (id, probe 결과) 목록을 사람이 grep하기 쉬운 한 줄 로그로 렌더링한다. 절대경로는
 * 항상 큰따옴표로 감싼다 — Windows의 `C:\Program Files\...` 처럼 경로 자체에
 * 공백이 있어도 어디까지가 경로인지 모호해지지 않는다.
 * 예: `claude=2.1.3@"/usr/local/bin/claude" gh=NOT_FOUND(not_found)@- git=2.43.0@"/usr/bin/git"` —
 * ticket 49c173c8의 기동 시점 CLI 해석 신호.
 */
export function formatCliResolutionSummary(
  entries: ReadonlyArray<readonly [string, CliResolutionResult]>,
): string {
  return entries
    .map(([id, r]) => {
      const status = r.installed ? (r.version ?? 'installed') : `NOT_FOUND(${r.reason ?? 'unknown'})`;
      const path = r.resolvedPath ? `"${r.resolvedPath.replace(/"/g, '\\"')}"` : '-';
      return `${id}=${status}@${path}`;
    })
    .join(' ');
}
