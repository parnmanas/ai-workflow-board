// CLI 모듈 조회 — 소비자는 CLI 이름을 비교하지 않고 여기서 모듈을 받아 슬라이스를 본다.
//
// 저장소는 런타임 플러그인 레지스트리 하나뿐이다(`runtime/runtime-registry.ts`):
// `CliModule` 은 `RuntimePluginManifest` 의 상위 집합이라 같은 레지스트리에 그대로
// 등록되고, 여기서는 그 manifest 를 `CliModule` 로 읽어 준다. 확장 플러그인
// (`composeRuntime(extensions)`)이 슬라이스 없이 등록돼도 조회는 실패하지 않는다 —
// 슬라이스가 없으면 "그 기능을 지원하지 않는다" 로 읽힌다.

import { runtimePluginRegistry } from '../runtime/runtime-registry.js';
import type { RuntimePluginManifest } from '../runtime/composition/plugin-manifest.js';
import type {
  CliCredentialProviderSpec,
  CliCredentialSpec,
  CliDispatchSpec,
  CliEffortSpec,
  CliLoginSpec,
  CliModule,
  CliSessionSpec,
} from './cli-module.js';

export type {
  CliBinarySpec,
  CliCredentialProviderSpec,
  CliCredentialSpec,
  CliDispatchSpec,
  CliEffortKey,
  CliEffortSpec,
  CliLoginParsed,
  CliLoginPlan,
  CliLoginSpec,
  CliModule,
  CliSessionSpec,
  CliSessionStoreContext,
  CliSessionStoreDriver,
} from './cli-module.js';
export { defineCliModule } from './cli-module.js';
export { BUILTIN_CLI_MODULES } from './builtin.js';

/** 슬라이스 없는 manifest(외부 확장)도 CliModule 로 읽을 수 있게 label 만 채운다. */
function asCliModule(manifest: RuntimePluginManifest): CliModule {
  const m = manifest as Partial<CliModule> & RuntimePluginManifest;
  return typeof m.label === 'string' ? (m as CliModule) : { ...m, label: m.id };
}

/** 등록된 모듈. 모르는 id 면 `RuntimeSelectionError('runtime_unknown')` — 레지스트리와 같은 오류. */
export function cliModule(id: string | null | undefined): CliModule {
  return asCliModule(runtimePluginRegistry.manifest(id));
}

/** 등록된 모듈 또는 null. 이름이 비었거나 모르는 경우 모두 null. */
export function findCliModule(id: string | null | undefined): CliModule | null {
  try {
    return cliModule(id);
  } catch {
    return null;
  }
}

export function listCliModules(): readonly CliModule[] {
  return runtimePluginRegistry.ids().map((id) => cliModule(id));
}

/** 이 빌드가 아는 CLI id 전부(hermes 같은 ACP 런타임 포함). */
export const KNOWN_CLI_IDS: readonly string[] = runtimePluginRegistry.ids();

export function isKnownCli(id: string | null | undefined): boolean {
  return findCliModule(id) !== null;
}

/** ACP 프로토콜 소유자(hermes)로 도는 런타임인가 — CLI 어댑터 spawn 경로 대신 RuntimeSupervisor 가 맡는다. */
export function isAcpRuntime(id: string | null | undefined): boolean {
  return findCliModule(id)?.transport === 'acp';
}

/** 해당 슬라이스를 가진 모듈만. */
export function cliModulesWith<K extends 'binary' | 'credentials' | 'login' | 'sessions' | 'effort' | 'dispatch'>(
  slice: K,
): Array<CliModule & { [P in K]-?: NonNullable<CliModule[P]> }> {
  return listCliModules().filter((m) => m[slice] !== undefined) as Array<CliModule & { [P in K]-?: NonNullable<CliModule[P]> }>;
}

export function cliLogin(id: string | null | undefined): CliLoginSpec | null {
  return findCliModule(id)?.login ?? null;
}

export function cliSessions(id: string | null | undefined): CliSessionSpec | null {
  return findCliModule(id)?.sessions ?? null;
}

export function cliCredentials(id: string | null | undefined): CliCredentialSpec | null {
  return findCliModule(id)?.credentials ?? null;
}

export function cliEffort(id: string | null | undefined): CliEffortSpec | null {
  return findCliModule(id)?.effort ?? null;
}

export function cliDispatch(id: string | null | undefined): CliDispatchSpec {
  return findCliModule(id)?.dispatch ?? {};
}

/** provider id(`claude_subscription`) → 그것을 선언한 모듈과 provider. */
export function findCredentialProvider(
  providerId: string | null | undefined,
): { module: CliModule; provider: CliCredentialProviderSpec } | null {
  if (!providerId) return null;
  for (const module of cliModulesWith('credentials')) {
    const provider = module.credentials.providers.find((p) => p.id === providerId);
    if (provider) return { module, provider };
  }
  return null;
}

/** provider 의 필수 필드. 모르는 provider 는 null(= 검사 없음, 이전 동작). */
export function requiredCredentialFields(providerId: string | null | undefined): readonly string[] | null {
  return findCredentialProvider(providerId)?.provider.required ?? null;
}

/** 하트비트 `agent_credentials.kind` 분류. 선언이 없으면 접미어로 추론한다. */
export function credentialProviderKind(providerId: string): 'subscription' | 'api_key' {
  const declared = findCredentialProvider(providerId)?.provider.kind;
  if (declared) return declared;
  if (providerId.endsWith('_api_key')) return 'api_key';
  // env 로만 주입되는 장기 토큰(claude_oauth_token 류)은 만료 파일이 없으므로 api_key 와 같은 취급.
  if (providerId.endsWith('_oauth_token')) return 'api_key';
  // Unknown shape — assume subscription so the heartbeat still tries to read the
  // credential file. Worst case the adapter returns null and the UI shows "no
  // credential metadata" rather than mis-labeling api_key.
  return 'subscription';
}

/** Agent Session 을 열 수 있는 CLI(하트비트 `acp_session_clis` 후보). */
export function sessionCapableCliIds(): string[] {
  return cliModulesWith('sessions').map((m) => m.id);
}
