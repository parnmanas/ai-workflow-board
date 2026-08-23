// ticket c3b767c6 — dispatch-time manager-capability compatibility gate.
//
// Incident this closes (source ticket 1af53029): a separate host's stale
// agent-manager build silently ignored a Claude backend profile's
// context_window/safety_margin_tokens and requested the CLI's fixed default
// output budget regardless — reproducing the same vLLM context-overflow 500
// the profile fix was meant to prevent. The central server had no way to
// tell that manager's build apart from a healthy one, so diagnosing the
// recurrence took a long time.
//
// Every agent-manager build now declares the dispatch-gated features it
// implements on its heartbeat (`manager_capabilities` — see
// apps/agent-manager/src/lib/runtime-profiles.ts MANAGER_CAPABILITIES and
// instance-heartbeat.ts). The functions here are the pure decision layer both
// dispatch call sites (TriggerLoopService for ticket triggers,
// RoomMessagingService for chat) use BEFORE emitting a trigger/chat_request:
// resolve what the profile needs, check it against the target agent's live
// manager instance(s), and refuse to dispatch — with a clear reason — rather
// than spawn a session doomed to hang.
import type { CliRuntimeProfile } from './cli-runtime-profiles';

/** Mirrors apps/agent-manager/src/lib/runtime-profiles.ts
 *  MANAGER_CAPABILITY_CONTEXT_WINDOW_CLAMP — keep both string literals in
 *  sync if either side is ever renamed. */
export const MANAGER_CAPABILITY_CONTEXT_WINDOW_CLAMP = 'context_window_clamp';

/** The subset of InstanceRecord (apps/server/src/modules/agent-manager/
 *  instance-registry.service.ts) this module needs — kept as a narrow
 *  structural type so this file never has to import that module (which lives
 *  one layer up, in a NestJS feature module) and stays a plain, DI-free unit. */
export interface ManagerCapabilitySnapshot {
  plugin_version: string;
  manager_capabilities?: string[];
}

export interface ManagerCapabilityVerdict {
  ok: boolean;
  /** Present only when ok=false. Stable string for logs/audit rows. */
  reason?: string;
  /** Present only when ok=false. Human-readable (Korean), safe to surface in
   *  a ticket comment / chat system message / admin log. */
  detail?: string;
}

/** The capability flag a resolved dispatch profile requires, or null when it
 *  doesn't opt into anything an old manager could silently get wrong. Mirrors
 *  the exact condition resolveMaxOutputTokensEnv() uses to decide whether to
 *  clamp (apps/agent-manager/src/lib/runtime-profiles.ts) — a profile without
 *  context_window is a no-op for every manager build, old or new. */
export function requiredManagerCapability(profile: CliRuntimeProfile | null | undefined): string | null {
  return profile?.context_window ? MANAGER_CAPABILITY_CONTEXT_WINDOW_CLAMP : null;
}

/** Pure verdict over a snapshot of the target agent's LIVE manager
 *  instance(s) (InstanceRegistryService.listForAgent()).
 *
 *  - Zero live instances → fail OPEN (`ok:true`). We have no telemetry to
 *    prove an incompatibility — a fresh pairing or a TTL sweep between
 *    heartbeats looks identical to "no manager at all" from here, and
 *    refusing every dispatch on missing data would be a worse regression
 *    than the silent-failure gap this closes.
 *  - At least one live instance, and ANY of them lacks `capability` → fail
 *    CLOSED. This is deliberately NOT "at least one supports it": which
 *    physical process actually receives a given SSE-routed trigger is not
 *    something the server controls, so if even one instance behind this
 *    agent identity would mishandle the profile, treat the whole agent as
 *    incompatible rather than gamble on routing.
 *  - Every live instance declares it → ok. */
export function evaluateManagerCapability(
  instances: ManagerCapabilitySnapshot[],
  capability: string,
): ManagerCapabilityVerdict {
  if (instances.length === 0) return { ok: true };
  const incompatible = instances.filter(
    (inst) => !Array.isArray(inst.manager_capabilities) || !inst.manager_capabilities.includes(capability),
  );
  if (incompatible.length === 0) return { ok: true };
  const versions = [...new Set(incompatible.map((inst) => inst.plugin_version || 'unknown'))].join(', ');
  return {
    ok: false,
    reason: 'manager_capability_missing',
    detail:
      `연결된 agent-manager(버전 ${versions})가 "${capability}" 기능을 지원하지 않습니다 — ` +
      'agent-manager를 최신 버전으로 업데이트하세요.',
  };
}

/** Convenience wrapper both dispatch call sites use: resolves the required
 *  capability from the profile, then evaluates it against the target agent's
 *  live instance snapshot. `{ ok: true }` whenever the profile requires
 *  nothing an old manager could get wrong. */
export function checkManagerCapabilityForDispatch(
  profile: CliRuntimeProfile | null | undefined,
  instances: ManagerCapabilitySnapshot[],
): ManagerCapabilityVerdict {
  const capability = requiredManagerCapability(profile);
  if (!capability) return { ok: true };
  return evaluateManagerCapability(instances, capability);
}
