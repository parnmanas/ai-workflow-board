import { AntigravityCliAdapter } from '../../cli-adapters/antigravity.js';
import { ClaudeCliAdapter } from '../../cli-adapters/claude.js';
import { CodexCliAdapter } from '../../cli-adapters/codex.js';
import { DeepSeekCliAdapter } from '../../cli-adapters/deepseek.js';
import { PiCliAdapter } from '../../cli-adapters/pi.js';
import { requestCapabilities } from '../domain/capabilities.js';
import { HermesRuntime, type HermesRuntimeOptions } from '../hermes/hermes-runtime.js';
import type { RuntimeCapabilities } from '../runtime-types.js';
import {
  BYPASS_ONLY_PERMISSION_CAPABILITIES,
  NATIVE_APPROVAL_PERMISSION_CAPABILITIES,
  TIER_FLAG_PERMISSION_CAPABILITIES,
} from '../../permission-policy.js';
import { defineRuntimePlugin, type RuntimePluginManifest } from './plugin-manifest.js';
import { RuntimePluginRegistry } from './plugin-registry.js';

// ticket 5851e435 — permission_tiers 는 어댑터의 permissionCapabilities() 와
// **같은 상수**에서 가져온다. 두 곳에 손으로 적어두면 드리프트가 나고, 그 순간
// 운영자가 heartbeat 에서 보는 능력 선언과 실제 spawn 동작이 어긋난다
// (permission-capability-report 회귀 테스트가 일치를 강제한다).
const persistent: RuntimeCapabilities = { protocol: 'stream-json', session: 'persistent', native_mcp: true, native_approvals: false, steering: true, cancellation: true, usage: 'tokens-and-cost', collaboration: [], skill_delivery: ['prompt', 'filesystem'], permission_tiers: TIER_FLAG_PERMISSION_CAPABILITIES.tiers };
const oneshot = (native_mcp: boolean, usage: RuntimeCapabilities['usage'], permission_tiers: RuntimeCapabilities['permission_tiers']): RuntimeCapabilities => ({ protocol: 'jsonl', session: 'oneshot', native_mcp, native_approvals: false, steering: false, cancellation: true, usage, collaboration: [], skill_delivery: native_mcp ? ['prompt', 'filesystem'] : ['prompt'], permission_tiers });

export function createBuiltinRuntimeRegistry(extensions: readonly RuntimePluginManifest[] = []): RuntimePluginRegistry {
  const registry = new RuntimePluginRegistry()
    .register(defineRuntimePlugin({ id: 'claude', transport: 'cli', capabilities: requestCapabilities(persistent, { effort: true }), createCliAdapter: () => new ClaudeCliAdapter() }))
    .register(defineRuntimePlugin({ id: 'deepseek', transport: 'cli', capabilities: requestCapabilities({ ...persistent }), createCliAdapter: () => new DeepSeekCliAdapter() }))
    .register(defineRuntimePlugin({ id: 'codex', transport: 'cli', capabilities: requestCapabilities(oneshot(true, 'tokens', TIER_FLAG_PERMISSION_CAPABILITIES.tiers), { streaming: true }), createCliAdapter: () => new CodexCliAdapter() }))
    .register(defineRuntimePlugin({ id: 'antigravity', transport: 'cli', capabilities: requestCapabilities(oneshot(false, 'none', BYPASS_ONLY_PERMISSION_CAPABILITIES.tiers)), createCliAdapter: () => new AntigravityCliAdapter() }))
    .register(defineRuntimePlugin({ id: 'pi', transport: 'cli', capabilities: requestCapabilities(oneshot(true, 'tokens', BYPASS_ONLY_PERMISSION_CAPABILITIES.tiers)), createCliAdapter: () => new PiCliAdapter() }))
    .register(defineRuntimePlugin<HermesRuntime>({ id: 'hermes', transport: 'acp', capabilities: requestCapabilities({ protocol: 'acp', session: 'resumable', native_mcp: true, native_approvals: true, steering: true, cancellation: true, usage: 'tokens', collaboration: ['delegated', 'swarm'], skill_delivery: ['filesystem', 'native'], permission_tiers: NATIVE_APPROVAL_PERMISSION_CAPABILITIES.tiers }, { sessionId: true, streaming: true }), createOwner: options => new HermesRuntime(options as HermesRuntimeOptions) }));
  for (const extension of extensions) registry.register(extension);
  return registry.seal();
}
