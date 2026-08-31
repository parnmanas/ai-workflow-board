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
}
export interface CliExecutionAdapterPort {
  buildOneshotSpawn(spec: CliOneshotRequestPort): CliSpawnDescriptorPort;
  buildSessionSpawn(spec: CliSessionRequestPort): CliSpawnDescriptorPort;
}
export interface RuntimePluginLookupPort {
  manifest(runtimeId: string): { readonly capabilities: RuntimePluginCapabilities };
  createCliAdapter(runtimeId: string): CliExecutionAdapterPort;
}

export interface CliTransportPort { execute(request: NormalizedRuntimeRequest): Promise<RuntimeResult>; }
export interface LlmProviderPort { complete(request: NormalizedRuntimeRequest): Promise<RuntimeResult>; }
export interface SessionStrategyPort { sessionId(request: NormalizedRuntimeRequest): string | undefined; }
export interface PromptTransportPort { encode(request: NormalizedRuntimeRequest): string | Uint8Array; }
export interface ToolBridgePort { configure(request: NormalizedRuntimeRequest): Promise<Readonly<Record<string, unknown>>>; }
export interface ProcessRunnerPort { run(command: string, args: readonly string[], env: Readonly<Record<string, string>>): Promise<RuntimeResult>; }
export interface RetryPolicyPort { shouldRetry(error: RuntimeError, attempt: number): boolean; }
export interface TelemetryPort { record(event: string, fields: Readonly<Record<string, unknown>>): void; }
