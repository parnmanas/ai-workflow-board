import { BUILTIN_CLI_MODULES } from '../../clis/builtin.js';
import type { RuntimePluginManifest } from './plugin-manifest.js';
import { RuntimePluginRegistry } from './plugin-registry.js';

// 내장 런타임은 전부 `clis/<id>/index.ts` 의 CliModule 이다 — manifest(어댑터·capability)
// 에 바이너리/자격증명/로그인/세션/effort/디스패치 슬라이스를 얹은 상위 집합이라
// 같은 레지스트리에 그대로 등록된다. 새 CLI 는 `clis/builtin.ts` 목록에만 추가한다.
//
// ticket 5851e435 — permission_tiers 는 어댑터의 permissionCapabilities() 와 **같은
// 상수**에서 가져온다(각 모듈이 permission-policy 의 상수를 직접 참조). 두 곳에 손으로
// 적어두면 드리프트가 나고, 그 순간 운영자가 heartbeat 에서 보는 능력 선언과 실제 spawn
// 동작이 어긋난다(permission-capability-report 회귀 테스트가 일치를 강제한다).
export function createBuiltinRuntimeRegistry(extensions: readonly RuntimePluginManifest[] = []): RuntimePluginRegistry {
  const registry = new RuntimePluginRegistry();
  for (const module of BUILTIN_CLI_MODULES) registry.register(module);
  for (const extension of extensions) registry.register(extension);
  return registry.seal();
}
