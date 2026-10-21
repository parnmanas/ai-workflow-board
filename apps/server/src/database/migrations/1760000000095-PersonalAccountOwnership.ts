import { MigrationInterface, QueryRunner } from 'typeorm';
import { Account } from '../../entities/Account';
import { User } from '../../entities/User';
import { INSTANCE_CONTEXT_ID } from '../../common/instance-context';
import { ensurePersonalAccount } from '../../common/personal-account';
import { bindParams } from '../action-cron-timezone';

/** Forward-only attribution of migration 94's shared work, with an explicit owner. */
export class PersonalAccountOwnership1760000000095 implements MigrationInterface {
  name = 'PersonalAccountOwnership1760000000095';

  async up(runner: QueryRunner): Promise<void> {
    const accounts = runner.manager.getRepository(Account);
    const users = await runner.manager.getRepository(User).find({ order: { created_at: 'ASC', id: 'ASC' } });
    const legacy = await accounts.findOneBy({ id: INSTANCE_CONTEXT_ID });
    if (legacy?.owner_user_id) {
      // A replay must never adopt work created by another user after attribution.
      for (const user of users) await ensurePersonalAccount(runner.manager, user);
      return;
    }

    const ownerId = process.env.AWB_LEGACY_OWNER_USER_ID?.trim();
    if (!ownerId) {
      const workEntities = ['Ticket', 'Project', 'Credential', 'Resource', 'RuntimeHost', 'ChatRoom', 'OrchestrationTeam'];
      let hasWork = false;
      for (const name of workEntities) {
        if (await runner.manager.getRepository(name).count()) { hasWork = true; break; }
      }
      if (users.length || hasWork) {
        throw new Error('Set AWB_LEGACY_OWNER_USER_ID to the confirmed login user who will own existing work before migrating. Back up the database first.');
      }
      // Empty installations get their first account at signup/setup.
      if (legacy) await accounts.delete(legacy.id);
      return;
    }
    const owner = users.find(user => user.id === ownerId && user.status === 'active');
    if (!owner) throw new Error('AWB_LEGACY_OWNER_USER_ID must identify an existing active login user.');
    if (await accounts.existsBy({ owner_user_id: owner.id, kind: 'personal' })) {
      throw new Error('The legacy owner already has a personal account; resolve attribution before migrating.');
    }
    if (!legacy) throw new Error('Legacy account is missing; refusing to guess which work to adopt.');

    await accounts.update(legacy.id, { kind: 'personal', owner_user_id: owner.id, name: owner.name });

    // Every historical business row belongs to the confirmed owner, including
    // NULL/empty owners and stale manager-uploaded account hints. Builtin
    // definitions are the only historically explicit Global catalog entries.
    // Raw updates preserve business timestamps and opaque credential contents.
    for (const metadata of runner.connection.entityMetadatas) {
      const table = metadata.tablePath.split('.').map(part => runner.connection.driver.escape(part)).join('.');
      for (const key of ['account_id', 'owner_account_id']) {
        if (!metadata.findColumnWithPropertyName(key)) continue;
        const column = runner.connection.driver.escape(key);
        let predicate = '';
        if (metadata.name === 'Skill') predicate = " AND (source_kind <> 'builtin' OR account_id IS NOT NULL)";
        if (metadata.name === 'WorkflowFunction') predicate = ' AND (builtin = false OR account_id IS NOT NULL)';
        if (metadata.name === 'SkillVersion') {
          predicate = " AND skill_id IN (SELECT CAST(id AS varchar) FROM skills WHERE source_kind <> 'builtin' OR account_id IS NOT NULL)";
        }
        await bindParams(runner, `UPDATE ${table} SET ${column} = ? WHERE (${column} IS NULL OR ${column} <> ?)${predicate}`, [legacy.id, legacy.id]);
      }
    }
    // PostgreSQL stores the independent ontology datasource in the same DB.
    for (const table of ['ontology_graphs', 'ontology_nodes', 'ontology_edges']) {
      if (await runner.hasTable(table)) await bindParams(runner, `UPDATE ${table} SET account_id = ? WHERE account_id IS NULL OR account_id <> ?`, [legacy.id, legacy.id]);
    }
    const settings = runner.manager.getRepository('SystemSetting');
    for (const key of ['operator.sessions', 'operator.session']) {
      const row = await settings.findOneBy({ key });
      if (!row) continue;
      const value = JSON.parse(row.value);
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (entry && typeof entry === 'object') entry.account_id = legacy.id;
      }
      await settings.update({ key }, { value: JSON.stringify(value) });
    }
    for (const user of users) await ensurePersonalAccount(runner.manager, user);
  }

  async down(): Promise<void> {
    throw new Error('Restore the database backup to undo personal account attribution.');
  }
}
