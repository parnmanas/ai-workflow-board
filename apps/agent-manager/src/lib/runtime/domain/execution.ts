export type RuntimeExecutionMode = 'oneshot' | 'persistent' | 'resume' | 'control';

export interface NormalizedRuntimeRequest {
  readonly prompt: string;
  readonly mode: RuntimeExecutionMode;
  readonly model?: string;
  readonly effort?: string;
  readonly sessionId?: string;
  readonly systemPrompt?: string;
  readonly mcpServers?: readonly string[];
  readonly streaming?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface NegotiatedRuntimeRequest extends NormalizedRuntimeRequest {
  readonly omitted: readonly RuntimeRequestOption[];
}

export type RuntimeRequestOption =
  | 'model'
  | 'effort'
  | 'sessionId'
  | 'systemPrompt'
  | 'mcpServers'
  | 'streaming';

export interface RuntimeResult {
  readonly text: string;
  readonly sessionId?: string;
  readonly usage?: Readonly<Record<string, number>>;
}

export interface RuntimeError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly pluginId: string;
}
