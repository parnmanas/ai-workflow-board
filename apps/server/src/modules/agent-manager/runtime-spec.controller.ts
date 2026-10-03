import { Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Response } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ApiKey } from '../../entities/ApiKey';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { Credential } from '../../entities/Credential';
import { normalizeRuntimeSpec } from '../../common/runtime-spec';
import { CLI_RUNTIME_NONE } from '../../common/cli-runtime-profiles';
import { globalRuntimeProfiles } from '../../common/claude-backend-registry';

/**
 * RuntimeSpec live validation for the shared editor
 * (`apps/client/src/components/runtime/RuntimeSpecEditor.tsx`).
 *
 * Read-only: normalizes the shape (the same `normalizeRuntimeSpec` P4 inputs
 * will go through) and checks the referential half against the DB — host
 * exists (host-first, legacy manager fallback), credential visible to the
 * workspace, backend profile exists. Returns the normalized spec or a 400
 * with a human-readable reason. Persists nothing.
 *
 * Any logged-in user may call it — a spec is not a secret, and the team /
 * Action / QA editors that embed the editor are not admin-only surfaces.
 */
@Controller('api/runtime-specs')
@UseGuards(AuthGuard)
export class RuntimeSpecController {
  constructor(
    @InjectRepository(RuntimeHost) private readonly hostRepo: Repository<RuntimeHost>,
    @InjectRepository(Credential) private readonly credentialRepo: Repository<Credential>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @Post('validate')
  async validate(@Body() body: any, @Res() res: Response) {
    const workspaceId = typeof body?.workspace_id === 'string' && body.workspace_id.trim()
      ? body.workspace_id.trim()
      : null;
    let spec;
    try {
      spec = normalizeRuntimeSpec(body?.spec, 'spec');
    } catch (e: any) {
      return res.status(400).json({ ok: false, error: e?.message || 'invalid runtime spec' });
    }

    // P4c-4: Host 직접 조회 후 api_keys 페어링 링크 (Agent 행 없음).
    const host = await this.hostRepo.findOne({ where: { id: spec.manager_agent_id } });
    if (!host) {
      const link = await this.dataSource.getRepository(ApiKey).findOne({
        where: [{ agent_id: spec.manager_agent_id }, { host_id: spec.manager_agent_id }],
        select: { agent_id: true, host_id: true },
      });
      const hostId = link?.host_id ?? (link?.agent_id ? spec.manager_agent_id : null);
      const linked = hostId ? await this.hostRepo.findOne({ where: { id: hostId } }) : null;
      if (!linked) {
        return res.status(400).json({ ok: false, error: `Runtime Host ${spec.manager_agent_id} does not exist` });
      }
    }

    if (spec.credential_id) {
      const cred = await this.credentialRepo.findOne({ where: { id: spec.credential_id } });
      if (!cred || (cred.workspace_id !== null && cred.workspace_id !== workspaceId)) {
        return res.status(400).json({ ok: false, error: `credential ${spec.credential_id} is not available to this workspace` });
      }
    }

    if (spec.cli_runtime_profile && spec.cli_runtime_profile !== CLI_RUNTIME_NONE) {
      const profiles = await globalRuntimeProfiles(this.dataSource);
      if (!profiles.some((p) => p.id === spec.cli_runtime_profile)) {
        return res.status(400).json({ ok: false, error: `cli_runtime_profile "${spec.cli_runtime_profile}" does not exist` });
      }
    }

    return res.status(200).json({ ok: true, spec });
  }
}
