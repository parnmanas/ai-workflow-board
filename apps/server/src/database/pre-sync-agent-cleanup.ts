import { DataSource, DataSourceOptions } from 'typeorm';
import { AgentTemplates1760000000090 } from './migrations/1760000000090-AgentTemplates';

/** Preserve old Host bindings before synchronize can drop ApiKey.agent_id. */
export async function preSyncAgentCleanup(options: DataSourceOptions): Promise<void> {
  const source = new DataSource({ ...options, entities: [], subscribers: [], migrations: [], synchronize: false, migrationsRun: false });
  await source.initialize();
  try {
    const runner = source.createQueryRunner();
    try {
      if (!await runner.hasTable('agents') && !await runner.hasColumn('api_keys', 'agent_id') && !await runner.hasColumn('accounts', 'assistant_agent_id')
        && !await runner.hasTable('agent_skill_assignments')
        && !await runner.hasColumn('outreach_channels', 'classifier_agent_id')) return;
      await runner.startTransaction();
      try {
        await new AgentTemplates1760000000090().up(runner);
        await runner.commitTransaction();
      } catch (error) { await runner.rollbackTransaction(); throw error; }
      if (source.options.type === 'sqljs') await source.sqljsManager.saveDatabase();
    } finally { await runner.release(); }
  } finally { await source.destroy(); }
}
