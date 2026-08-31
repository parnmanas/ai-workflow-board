import { negotiateCapabilities } from './negotiate-capabilities.js';
import type { NormalizedRuntimeRequest, RuntimeError } from '../domain/execution.js';
import type { CliExecutionAdapterPort, CliOneshotRequestPort, CliSessionRequestPort, CliSpawnDescriptorPort, RuntimeInfrastructurePorts, RuntimePluginLookupPort } from '../ports/index.js';

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
  constructor(private readonly registry: RuntimePluginLookupPort, readonly ports: RuntimeInfrastructurePorts) {}

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

  async complete(runtimeId: string, request: NormalizedRuntimeRequest) {
    const negotiated = this.#negotiate(runtimeId, request);
    const provider = this.registry.createLlmProvider(runtimeId);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await provider.complete(negotiated);
        this.ports.telemetry.record('request.completed', { runtimeId, mode: negotiated.mode, attempt });
        return result;
      } catch (cause) {
        const error = this.ports.errors.normalize(runtimeId, cause);
        this.ports.telemetry.record('request.failed', { runtimeId, code: error.code, attempt });
        if (!this.ports.retry.shouldRetry(error, attempt)) throw error;
      }
    }
  }

  #negotiate(runtimeId: string, request: NormalizedRuntimeRequest) {
    const capabilitySafe = negotiateCapabilities(request, this.registry.manifest(runtimeId).capabilities);
    const transported = {
      ...capabilitySafe,
      prompt: this.ports.prompt.encode(capabilitySafe),
      sessionId: this.ports.session.sessionId(capabilitySafe),
      mcpServers: this.ports.tools.configure(capabilitySafe).mcpServers,
    };
    // infrastructure 변환 뒤 한 번 더 협상해 포트가 미지원 옵션을 되살리지 못하게 한다.
    const finalNegotiated = negotiateCapabilities(transported, this.registry.manifest(runtimeId).capabilities);
    const negotiated = Object.freeze({
      ...finalNegotiated,
      omitted: Object.freeze([...new Set([...capabilitySafe.omitted, ...finalNegotiated.omitted])]),
    });
    this.ports.telemetry.record('request.negotiated', { runtimeId, mode: negotiated.mode, omitted: negotiated.omitted });
    return negotiated;
  }

  normalizeError(pluginId: string, cause: unknown): RuntimeError {
    return this.ports.errors.normalize(pluginId, cause);
  }

  shouldRetry(error: RuntimeError, attempt: number): boolean {
    return this.ports.retry.shouldRetry(error, attempt);
  }
}
