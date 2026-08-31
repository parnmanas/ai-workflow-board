import type { NormalizedRuntimeRequest, RuntimeError, RuntimeResult } from '../domain/execution.js';

export interface CliTransportPort { execute(request: NormalizedRuntimeRequest): Promise<RuntimeResult>; }
export interface LlmProviderPort { complete(request: NormalizedRuntimeRequest): Promise<RuntimeResult>; }
export interface SessionStrategyPort { sessionId(request: NormalizedRuntimeRequest): string | undefined; }
export interface PromptTransportPort { encode(request: NormalizedRuntimeRequest): string | Uint8Array; }
export interface ToolBridgePort { configure(request: NormalizedRuntimeRequest): Promise<Readonly<Record<string, unknown>>>; }
export interface ProcessRunnerPort { run(command: string, args: readonly string[], env: Readonly<Record<string, string>>): Promise<RuntimeResult>; }
export interface RetryPolicyPort { shouldRetry(error: RuntimeError, attempt: number): boolean; }
export interface TelemetryPort { record(event: string, fields: Readonly<Record<string, unknown>>): void; }
