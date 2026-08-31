import type { NormalizedRuntimeRequest, RuntimeError, RuntimeResult } from '../domain/execution.js';
import type { RuntimePluginCapabilities } from '../domain/capabilities.js';

export interface CliSpawnDescriptorPort { args: string[]; stdio: any; writePrompt?: (child: any) => void; needsMcpConfig?: boolean; }
export interface CliOneshotRequestPort {
  rolePrompt: string; taskText: string; mcpConfigPath: string | null; cwd?: string | null;
  cliHomeDir?: string | null; mcpAttribution?: any; model?: string | null; harness?: any;
  effort?: string | null; ultracode?: boolean;
}
export interface CliSessionRequestPort {
  rolePrompt: string; mcpConfigPath: string | null; model?: string | null; harness?: any;
  effort?: string | null; ultracode?: boolean;
  sessionMode?: 'persistent' | 'resume' | 'control'; sessionId?: string;
}
export interface CliExecutionAdapterPort {
  buildOneshotSpawn(spec: CliOneshotRequestPort): CliSpawnDescriptorPort;
  buildSessionSpawn(spec: CliSessionRequestPort): CliSpawnDescriptorPort;
}
export interface RuntimePluginLookupPort {
  manifest(runtimeId: string): { readonly capabilities: RuntimePluginCapabilities };
  createCliAdapter(runtimeId: string): CliExecutionAdapterPort;
  createLlmProvider(runtimeId: string): LlmProviderPort;
}

export interface CliTransportPort { execute(request: NormalizedRuntimeRequest): Promise<RuntimeResult>; }
export interface LlmProviderPort { complete(request: NormalizedRuntimeRequest): Promise<RuntimeResult>; }
export interface SessionStrategyPort { sessionId(request: NormalizedRuntimeRequest): string | undefined; }
export interface PromptTransportPort { encode(request: NormalizedRuntimeRequest): string; }
export interface ToolBridgePort {
  configure(request: NormalizedRuntimeRequest): { readonly mcpServers?: readonly string[] };
}
export interface ProcessRunnerPort {
  spawn(command: string, args: readonly string[], options: Readonly<Record<string, unknown>>): any;
}
export interface RetryPolicyPort { shouldRetry(error: RuntimeError, attempt: number): boolean; }
export interface ErrorNormalizationPort { normalize(pluginId: string, cause: unknown): RuntimeError; }
export interface TelemetryPort { record(event: string, fields: Readonly<Record<string, unknown>>): void; }

export interface RuntimeInfrastructurePorts {
  readonly session: SessionStrategyPort;
  readonly prompt: PromptTransportPort;
  readonly tools: ToolBridgePort;
  readonly process: ProcessRunnerPort;
  readonly retry: RetryPolicyPort;
  readonly errors: ErrorNormalizationPort;
  readonly telemetry: TelemetryPort;
}
