import { DataSource, DataSourceOptions, QueryRunner } from 'typeorm';
import type { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata';

const LEGACY_ZONE_ENV = 'AWB_LEGACY_TIMESTAMP_TIMEZONE';

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

interface LegacyColumn {
  schema_name: string;
  table_name: string;
  column_name: string;
  precision: number;
}

function isInstantColumn(column: Partial<ColumnMetadata>): boolean {
  return column.type === Date || !!(column.isCreateDate || column.isUpdateDate || column.isDeleteDate);
}

/**
 * A JS Date is an instant, including CreateDateColumn/UpdateDateColumn values.
 * Keep the entity metadata dialect-neutral (migration fingerprints depend on
 * it), but store those instants as timestamptz in PostgreSQL. No pg global
 * parser, process TZ, or SQLite/MySQL driver state is changed.
 */
export class InstantDataSource extends DataSource {
  constructor(options: DataSourceOptions) {
    super(options);
    if (options.type === 'postgres') {
      const normalizeType = this.driver.normalizeType.bind(this.driver);
      this.driver.normalizeType = column => isInstantColumn(column as Partial<ColumnMetadata>)
        ? 'timestamp with time zone'
        : normalizeType(column);
    }
  }

  override async synchronize(dropBeforeSync = false): Promise<void> {
    if (this.options.type === 'postgres' && !dropBeforeSync) {
      await this.convertLegacyInstants();
    }
    await super.synchronize(dropBeforeSync);
  }

  private async convertLegacyInstants(): Promise<void> {
    const runner = this.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction();
      // A failed/contended upgrade must release its locks instead of blocking
      // every application writer indefinitely. Retry after stopping old writers.
      await runner.query("SET LOCAL lock_timeout = '5s'");
      const [{ schema_name: defaultSchema, timezone: databaseZone }] = await runner.query(
        "SELECT current_schema() AS schema_name, current_setting('TimeZone') AS timezone",
      );
      const wanted = new Set<string>();
      for (const meta of this.entityMetadatas) {
        if (!meta.synchronize) continue;
        for (const column of meta.columns) {
          if (isInstantColumn(column)) {
            wanted.add([meta.schema || defaultSchema, meta.tableName, column.databaseName].join('\0'));
          }
        }
      }
      const findLegacy = async (): Promise<LegacyColumn[]> => {
        const rows: LegacyColumn[] = await runner.query(
          `SELECT table_schema AS schema_name, table_name, column_name, datetime_precision AS precision
             FROM information_schema.columns
            WHERE data_type = 'timestamp without time zone'
            ORDER BY table_schema, table_name, ordinal_position`,
        );
        return rows.filter(row => wanted.has([row.schema_name, row.table_name, row.column_name].join('\0')));
      };
      let columns = await findLegacy();
      if (!columns.length) {
        await runner.commitTransaction();
        return;
      }

      const tableName = (column: LegacyColumn): string =>
        `${quoteIdentifier(column.schema_name)}.${quoteIdentifier(column.table_name)}`;
      const tables = [...new Set(columns.map(tableName))].sort();
      // Keep validation and conversion under the same locks, in deterministic
      // order. A second boot re-reads the catalog after the first has committed.
      await runner.query(`LOCK TABLE ${tables.join(', ')} IN ACCESS EXCLUSIVE MODE`);
      columns = await findLegacy();
      if (!columns.length) {
        await runner.commitTransaction();
        return;
      }

      const explicitZone = process.env[LEGACY_ZONE_ENV]?.trim();
      const nodeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const legacyZone = explicitZone || nodeZone;
      const [{ valid }] = await runner.query(
        'SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $1) AS valid', [legacyZone],
      );
      if (!valid) throw new Error(`Invalid ${LEGACY_ZONE_ENV} / Node timezone: ${legacyZone}`);
      const startedAt = Date.now();
      console.info(`[DB] Converting ${columns.length} legacy timestamp columns in ${tables.length} tables using ${legacyZone}`);

      for (const table of tables) {
        const tableColumns = columns.filter(column => tableName(column) === table);
        if (!tableColumns.length) continue;
        const [{ populated }] = await runner.query(
          `SELECT EXISTS (SELECT 1 FROM ${table} WHERE ${tableColumns.map(column => `${quoteIdentifier(column.column_name)} IS NOT NULL`).join(' OR ')}) AS populated`,
        );
        if (populated && !explicitZone && databaseZone !== nodeZone) {
          throw new Error(
            `Legacy timestamps in ${table}: Node timezone ${nodeZone} differs from PostgreSQL ${databaseZone}. ` +
            `Set ${LEGACY_ZONE_ENV} to the verified legacy writer timezone before upgrading; ` +
            'mixed-writer data needs separate reconciliation. No timestamp conversion was committed.',
          );
        }
        if (populated) {
          for (const column of tableColumns) {
            await this.assertUnambiguous(runner, table, column.column_name, legacyZone);
          }
        }
        // ALTER TYPE retains nullability, defaults, indexes, and fractional
        // precision; grouping columns avoids rewriting a table for every Date.
        const zoneLiteral = `'${legacyZone.replace(/'/g, "''")}'`;
        const changes = tableColumns.map(column => {
          const name = quoteIdentifier(column.column_name);
          const precision = Number(column.precision);
          if (!Number.isInteger(precision) || precision < 0 || precision > 6) throw new Error(`Invalid timestamp precision for ${table}.${name}`);
          return `ALTER COLUMN ${name} TYPE timestamp(${precision}) with time zone USING ${name} AT TIME ZONE ${zoneLiteral}`;
        });
        await runner.query(`ALTER TABLE ${table} ${changes.join(', ')}`);
      }
      await runner.commitTransaction();
      console.info(`[DB] Timestamp conversion committed in ${Date.now() - startedAt}ms`);
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  private async assertUnambiguous(runner: QueryRunner, table: string, column: string, zone: string): Promise<void> {
    const name = quoteIdentifier(column);
    const value = `legacy.${name}`;
    // A gap does not round-trip. At a fold PostgreSQL chooses the later
    // occurrence whereas the legacy pg1114/JS parser chooses the earlier one.
    // Check both neighbouring offsets, including non-hour/date-line changes;
    // refuse either case rather than silently changing an existing instant.
    const [{ unsafe }] = await runner.query(
      `SELECT EXISTS (
         SELECT 1 FROM ${table} AS legacy
          CROSS JOIN LATERAL (SELECT ${value} AT TIME ZONE $1 AS instant) chosen
          WHERE ${value} IS NOT NULL AND isfinite(${value}) AND (
            chosen.instant AT TIME ZONE $1 <> ${value}
            OR EXISTS (
              SELECT 1 FROM (VALUES (interval '-48 hours'), (interval '48 hours')) shift(delta)
              CROSS JOIN LATERAL (
                SELECT (chosen.instant + shift.delta) AT TIME ZONE $1
                     - (chosen.instant + shift.delta) AT TIME ZONE 'UTC' AS utc_offset
              ) neighbour
              CROSS JOIN LATERAL (
                SELECT (${value} - neighbour.utc_offset) AT TIME ZONE 'UTC' AS alternative
              ) candidate
              WHERE candidate.alternative <> chosen.instant
                AND candidate.alternative AT TIME ZONE $1 = ${value}
            )
          )
       ) AS unsafe`, [zone],
    );
    if (unsafe) {
      throw new Error(
        `Legacy timestamps in ${table}.${name} contain a DST fold/gap in ${zone}. ` +
        'Resolve their intended instants before upgrading; no timestamp conversion was committed.',
      );
    }
  }
}
