import { MigrationInterface, QueryRunner } from 'typeorm';
import { Agent } from '../../entities/Agent';

const EXECUTABLE_RUNTIMES = new Set([
  'claude',
  'deepseek',
  'codex',
  'antigravity',
  'pi',
  'hermes',
]);

/** Data-only migration; synchronize creates the additive schema first. */
export class BackfillAgentRuntimeConfig1760000000067 implements MigrationInterface {
  name = 'BackfillAgentRuntimeConfig1760000000067';

  async up(queryRunner: QueryRunner): Promise<void> {
    const agents = queryRunner.manager.getRepository(Agent);
    const rows = await agents.find();
    const runtimeHostIds = new Set(
      rows
        .filter((agent) => agent.type.trim().toLowerCase() === 'manager')
        .map((agent) => agent.id),
    );

    for (const agent of rows) {
      const runtimeId = agent.type.trim().toLowerCase();

      if (runtimeId === 'manager') {
        agent.workspace_id = null;
        agent.manager_agent_id = null;
        agent.runtime_config = null;
        await agents.save(agent);
        continue;
      }

      const hostIsValid = Boolean(
        agent.manager_agent_id && runtimeHostIds.has(agent.manager_agent_id),
      );
      if (!EXECUTABLE_RUNTIMES.has(runtimeId) || !hostIsValid) {
        const diagnostic = EXECUTABLE_RUNTIMES.has(runtimeId)
          ? 'runtime_host_required'
          : 'runtime_unknown';
        const existingMeta =
          agent.role_prompt_meta
          && typeof agent.role_prompt_meta === 'object'
          && !Array.isArray(agent.role_prompt_meta)
            ? agent.role_prompt_meta
            : {};
        agent.is_active = 0;
        agent.runtime_config = null;
        agent.role_prompt_meta = {
          ...existingMeta,
          runtime_diagnostic: diagnostic,
        };
        await agents.save(agent);
        continue;
      }

      if (!agent.runtime_config) {
        agent.runtime_config = {
          strategy: 'single',
          permission_mode: 'approve',
        };
        await agents.save(agent);
      }
    }
  }

  // This migration intentionally preserves legacy rows and only makes unsafe
  // execution state explicit. Re-enabling detached agents on rollback would
  // silently restore the managerless execution path, so rollback is a no-op.
  async down(): Promise<void> {}
}
