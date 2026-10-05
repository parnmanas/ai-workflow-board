import { DataSource, DataSourceOptions, QueryRunner } from 'typeorm';
import { bindParams } from './action-cron-timezone';

const TABLE_RENAMES = new Map([
  ['workspaces', 'accounts'],
  ['workspace_schedules', 'automation_schedules'],
]);

// These are AWB configuration documents, not user-authored messages, source
// files or encrypted credentials. Only ownership keys and scope discriminators
// change; account ids, native session ids and working-folder options do not.
const JSON_COLUMNS: Record<string, string[]> = {
  system_settings: ['value'],
  accounts: ['harness_config', 'environment_config', 'hard_budget_config', 'clone_policy', 'cli_runtime_profiles'],
  boards: ['environment_config', 'default_role_assignments'],
  agents: ['runtime_config', 'role_prompt_meta'],
  agent_templates: ['runtime_config'],
  tickets: ['assignee', 'ci_wait_context'],
  projects: ['default_assignee', 'clone_policy'],
  ticket_role_assignments: ['runtime_spec'],
  chat_room_participants: ['runtime_spec'],
  automation_schedules: ['target_runtime'],
  actions: ['target_runtimes', 'repo_ref'],
  action_runs: ['runtime_spec', 'runtime_metadata'],
  qa_scenarios: ['target_runtime', 'repo_ref', 'on_failure_ticket', 'steps', 'qa_driver_config'],
  security_profiles: ['target_runtime', 'repo_ref', 'on_failure_ticket'],
  orchestration_teams: ['orchestrator_spec'],
  orchestration_team_members: ['spec'],
  orchestration_missions: ['orchestrator_spec', 'repo_ref', 'post_actions', 'graph_spec'],
  orchestration_steps: ['assignee_spec'],
  orchestration_events: ['payload'],
  child_runs: ['runtime_metadata'],
  features: ['planner_runtime'],
};

interface OwnershipTable {
  name: string;
  columns: string[];
}

function ownerName(name: string): string {
  return name.replace(/workspace_id/g, 'account_id').replace(/workspaceId/g, 'accountId').replace(/WorkspaceId/g, 'AccountId');
}

function jsonOwnerKey(key: string): string {
  if (key === 'workspace') return 'account';
  if (key === 'workspaces') return 'accounts';
  return ownerName(key);
}

function rewriteOwnership(value: any, location: string): any {
  if (Array.isArray(value)) return value.map((item) => rewriteOwnership(item, location));
  if (!value || typeof value !== 'object') return value;
  const next: Record<string, any> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    const nextKey = jsonOwnerKey(key);
    if (nextKey !== key && Object.prototype.hasOwnProperty.call(value, nextKey)) {
      throw new Error(`Account ownership migration: ambiguous JSON keys ${key}/${nextKey} in ${location}; restore or reconcile the backup before retrying`);
    }
    next[nextKey] = item === 'workspace' && ['scope', 'entity_type', 'object_type', 'subject_type'].includes(key)
      ? 'account' : rewriteOwnership(item, location);
  }
  return next;
}

function quote(runner: QueryRunner, identifier: string): string {
  const delimiter = ['mysql', 'mariadb'].includes(runner.connection.options.type) ? '`' : '"';
  return `${delimiter}${identifier.replaceAll(delimiter, delimiter + delimiter)}${delimiter}`;
}

function tableSql(runner: QueryRunner, schema: string | undefined, name: string): string {
  return schema ? `${quote(runner, schema)}.${quote(runner, name)}` : quote(runner, name);
}

async function ownershipTables(runner: QueryRunner): Promise<{ schema?: string; tables: OwnershipTable[] }> {
  const type = runner.connection.options.type;
  if (type === 'postgres' || type === 'mysql' || type === 'mariadb') {
    const schema = type === 'postgres'
      ? (runner.connection.options as any).schema || (await runner.query('SELECT current_schema() AS name'))[0]?.name
      : (runner.connection.options as any).database;
    if (!schema) throw new Error('Account ownership migration: no database schema is selected');
    const rows = await bindParams(runner,
      'SELECT c.table_name, c.column_name FROM information_schema.columns c ' +
      'JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name ' +
      "WHERE c.table_schema = ? AND t.table_type = 'BASE TABLE' ORDER BY c.table_name, c.ordinal_position", [schema]);
    const byName = new Map<string, OwnershipTable>();
    for (const row of rows) {
      const table: OwnershipTable = byName.get(row.table_name) || { name: row.table_name, columns: [] };
      table.columns.push(row.column_name);
      byName.set(row.table_name, table);
    }
    return { schema, tables: [...byName.values()] };
  }
  if (!['sqljs', 'sqlite', 'better-sqlite3'].includes(type)) {
    throw new Error(`Account ownership migration: unsupported database backend ${type}`);
  }
  const rows = await runner.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const tables: OwnershipTable[] = [];
  for (const row of rows) {
    const columns = await runner.query(`PRAGMA table_info(${quote(runner, row.name)})`);
    tables.push({ name: row.name, columns: columns.map((column: any) => column.name) });
  }
  return { tables };
}

/**
 * Rename before synchronize can DROP the sole copies of owner ids. Used by both
 * boot entry points (including the independent ontology sql.js file) and by
 * migration 0092. Inspect every table, including retired boards and pre-sync
 * snapshots: 0090/0091 still need those rows when upgrading an older instance.
 * SQLite/Postgres DDL and data rewrites commit together; conflicts abort without
 * choosing which owner or secret binding to keep. Repeated calls are a no-op.
 */
export async function migrateAccountOwnership(runner: QueryRunner): Promise<boolean> {
  const { schema, tables } = await ownershipTables(runner);
  const byName = new Map(tables.map((table) => [table.name, table]));
  let needsSchemaChange = false;
  for (const [previous, next] of TABLE_RENAMES) {
    if (!byName.has(previous)) continue;
    if (byName.has(next)) throw new Error(`Account ownership migration: both ${previous} and ${next} exist; refusing to merge or discard ownership data`);
    needsSchemaChange = true;
  }
  for (const table of tables) {
    for (const column of table.columns) {
      const next = ownerName(column);
      if (next === column) continue;
      if (table.columns.includes(next)) throw new Error(`Account ownership migration: ${table.name} has both ${column} and ${next}; refusing to discard either column`);
      needsSchemaChange = true;
    }
  }
  // MySQL implicitly commits DDL. Reject legacy upgrades rather than advertise
  // rollback safety which that engine cannot provide. Already-upgraded schemas
  // have no DDL and can still run the idempotent data cleanup.
  if (needsSchemaChange && ['mysql', 'mariadb'].includes(runner.connection.options.type)) {
    throw new Error('Account ownership migration requires transactional DDL (SQLite/Postgres); MySQL legacy upgrades need a separately backed-up schema migration before boot');
  }

  await runner.startTransaction();
  let changed = false;
  try {
    for (const table of tables) {
      const nextTable = TABLE_RENAMES.get(table.name) || table.name;
      if (nextTable !== table.name) {
        await runner.query(`ALTER TABLE ${tableSql(runner, schema, table.name)} RENAME TO ${quote(runner, nextTable)}`);
        table.name = nextTable;
        changed = true;
      }
      for (let i = 0; i < table.columns.length; i++) {
        const previous = table.columns[i];
        const next = ownerName(previous);
        if (next === previous) continue;
        await runner.query(`ALTER TABLE ${tableSql(runner, schema, table.name)} RENAME COLUMN ${quote(runner, previous)} TO ${quote(runner, next)}`);
        table.columns[i] = next;
        changed = true;
      }
    }

    const relationTable = tables.find((table) => table.name === 'relation_tuples');
    if (relationTable) {
      for (const column of ['subject_type', 'object_type']) {
        if (!relationTable.columns.includes(column)) continue;
        const rows = await bindParams(runner, `SELECT ${quote(runner, column)} FROM ${tableSql(runner, schema, relationTable.name)} WHERE ${quote(runner, column)} = ?`, ['workspace']);
        if (!rows.length) continue;
        await bindParams(runner, `UPDATE ${tableSql(runner, schema, relationTable.name)} SET ${quote(runner, column)} = ? WHERE ${quote(runner, column)} = ?`, ['account', 'workspace']);
        changed = true;
      }
    }

    const activityTable = tables.find((table) => table.name === 'activity_logs');
    if (activityTable?.columns.includes('entity_type')) {
      const target = tableSql(runner, schema, activityTable.name);
      const rows = await bindParams(runner, `SELECT entity_type FROM ${target} WHERE entity_type = ?`, ['workspace']);
      if (rows.length) {
        await bindParams(runner, `UPDATE ${target} SET entity_type = ? WHERE entity_type = ?`, ['account', 'workspace']);
        changed = true;
      }
    }

    for (const table of tables) {
      const keyColumn = table.name === 'system_settings' ? 'key' : 'id';
      if (!table.columns.includes(keyColumn)) continue;
      const textType = ['mysql', 'mariadb'].includes(runner.connection.options.type) ? 'CHAR' : 'TEXT';
      for (const column of JSON_COLUMNS[table.name] || []) {
        if (!table.columns.includes(column)) continue;
        const rows = await bindParams(runner,
          `SELECT ${quote(runner, keyColumn)} AS row_key, ${quote(runner, column)} AS value FROM ${tableSql(runner, schema, table.name)} ` +
          `WHERE ${quote(runner, column)} IS NOT NULL AND (CAST(${quote(runner, column)} AS ${textType}) LIKE ? OR CAST(${quote(runner, column)} AS ${textType}) LIKE ?)`,
          ['%workspace%', '%Workspace%']);
        for (const row of rows) {
          let parsed: any;
          try { parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value; }
          catch {
            if (typeof row.value === 'string' && /"(?:[^"\\]*workspace(?:_id|Id|s)?[^"\\]*)"\s*:/.test(row.value)) {
              throw new Error(`Account ownership migration: malformed ownership JSON in ${table.name}.${column} (${row.row_key}); refusing to lose its owner reference`);
            }
            continue;
          }
          const next = rewriteOwnership(parsed, `${table.name}.${column} (${row.row_key})`);
          if (JSON.stringify(parsed) === JSON.stringify(next)) continue;
          await bindParams(runner, `UPDATE ${tableSql(runner, schema, table.name)} SET ${quote(runner, column)} = ? WHERE ${quote(runner, keyColumn)} = ?`, [JSON.stringify(next), row.row_key]);
          changed = true;
        }
      }
    }
    await runner.commitTransaction();
    return changed;
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  }
}

export async function preSyncAccountOwnership(options: DataSourceOptions): Promise<void> {
  const source = new DataSource({ ...options, entities: [], subscribers: [], migrations: [], synchronize: false, migrationsRun: false } as DataSourceOptions);
  await source.initialize();
  try {
    const runner = source.createQueryRunner();
    try {
      const changed = await migrateAccountOwnership(runner);
      if (changed && source.options.type === 'sqljs') await source.sqljsManager.saveDatabase();
    } finally { await runner.release(); }
  } finally { await source.destroy(); }
}
