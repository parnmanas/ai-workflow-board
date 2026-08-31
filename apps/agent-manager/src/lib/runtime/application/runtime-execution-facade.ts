import { negotiateCapabilities } from './negotiate-capabilities.js';
import type { NormalizedRuntimeRequest } from '../domain/execution.js';
import type { CliExecutionAdapterPort, CliOneshotRequestPort, CliSessionRequestPort, CliSpawnDescriptorPort, RuntimePluginLookupPort } from '../ports/index.js';

export interface PreparedCliExecution<TSpec extends CliOneshotRequestPort | CliSessionRequestPort> {
  readonly adapter: CliExecutionAdapterPort;
  readonly request: ReturnType<typeof negotiateCapabilities>;
  readonly spec: TSpec;
  readonly descriptor: CliSpawnDescriptorPort;
}

/**
 * 모든 CLI 실행 모드가 공유하는 application 경계다. provider capability를
 * 협상한 뒤에만 provider별 argv builder를 호출하므로 미지원 값이 최종 요청에
 * 다시 섞일 수 없다.
 */
export class RuntimeExecutionFacade {
  constructor(private readonly registry: RuntimePluginLookupPort) {}

  prepareOneshot(runtimeId: string, spec: CliOneshotRequestPort, adapter: CliExecutionAdapterPort = this.registry.createCliAdapter(runtimeId)): PreparedCliExecution<CliOneshotRequestPort> {
    const request = this.#negotiate(runtimeId, {
      prompt: spec.taskText,
      mode: 'oneshot',
      model: spec.model ?? undefined,
      effort: spec.effort ?? undefined,
      systemPrompt: spec.rolePrompt || undefined,
      mcpServers: spec.mcpConfigPath ? [spec.mcpConfigPath] : undefined,
      streaming: false,
    });
    const negotiatedSpec: CliOneshotRequestPort = {
      ...spec,
      taskText: request.prompt,
      rolePrompt: request.systemPrompt ?? '',
      model: request.model ?? null,
      effort: request.effort ?? null,
      mcpConfigPath: request.mcpServers?.[0] ?? null,
    };
    return Object.freeze({ adapter, request, spec: negotiatedSpec, descriptor: adapter.buildOneshotSpawn(negotiatedSpec) });
  }

  prepareSession(runtimeId: string, mode: 'persistent' | 'resume' | 'control', spec: CliSessionRequestPort, sessionId?: string, adapter: CliExecutionAdapterPort = this.registry.createCliAdapter(runtimeId)): PreparedCliExecution<CliSessionRequestPort> {
    const request = this.#negotiate(runtimeId, {
      prompt: '',
      mode,
      model: spec.model ?? undefined,
      effort: spec.effort ?? undefined,
      sessionId,
      systemPrompt: spec.rolePrompt || undefined,
      mcpServers: spec.mcpConfigPath ? [spec.mcpConfigPath] : undefined,
      streaming: true,
    });
    const negotiatedSpec: CliSessionRequestPort = {
      ...spec,
      rolePrompt: request.systemPrompt ?? '',
      model: request.model ?? null,
      effort: request.effort ?? null,
      mcpConfigPath: request.mcpServers?.[0] ?? null,
    };
    return Object.freeze({ adapter, request, spec: negotiatedSpec, descriptor: adapter.buildSessionSpawn(negotiatedSpec) });
  }

  #negotiate(runtimeId: string, request: NormalizedRuntimeRequest) {
    return negotiateCapabilities(request, this.registry.manifest(runtimeId).capabilities);
  }
}
