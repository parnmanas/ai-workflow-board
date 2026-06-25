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
        // Inject workspace_id from the API key record for workspace-scoped queries
        request.currentWorkspaceId = dbResult.apiKey.workspace_id || null;
        // Also expose the resolved ApiKey row + agent id so downstream
        // controllers (e.g. fs-browser response receiver) can identify
        // WHICH agent is calling without a second lookup.
        request.apiKey = dbResult.apiKey;
        request.currentAgentId = dbResult.apiKey.agent_id || null;
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
