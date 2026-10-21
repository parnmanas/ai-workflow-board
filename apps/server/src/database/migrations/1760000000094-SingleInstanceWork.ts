import { MigrationInterface, QueryRunner } from 'typeorm';
import { Account } from '../../entities/Account';
import { INSTANCE_CONTEXT_ID } from '../../common/instance-context';
import { bindParams } from '../action-cron-timezone';

/** Remove the former work partitions without deleting the work they contained. */
export class SingleInstanceWork1760000000094 implements MigrationInterface {
  name = 'SingleInstanceWork1760000000094';

  async up(runner: QueryRunner): Promise<void> {
    const defaults = runner.manager.getRepository(Account);
    const previous = await defaults.find({ order: { created_at: 'ASC', id: 'ASC' } });
    const memory = [...new Set(previous.map(row => row.knowledge_memory).filter(Boolean))].join('\n\n---\n\n');
    if (!await defaults.findOneBy({ id: INSTANCE_CONTEXT_ID })) {
      await defaults.save(defaults.create({ id: INSTANCE_CONTEXT_ID, name: 'Instance defaults', description: '', knowledge_memory: memory }));
    }

    // These are per-partition CLI defaults, not sessions or credential contents.
    // Existing native sessions keep their pinned execution settings.
    await runner.manager.getRepository('AgentSessionCliSetting').clear();

    // Usage summaries lose a grouping dimension. Sum it, never discard usage.
    const usageRepo = runner.manager.getRepository('AgentUsageDailyRollup');
    const usage = await usageRepo.find({ order: { created_at: 'ASC', id: 'ASC' } });
    const groups = new Map<string, any[]>();
    for (const row of usage) {
      const key = JSON.stringify([row.usage_date, row.agent_id]);
      groups.set(key, [...(groups.get(key) || []), row]);
    }
    for (const rows of groups.values()) {
      if (rows.length < 2) continue;
      const [first, ...rest] = rows;
      for (const field of ['runs_total', 'runs_with_usage', 'priced_runs', 'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'total_cost_usd']) {
        first[field] = rows.reduce((sum, row) => sum + Number(row[field]), 0);
      }
      first.updated_at = new Date(Math.max(...rows.map(row => new Date(row.updated_at).getTime())));
      await usageRepo.delete(rest.map(row => row.id));
      await usageRepo.save(first);
    }

    // Let uniqueness constraints reject ambiguous catalog merges atomically.
    // No ticket, project, credential, attachment or native-session ID changes.
    for (const metadata of runner.connection.entityMetadatas) {
      const table = metadata.tablePath.split('.').map(part => runner.connection.driver.escape(part)).join('.');
      for (const key of ['account_id', 'owner_account_id']) {
        if (!metadata.findColumnWithPropertyName(key)) continue;
        const column = runner.connection.driver.escape(key);
        const predicate = metadata.name === 'OrchestrationTeam' ? '' : ` WHERE ${column} IS NOT NULL`;
        await bindParams(runner, `UPDATE ${table} SET ${column} = ?${predicate}`, [INSTANCE_CONTEXT_ID]);
      }
      if (metadata.findColumnWithPropertyName('allowed_account_ids')) {
        await runner.query(`UPDATE ${table} SET allowed_account_ids = NULL`);
      }
      if (metadata.findColumnWithPropertyName('requested_account_id')) {
        await runner.query(`UPDATE ${table} SET requested_account_id = NULL`);
      }
    }
    // Operator registrations are structured session references, not transcripts.
    const settings = runner.manager.getRepository('SystemSetting');
    for (const key of ['operator.sessions', 'operator.session']) {
      const setting = await settings.findOneBy({ key });
      if (!setting) continue;
      const value = JSON.parse(setting.value);
      const entries = Array.isArray(value) ? value : [value];
      for (const entry of entries) {
        if (entry && typeof entry === 'object' && entry.account_id) entry.account_id = INSTANCE_CONTEXT_ID;
      }
      await settings.update({ key }, { value: JSON.stringify(value) });
    }
    await settings.delete({ key: 'self_improvement.remote_awb_workspace_id' });
    await defaults.createQueryBuilder().delete().where('id != :id', { id: INSTANCE_CONTEXT_ID }).execute();
    await runner.query('DROP TABLE IF EXISTS relation_tuples');
  }

  async down(): Promise<void> {
    throw new Error('Restore the database backup to recover removed ownership partitions.');
  }
}
