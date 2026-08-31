import type { CliAdapter } from '../../cli-adapters/base.js';
import type { RuntimePluginRegistry } from './plugin-registry.js';

/**
 * 실행 소유자별 CLI adapter 수명과 조회를 composition 계층에서 관리한다.
 * 세션·서브에이전트 관리자는 provider 생성 방식이나 registry를 알지 않는다.
 */
export class RuntimeAdapterResolver {
  readonly #adapters = new Map<string, CliAdapter>();

  constructor(private readonly registry: RuntimePluginRegistry) {}

  resolve(runtimeId: string | null | undefined): CliAdapter {
    const id = String(runtimeId || 'claude').trim().toLowerCase();
    let adapter = this.#adapters.get(id);
    if (!adapter) {
      adapter = this.registry.createCliAdapter(id);
      this.#adapters.set(id, adapter);
    }
    return adapter;
  }
}
