import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ApiKeyService } from '../../services/api-key.service';

@Injectable()
export class AgentAuthGuard implements CanActivate {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // Dev mode: skip validation entirely, no account scoping.
    // HARD-gated behind NODE_ENV !== 'production' — a stray AGENT_DEV_MODE flag
    // on a prod deploy must never open every /api/agent/* endpoint
    // unauthenticated (security finding: authz).
    if (
      process.env.NODE_ENV !== 'production' &&
      !process.env.AGENT_API_KEY &&
      process.env.AGENT_DEV_MODE === 'true'
    ) {
      request.currentAccountId = null;
      return true;
    }

    const providedKey = request.headers['x-agent-key'] as string | undefined;
    if (!providedKey) {
      throw new UnauthorizedException('Missing X-Agent-Key header');
    }

    // Try DB key first — provides account_id scoping
    let rejectedDbKey = false;
    try {
      const dbResult = await this.apiKeyService.validateApiKey(providedKey);
      if (dbResult.valid && dbResult.apiKey?.account_id) {
        const apiKey = dbResult.apiKey;
        // Manager and runtime keys have the same account boundary. Validation
        // also checks that a host-bound key matches the active host's owner.
        const runtimeKey = apiKey.host_id ? /^runtime:.*:(rt-[0-9a-f]{16})$/.exec(apiKey.name || '')?.[1] : undefined;
        request.currentAccountId = apiKey.account_id;
        // Also expose the resolved ApiKey row + caller identity so
        // downstream controllers (e.g. fs-browser response receiver) can
        // identify WHICH host/agent is calling without a second lookup.
        request.apiKey = apiKey;
        request.currentAgentId = runtimeKey || apiKey.host_id || null;
        request.currentRuntimeKey = runtimeKey || null;
        request.currentHostId = apiKey.host_id || null;
        return true;
      }
      rejectedDbKey = dbResult.valid || (!!dbResult.reason && dbResult.reason !== 'Key not found');
    } catch {
      // Fall through to ENV key check
    }
    if (rejectedDbKey) throw new UnauthorizedException('API key rejected');

    // Static keys also require an explicit owner; missing ownership never means Global.
    const envKey = process.env.AGENT_API_KEY;
    const envAccountId = process.env.AGENT_ACCOUNT_ID?.trim();
    if (envKey && providedKey === envKey && envAccountId) {
      request.currentAccountId = envAccountId;
      return true;
    }

    throw new UnauthorizedException('Invalid or missing API key');
  }
}
