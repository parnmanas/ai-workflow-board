import { ApiSecurity, ApiTags, ApiOperation } from '@nestjs/swagger';
import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Credential } from '../../entities/Credential';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { decryptStrict } from '../../services/encryption.service';
import { normalizeCredentialFields } from '../../common/credential-fields';
import { resolveAgentEnv, type AgentEnvSource } from '../../common/credential-agent-env';
import { LogService } from '../../services/log.service';

/**
 * Loads the exposed credentials an account can read and resolves them into
 * one env map. Undecryptable rows are reported in `skipped`, not dropped
 * silently — the manager logs them next to the spawn.
 */
export async function loadAgentEnvForAccount(credRepo: Pick<Repository<Credential>, 'find'>, accountId: string) {
  const rows = await credRepo.find({
    where: [
      { account_id: accountId, agent_env: true },
      { account_id: IsNull(), agent_env: true },
    ],
  });
  const sources: AgentEnvSource[] = [];
  const unreadable: Array<{ credential_id: string; name: string; reason: string }> = [];
  for (const row of rows) {
    try {
      sources.push({
        id: row.id,
        name: row.name,
        provider: row.provider,
        account_id: row.account_id,
        env_prefix: row.env_prefix || '',
        fields: normalizeCredentialFields(JSON.parse(decryptStrict(row.encrypted_data))),
      });
    } catch {
      unreadable.push({ credential_id: row.id, name: row.name, reason: 'credential could not be decrypted — re-save it in Settings → Credentials' });
    }
  }
  const resolved = resolveAgentEnv(sources);
  return { ...resolved, skipped: [...unreadable, ...resolved.skipped] };
}

// Manager → server: the env vars (and git host credentials) every agent run of
// `account_id` gets from credentials opted in with `agent_env`. Fetched at
// spawn and provisioning time so secrets
// never ride an SSE payload; contract shared with
// apps/agent-manager/src/lib/agent-env-credentials.ts.
//
// Manager and runtime keys can retrieve their own account's credentials and
// explicit Global credentials. A request parameter cannot widen that scope.
@ApiTags('agent-manager')
@Controller()
export class CredentialsAgentEnvController {
  constructor(
    @InjectRepository(Credential) private readonly credRepo: Repository<Credential>,
    private readonly logService: LogService,
  ) {}

  @ApiSecurity('agent-api-key')
  @Get('api/agent-manager/agent-env')
  @UseGuards(AgentAuthGuard)
  @ApiOperation({ summary: 'Manager → server: env vars from credentials exposed to agent runs of an account' })
  async getAgentEnv(
    @Query('account_id') requestedAccountId: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const callerHostId = String((req as any).currentHostId || '').trim();
    if (!callerHostId) return res.status(403).json({ error: 'a Runtime Host API key is required' });
    const requested = String(requestedAccountId || '').trim();
    const keyAccountId = String((req as any).currentAccountId || '').trim();
    if (!keyAccountId || (requested && keyAccountId !== requested)) {
      return res.status(403).json({ error: 'account_id is outside the API key account' });
    }
    const accountId = keyAccountId;

    const result = await loadAgentEnvForAccount(this.credRepo, accountId);
    if (result.skipped.length) {
      this.logService.warn('Credentials', `Agent env for account ${accountId.slice(0, 8)} skipped ${result.skipped.length} entr(ies)`, {
        host_id: callerHostId,
        skipped: result.skipped,
      });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ account_id: accountId, ...result });
  }
}
