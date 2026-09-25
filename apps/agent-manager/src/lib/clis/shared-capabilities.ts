// 여러 CLI 모듈이 공유하는 capability 프리셋.
//
// ticket 5851e435 — permission_tiers 는 어댑터의 permissionCapabilities() 와
// **같은 상수**에서 가져온다. 두 곳에 손으로 적어두면 드리프트가 나고, 그 순간
// 운영자가 heartbeat 에서 보는 능력 선언과 실제 spawn 동작이 어긋난다
// (permission-capability-report 회귀 테스트가 일치를 강제한다).

import type { RuntimeCapabilities } from '../runtime/runtime-types.js';

/** jsonl one-shot CLI 의 기본 capability(codex / antigravity / pi / opencode). */
export function oneshotCapabilities(
  native_mcp: boolean,
  usage: RuntimeCapabilities['usage'],
  permission_tiers: RuntimeCapabilities['permission_tiers'],
): RuntimeCapabilities {
  return {
    protocol: 'jsonl',
    session: 'oneshot',
    native_mcp,
    native_approvals: false,
    steering: false,
    cancellation: true,
    usage,
    collaboration: [],
    skill_delivery: native_mcp ? ['prompt', 'filesystem'] : ['prompt'],
    permission_tiers,
  };
}
