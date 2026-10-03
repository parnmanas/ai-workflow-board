import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ApiKeyService } from '../../services/api-key.service';

@Injectable()
export class AgentAuthGuard implements CanActivate {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // Dev mode: skip validation entirely, no workspace scoping.
    // HARD-gated behind NODE_ENV !== 'production' — a stray AGENT_DEV_MODE flag
    // on a prod deploy must never open every /api/agent/* endpoint
    // unauthenticated (security finding: authz).
    if (
      process.env.NODE_ENV !== 'production' &&
      !process.env.AGENT_API_KEY &&
      process.env.AGENT_DEV_MODE === 'true'
    ) {
      request.currentWorkspaceId = null;
      return true;
    }

    const providedKey = request.headers['x-agent-key'] as string | undefined;
    if (!providedKey) {
      throw new UnauthorizedException('Missing X-Agent-Key header');
    }

    // Try DB key first — provides workspace_id scoping
    try {
      const dbResult = await this.apiKeyService.validateApiKey(providedKey);
      if (dbResult.valid && dbResult.apiKey) {
        const apiKey = dbResult.apiKey;
        // Manager identities are instance-wide by design: their Agent row is
        // workspace_id=null and they supervise managed children that may live
        // in ANY workspace, fetching those children's tickets / chat history
        // over the /api/agent/* REST surface. The pairing redeem, however,
        // mints the manager's key scoped to the pairing workspace (see
        // agent-manager.controller pair/redeem), so without this carve-out
        // AgentApiController.scopeRejects 403s every cross-workspace fetch —
        // symptom: daemon logs "Ticket fetch failed: 403" / "Chat room history
        // fetch failed: 403" / "chat fallback POST failed: 403" for any board
        // outside the manager's pairing workspace. Treat a manager-owned key as
        // full-scope to honour the documented "workspace-less manager keys that
        // legitimately operate across the instance" invariant the IDOR fix
        // (AgentApiController scope guards) already assumes.
        // P0: host 바인딩 키(host_id stamped)도 manager 키와 동등하게
        // full-scope. redeem이 양쪽을 함께 찍어주므로(dual-write) 둘 중
        // 하나만 있어도 통과 — P4에서 agent 바인딩이 제거되면 host_id만 남는다.
        // P4c-4: manager 판정은 host 바인딩만 본다 (Agent 테이블 없음).
        const isManagerKey = !!apiKey.host_id;
        // Inject workspace_id from the API key record for workspace-scoped queries
        request.currentWorkspaceId = isManagerKey ? null : apiKey.workspace_id || null;
        // Also expose the resolved ApiKey row + caller identity so
        // downstream controllers (e.g. fs-browser response receiver) can
        // identify WHICH host/agent is calling without a second lookup.
        // P4 (manager identity → RuntimeHost): caller identity falls back
        // to the host binding when the key has no agent binding (redeem이
        // 더 이상 manager Agent 행을 만들지 않는 과도기/미래 상태).
        // agent 바인딩이 있으면 값이 전과 완전히 동일하므로 기존 동작 불변.
        request.apiKey = apiKey;
        request.currentAgentId = apiKey.agent_id || apiKey.host_id || null;
        request.currentHostId = apiKey.host_id || null;
        return true;
      }
    } catch {
      // Fall through to ENV key check
    }

    // Fall back to static ENV key — no workspace scoping (dev/legacy usage)
    const envKey = process.env.AGENT_API_KEY;
    if (envKey && providedKey === envKey) {
      request.currentWorkspaceId = null;
      return true;
    }

    throw new UnauthorizedException('Invalid or missing API key');
  }
}
