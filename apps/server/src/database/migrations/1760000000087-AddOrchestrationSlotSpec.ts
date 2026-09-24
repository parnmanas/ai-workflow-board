import { MigrationInterface, QueryRunner } from 'typeorm';
import { Agent } from '../../entities/Agent';
import { OrchestrationTeam } from '../../entities/OrchestrationTeam';
import { OrchestrationTeamMember } from '../../entities/OrchestrationTeamMember';

/**
 * Spec-declared Orchestration rosters: a team slot is now Runtime Host + CLI +
 * model + working folder instead of a pointer at a pre-existing Agent.
 *
 * Three columns:
 *   - orchestration_team_members.spec   — the slot's runtime spec (TeamAgentSpec JSON)
 *   - orchestration_teams.orchestrator_spec — same shape, for the orchestrator slot
 *   - agents.origin                     — '' for operator-authored rows,
 *     'orchestration' for identities AWB provisions from a slot spec. Drives both
 *     lifecycle ownership (only 'orchestration' rows are edited/deleted with their
 *     slot) and the default filtering of `GET /api/agents`.
 *
 * SQLite(개발)는 엔티티 synchronize=true 로 이 컬럼들을 얻는다. 이 DDL은
 * synchronize가 꺼져 있는 Postgres(운영)에서만 돈다. 전부 `ADD COLUMN IF NOT
 * EXISTS` 라 이미 적용된 DB에 재실행해도 no-op이다.
 *
 * ── Backfill ──────────────────────────────────────────────────────────────
 *
 * Existing rosters are migrated rather than abandoned: each slot's spec is
 * derived from the Agent it already points at (that agent's manager / cli /
 * model / working_dir / credential / runtime profile), so every existing team
 * keeps running and becomes editable in the new UI with its real settings
 * pre-filled. Nothing has to be rebuilt by hand.
 *
 * Two deliberate choices in the back-filled value:
 *
 *   - `folder_scope` is **'isolated'**, not the new default 'shared'. An existing
 *     mission's steps run in per-step `.awb/orch/` folders today; back-filling
 *     'shared' would silently move a live team into one shared working tree —
 *     a behaviour change nobody asked for, on data we are only supposed to be
 *     describing. Operators opt into sharing per slot.
 *   - `agents.origin` stays '' for these back-filled identities. They were
 *     authored by an operator and may be used elsewhere (tickets, chat, another
 *     team), so the roster must not gain the right to mutate or delete them. The
 *     provisioner honours that: editing such a slot's spec mints a NEW
 *     team-owned identity instead of rewriting the operator's agent.
 *
 * Rows whose agent has no `manager_agent_id` (non-executable / historical
 * identities) are skipped — there is no host to name, so no valid spec exists.
 * They keep dispatching exactly as before; `parseTeamAgentSpec` reads their null
 * spec as "no spec" and the dispatcher falls back to isolated folders.
 *
 * down()은 이 저장소의 컬럼 추가 마이그레이션 관례대로 no-op이다. 되돌리면서
 * 컬럼을 DROP하면 그 사이 저장된 로스터 설정이 통째로 사라진다.
 */
export class AddOrchestrationSlotSpec1760000000087 implements MigrationInterface {
  name = 'AddOrchestrationSlotSpec1760000000087';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';

    if (isPostgres) {
      await queryRunner.query('ALTER TABLE orchestration_team_members ADD COLUMN IF NOT EXISTS spec TEXT');
      await queryRunner.query('ALTER TABLE orchestration_teams ADD COLUMN IF NOT EXISTS orchestrator_spec TEXT');
      await queryRunner.query("ALTER TABLE agents ADD COLUMN IF NOT EXISTS origin VARCHAR NOT NULL DEFAULT ''");
    }

    // The backfill runs on BOTH backends: SQLite gets the columns from
    // synchronize, but nothing fills them, and a dev database with existing
    // teams would otherwise show every member as "legacy, re-save to edit".
    // Guarded so a database that predates the orchestration tables entirely
    // (or a fresh one) is a clean no-op.
    if (!(await this.hasTable(queryRunner, 'orchestration_team_members'))) return;

    await this.backfillMembers(queryRunner);
    await this.backfillOrchestrators(queryRunner);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}

  private async hasTable(queryRunner: QueryRunner, table: string): Promise<boolean> {
    try {
      return await queryRunner.hasTable(table);
    } catch {
      return false;
    }
  }

  /**
   * Repository API rather than raw SQL for the backfill: `?` vs `$1` parameter
   * syntax differs between the sql.js and Postgres drivers, and the `spec`
   * columns are TypeORM `simple-json`, so letting the entity metadata do the
   * serialization keeps one code path for both backends.
   */
  private async backfillMembers(queryRunner: QueryRunner): Promise<void> {
    const memberRepo = queryRunner.manager.getRepository(OrchestrationTeamMember);
    const agentRepo = queryRunner.manager.getRepository(Agent);
    const pending = (await memberRepo.find()).filter((m) => !m.spec);
    if (pending.length === 0) return;

    const agents = await agentRepo.find();
    const byId = new Map(agents.map((a) => [a.id, a]));
    for (const member of pending) {
      const spec = buildSpec(byId.get(member.agent_id));
      if (!spec) continue;
      member.spec = spec;
      await memberRepo.save(member);
    }
  }

  private async backfillOrchestrators(queryRunner: QueryRunner): Promise<void> {
    const teamRepo = queryRunner.manager.getRepository(OrchestrationTeam);
    const agentRepo = queryRunner.manager.getRepository(Agent);
    const pending = (await teamRepo.find()).filter((t) => !t.orchestrator_spec && t.orchestrator_agent_id);
    if (pending.length === 0) return;

    const agents = await agentRepo.find();
    const byId = new Map(agents.map((a) => [a.id, a]));
    for (const team of pending) {
      const spec = buildSpec(byId.get(team.orchestrator_agent_id!));
      if (!spec) continue;
      team.orchestrator_spec = spec;
      await teamRepo.save(team);
    }
  }
}

/**
 * Derive a slot spec from the backing agent's columns, or null when the agent
 * cannot describe one (missing, no Runtime Host, or no working folder — each
 * means there is nothing truthful to write, and a spec is only useful if it is
 * accurate).
 */
function buildSpec(agent: Agent | undefined): Record<string, any> | null {
  if (!agent) return null;
  const managerAgentId = str(agent.manager_agent_id);
  const cli = str(agent.type).toLowerCase();
  const workingDir = str(agent.working_dir);
  if (!managerAgentId || !cli || cli === 'manager' || !workingDir) return null;
  return {
    manager_agent_id: managerAgentId,
    cli,
    model: str(agent.model) || null,
    working_dir: workingDir,
    // See the class doc: preserve today's per-step isolation for existing teams.
    folder_scope: 'isolated',
    credential_id: str(agent.credential_id) || null,
    cli_runtime_profile: str(agent.cli_runtime_profile) || null,
    runtime_config: agent.runtime_config ?? null,
  };
}

function str(value: unknown): string {
  return value == null ? '' : String(value).trim();
}
