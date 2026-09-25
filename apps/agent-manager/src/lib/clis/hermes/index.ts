// Hermes — ACP 프로토콜 런타임. CLI 어댑터가 아니라 장기 프로세스 소유자(`HermesRuntime`)
// 로 돈다. 바이너리 해석·프로필 열거는 `runtime/hermes/hermes-command.ts` 가 맡는다.
//
// credential / effort / login 슬라이스가 없다: Hermes 는 자체 프로필로 인증하고,
// effort preset 을 표현하지 않으며, device-auth 로그인 자동화 대상이 아니다.

import { homedir } from 'node:os';

import { NATIVE_APPROVAL_PERMISSION_CAPABILITIES } from '../../permission-policy.js';
import { requestCapabilities } from '../../runtime/domain/capabilities.js';
import { listHermesProfiles, resolveHermesAcpCommand } from '../../runtime/hermes/hermes-command.js';
import { HermesRuntime, type HermesRuntimeOptions } from '../../runtime/hermes/hermes-runtime.js';
import { defineCliModule } from '../cli-module.js';

export const hermesModule = defineCliModule({
  id: 'hermes',
  label: 'Hermes ACP',
  transport: 'acp',
  capabilities: requestCapabilities(
    {
      protocol: 'acp',
      session: 'resumable',
      native_mcp: true,
      native_approvals: true,
      steering: true,
      cancellation: true,
      usage: 'tokens',
      collaboration: ['delegated', 'swarm'],
      skill_delivery: ['filesystem', 'native'],
      permission_tiers: NATIVE_APPROVAL_PERMISSION_CAPABILITIES.tiers,
    },
    { sessionId: true, streaming: true },
  ),
  createOwner: (options) => new HermesRuntime(options as HermesRuntimeOptions),
  listProfiles: () => listHermesProfiles(),

  sessions: {
    async detect(env, findOnPath) {
      return !!env.HERMES_ACP_COMMAND || !!(await findOnPath('hermes-acp')) || !!(await findOnPath('hermes'));
    },
    async resolveAcpCommand() {
      const resolved = await resolveHermesAcpCommand();
      return { command: resolved.command, args: [...resolved.argsPrefix] };
    },
    // Hermes 는 자체 저장소 포맷을 모르므로 AWB 화면에서 만든 세션만 로컬 인덱스로 기억한다
    // — `store` 없음, `storeSubdir` 없음.
    operatorHome: () => homedir(),
  },
});
