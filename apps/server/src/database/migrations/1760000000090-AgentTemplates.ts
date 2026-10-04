import { MigrationInterface, QueryRunner, Table, TableColumn } from 'typeorm';
import { bindParams } from '../action-cron-timezone';

/** Remove retired Agent ownership; templates contain preferences only, never a cwd. */
export class AgentTemplates1760000000090 implements MigrationInterface {
  name = 'AgentTemplates1760000000090';

  async up(runner: QueryRunner): Promise<void> {
    const postgres = runner.connection.options.type === 'postgres';
    const timestamp = postgres ? 'timestamp' : 'datetime';
    if (!await runner.hasTable('runtime_hosts')) {
      await runner.createTable(new Table({ name: 'runtime_hosts', columns: [
        { name: 'id', type: postgres ? 'uuid' : 'varchar', isPrimary: true },
        { name: 'name', type: 'varchar' },
        { name: 'hostname', type: 'varchar', default: "''" },
        { name: 'workspace_id', type: 'varchar', isNullable: true },
        { name: 'is_active', type: 'integer', default: '1' },
        { name: 'last_seen_at', type: timestamp, isNullable: true },
        { name: 'created_at', type: timestamp, default: 'CURRENT_TIMESTAMP' },
        { name: 'updated_at', type: timestamp, default: 'CURRENT_TIMESTAMP' },
      ] }));
    }
    if (await runner.hasTable('api_keys') && !await runner.hasColumn('api_keys', 'host_id')) {
      await runner.addColumn('api_keys', new TableColumn({ name: 'host_id', type: 'varchar', isNullable: true }));
    }
    // Upgrade pre-Host installations before deleting the sole pairing link.
    if (await runner.hasTable('agents')) {
      const managers = await runner.query("SELECT id, name, workspace_id FROM agents WHERE type = 'manager'");
      for (const manager of managers) {
        const hosts = await bindParams(runner, 'SELECT id FROM runtime_hosts WHERE id = ?', [manager.id]);
        if (!hosts.length) await bindParams(runner, 'INSERT INTO runtime_hosts (id, name, workspace_id) VALUES (?, ?, ?)', [manager.id, manager.name, manager.workspace_id]);
        if (await runner.hasColumn('api_keys', 'agent_id')) {
          await bindParams(runner, 'UPDATE api_keys SET host_id = ? WHERE agent_id = ? AND host_id IS NULL', [manager.id, manager.id]);
        }
      }
    }
    if (await runner.hasColumn('api_keys', 'agent_id')) {
      // Old manager UUIDs are translated once, then no lookup aliases remain.
      const links = await runner.query('SELECT agent_id, host_id FROM api_keys WHERE agent_id IS NOT NULL AND host_id IS NOT NULL');
      const aliases = new Map<string, string>(links.map((row: any) => [row.agent_id, row.host_id]));
      const rewrite = (value: any): any => {
        if (Array.isArray(value)) return value.map(rewrite);
        if (!value || typeof value !== 'object') return value;
        const result = { ...value };
        for (const key of Object.keys(result)) {
          if (key === 'manager_agent_id' && aliases.has(result[key])) result[key] = aliases.get(result[key]);
          else result[key] = rewrite(result[key]);
        }
        return result;
      };
      for (const [table, column] of [
        ['ticket_role_assignments', 'runtime_spec'], ['chat_room_participants', 'runtime_spec'],
        ['orchestration_teams', 'orchestrator_spec'], ['orchestration_team_members', 'spec'],
        ['orchestration_missions', 'orchestrator_spec'], ['orchestration_steps', 'assignee_spec'],
        ['actions', 'target_runtimes'], ['qa_scenarios', 'target_runtime'], ['security_profiles', 'target_runtime'],
        ['workspace_schedules', 'target_runtime'], ['features', 'planner_runtime'], ['boards', 'default_role_assignments'],
      ]) {
        if (!await runner.hasTable(table) || !await runner.hasColumn(table, column)) continue;
        for (const row of await runner.query(`SELECT id, "${column}" AS value FROM "${table}" WHERE "${column}" IS NOT NULL`)) {
          const parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
          const next = rewrite(parsed);
          if (JSON.stringify(parsed) !== JSON.stringify(next)) await bindParams(runner, `UPDATE "${table}" SET "${column}" = ? WHERE id = ?`, [JSON.stringify(next), row.id]);
        }
      }
      for (const table of ['agent_session_cli_settings', 'cli_login_sessions']) {
        const column = table === 'agent_session_cli_settings' ? 'manager_id' : 'manager_agent_id';
        if (!await runner.hasTable(table) || !await runner.hasColumn(table, column)) continue;
        for (const [previous, next] of aliases) {
          if (previous !== next) await bindParams(runner, `UPDATE "${table}" SET "${column}" = ? WHERE "${column}" = ?`, [next, previous]);
        }
      }
    }
    for (const [table, column] of [
      ['api_keys', 'agent_id'], ['workspaces', 'assistant_agent_id'],
      ['actions', 'target_agent_id'], ['actions', 'target_agent_ids'],
      ['qa_scenarios', 'target_agent_id'], ['security_profiles', 'target_agent_id'],
      ['workspace_schedules', 'target_agent_id'], ['features', 'planner_agent_id'],
      ['outreach_channels', 'classifier_agent_id'],
    ]) {
      const metadata = await runner.getTable(table);
      if (!metadata?.findColumnByName(column)) continue;
      for (const fk of metadata.foreignKeys.filter((fk) => fk.columnNames.includes(column))) await runner.dropForeignKey(table, fk);
      for (const index of metadata.indices.filter((index) => index.columnNames.includes(column))) await runner.dropIndex(table, index);
      await runner.dropColumn(table, column);
    }
    if (await runner.hasTable('agents')) await runner.dropTable('agents', true, true, true);
    if (await runner.hasTable('outreach_channels') && !await runner.hasColumn('outreach_channels', 'classifier_runtime')) {
      await runner.addColumn('outreach_channels', new TableColumn({ name: 'classifier_runtime', type: 'text', isNullable: true }));
    }
    if (!await runner.hasTable('runtime_skill_assignments')) {
      await runner.createTable(new Table({ name: 'runtime_skill_assignments', columns: [
        { name: 'id', type: postgres ? 'uuid' : 'varchar', isPrimary: true, isGenerated: true, generationStrategy: 'uuid' },
        { name: 'workspace_id', type: 'varchar' }, { name: 'runtime_key', type: 'varchar' },
        { name: 'skill_id', type: 'varchar' }, { name: 'skill_version_id', type: 'varchar' },
        { name: 'board_id', type: 'varchar', default: "''" }, { name: 'role_slug', type: 'varchar', default: "''" },
        { name: 'assigned_by', type: 'varchar', default: "''" },
        { name: 'created_at', type: timestamp, default: 'CURRENT_TIMESTAMP' },
      ], indices: [{ name: 'idx_runtime_skill_scope', columnNames: ['workspace_id', 'runtime_key', 'skill_id', 'board_id', 'role_slug'], isUnique: true }] }));
    }
    if (await runner.hasTable('agent_skill_assignments')) {
      for (const row of await runner.query('SELECT * FROM agent_skill_assignments')) {
        if (!/^rt-[0-9a-f]{16}$/.test(row.agent_id)) continue;
        const exists = await bindParams(runner, 'SELECT id FROM runtime_skill_assignments WHERE id = ?', [row.id]);
        if (!exists.length) await bindParams(runner,
          'INSERT INTO runtime_skill_assignments (id, workspace_id, runtime_key, skill_id, skill_version_id, board_id, role_slug, assigned_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [row.id, row.workspace_id, row.agent_id, row.skill_id, row.skill_version_id, row.board_id, row.role_slug, row.assigned_by, row.created_at]);
      }
      await runner.dropTable('agent_skill_assignments');
    }

    if (!await runner.hasTable('agent_templates')) {
      await runner.createTable(new Table({ name: 'agent_templates', columns: [
        { name: 'id', type: postgres ? 'uuid' : 'varchar', isPrimary: true, isGenerated: true, generationStrategy: 'uuid' },
        { name: 'name', type: 'varchar' }, { name: 'host_id', type: 'varchar' }, { name: 'cli', type: 'varchar' },
        { name: 'model', type: 'varchar', isNullable: true }, { name: 'effort', type: 'varchar', isNullable: true },
        { name: 'runtime_config', type: 'text' },
        { name: 'created_at', type: timestamp, default: 'CURRENT_TIMESTAMP' },
        { name: 'updated_at', type: timestamp, default: 'CURRENT_TIMESTAMP' },
      ] }));
    }
  }

  async down(): Promise<void> {
    throw new Error('Retired Agent data cannot be reconstructed; restore the database backup to roll back');
  }
}
