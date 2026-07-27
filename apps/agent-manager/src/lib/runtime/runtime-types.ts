export type RuntimeErrorCode =
  | 'runtime_not_configured'
  | 'runtime_unknown'
  | 'runtime_unavailable'
  | 'runtime_config_invalid';

export type RuntimeProtocol = 'stream-json' | 'jsonl' | 'acp';
export type RuntimeSessionMode = 'oneshot' | 'persistent' | 'resumable';
export type RuntimeUsageMode = 'none' | 'tokens' | 'tokens-and-cost';
export type RuntimeCollaboration = 'delegated' | 'swarm';
export type RuntimeSkillDelivery = 'prompt' | 'filesystem' | 'native';
export type ExecutionStrategy = 'single' | RuntimeCollaboration;
export type RuntimePermissionMode = 'strict' | 'approve' | 'trusted';

export interface RuntimeCapabilities {
  protocol: RuntimeProtocol;
  session: RuntimeSessionMode;
  native_mcp: boolean;
  native_approvals: boolean;
  steering: boolean;
  cancellation: boolean;
  usage: RuntimeUsageMode;
  collaboration: RuntimeCollaboration[];
  skill_delivery: RuntimeSkillDelivery[];
}

export interface RuntimeDescriptor {
  id: string;
  capabilities: RuntimeCapabilities;
}

export interface AgentRuntimeConfig {
  strategy: ExecutionStrategy;
  permission_mode: RuntimePermissionMode;
  profile?: string;
  max_children?: number;
  max_iterations?: number;
  extra?: Record<string, unknown>;
}

export class RuntimeSelectionError extends Error {
  readonly code: RuntimeErrorCode;
  readonly runtimeId: string | null;

  constructor(code: RuntimeErrorCode, runtimeId: string | null, message: string) {
    super(message);
    this.name = 'RuntimeSelectionError';
    this.code = code;
    this.runtimeId = runtimeId;
  }
}
