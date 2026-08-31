import { RuntimeExecutionFacade } from '../application/runtime-execution-facade.js';
import { createBuiltinRuntimeRegistry } from './builtin-plugins.js';
import type { RuntimePluginManifest } from './plugin-manifest.js';

/** 외부 plugin manifest 목록만으로 완성된 실제 실행 composition을 만든다. */
export function composeRuntime(extensions: readonly RuntimePluginManifest[] = []) {
  const registry = createBuiltinRuntimeRegistry(extensions);
  return Object.freeze({ registry, facade: new RuntimeExecutionFacade(registry) });
}
