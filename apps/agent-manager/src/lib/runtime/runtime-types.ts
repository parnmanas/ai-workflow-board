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

/** 런타임이 한 권한 등급을 얼마나 충실히 표현하는가 (ticket 5851e435).
 *  `permission-policy.ts` 의 PermissionTierSupport 와 같은 값 집합이며, 이쪽은
 *  heartbeat 로 AWB 에 보고되는 wire 표현이다. */
export type RuntimePermissionTierSupport = 'native' | 'approximated' | 'unsupported';

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
  /**
   * 등급별 표현력 (ticket 5851e435 — "지원하지 않는 CLI 는 capabilities 로
   * 명시하고 silent downgrade 하지 않는다"). 로그만으로는 운영자가 볼 수
   * 없으므로 heartbeat 의 runtime_capabilities 에 실어 admin 쪽에서
   * "이 런타임의 approve 는 승인 요청을 못 만든다"는 사실이 보이게 한다.
   * 어댑터의 `permissionCapabilities().tiers` 와 항상 같은 값이어야 하며,
   * 회귀 테스트가 둘의 일치를 강제한다.
   */
  permission_tiers: Readonly<Record<RuntimePermissionMode, RuntimePermissionTierSupport>>;
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
