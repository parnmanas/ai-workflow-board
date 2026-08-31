import type { CliAdapter } from '../../cli-adapters/base.js';
import type { RuntimePluginRegistry } from './plugin-registry.js';
import { RuntimeExecutionFacade } from '../application/runtime-execution-facade.js';
import type { OneshotSpec, SessionSpec } from '../../cli-adapters/base.js';
import type { RuntimeInfrastructurePorts } from '../ports/index.js';

/**
 * 실행 소유자별 CLI adapter 수명과 조회를 composition 계층에서 관리한다.
 * 세션·서브에이전트 관리자는 provider 생성 방식이나 registry를 알지 않는다.
 */
export class RuntimeAdapterResolver {
  readonly #adapters = new Map<string, CliAdapter>();
  readonly #facade: RuntimeExecutionFacade;

  constructor(private readonly registry: RuntimePluginRegistry, readonly ports: RuntimeInfrastructurePorts) {
    this.#facade = new RuntimeExecutionFacade(registry, ports);
  }

  resolve(runtimeId: string | null | undefined): CliAdapter {
    const id = String(runtimeId || 'claude').trim().toLowerCase();
    let adapter = this.#adapters.get(id);
    if (!adapter) {
      adapter = this.registry.createCliAdapter(id);
      this.#adapters.set(id, adapter);
    }
    return adapter;
  }

  buildOneshot(runtimeId: string | null | undefined, spec: OneshotSpec) {
    const id = String(runtimeId || 'claude').trim().toLowerCase();
    const adapter = this.resolve(id);
    const prepared = this.#facade.prepareOneshot(id, spec, adapter);
    return { ...prepared, adapter };
  }

  buildSession(runtimeId: string | null | undefined, mode: 'persistent' | 'resume' | 'control', spec: SessionSpec, sessionId?: string) {
    const id = String(runtimeId || 'claude').trim().toLowerCase();
    const adapter = this.resolve(id);
    const prepared = this.#facade.prepareSession(id, mode, spec, sessionId, adapter);
    return { ...prepared, adapter };
  }

  spawnProcess(command: string, args: readonly string[], options: Readonly<Record<string, unknown>>) {
    return this.ports.process.spawn(command, args, options);
  }
}
