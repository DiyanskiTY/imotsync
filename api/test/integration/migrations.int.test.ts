import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/knex.js';
import { MIGRATION_NAMES, migratorConfig } from '../../src/db/migrations/index.js';
import { loadTestConfig } from './test-db.js';

const APP_TABLES = ['jobs', 'portal_listings', 'properties', 'property_images', 'users'];

interface ColumnInfo {
  tableName: string;
  name: string;
  type: string;
  nullable: 'YES' | 'NO';
  defaultValue: string | null;
  extra: string;
  charset: string | null;
  collation: string | null;
}

interface IndexColumn {
  tableName: string;
  indexName: string;
  columnName: string;
}

let db: Knex;
let schema: string;

async function appTables() {
  const rows = await db('information_schema.tables')
    .where('table_schema', schema)
    .whereIn('table_name', APP_TABLES)
    .select<{ name: string; engine: string; collation: string }[]>(
      'table_name as name',
      'engine',
      'table_collation as collation',
    );
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

async function columns(): Promise<Map<string, ColumnInfo>> {
  const rows = await db('information_schema.columns')
    .where('table_schema', schema)
    .select<ColumnInfo[]>(
      'table_name as tableName',
      'column_name as name',
      'column_type as type',
      'is_nullable as nullable',
      'column_default as defaultValue',
      'extra',
      'character_set_name as charset',
      'collation_name as collation',
    );
  return new Map(rows.map((row) => [`${row.tableName}.${row.name}`, row]));
}

/** Indexes as "table(col1,col2)" strings. */
async function indexes(unique: boolean): Promise<string[]> {
  const rows = await db('information_schema.statistics')
    .where({ table_schema: schema, non_unique: unique ? 0 : 1 })
    .whereNot('index_name', 'PRIMARY')
    .orderBy([{ column: 'table_name' }, { column: 'index_name' }, { column: 'seq_in_index' }])
    .select<IndexColumn[]>(
      'table_name as tableName',
      'index_name as indexName',
      'column_name as columnName',
    );
  const grouped = new Map<string, { table: string; columns: string[] }>();
  for (const row of rows) {
    const key = `${row.tableName}.${row.indexName}`;
    const entry = grouped.get(key) ?? { table: row.tableName, columns: [] };
    entry.columns.push(row.columnName);
    grouped.set(key, entry);
  }
  return [...grouped.values()].map(({ table, columns: cols }) => `${table}(${cols.join(',')})`);
}

/** Foreign keys as "table.column -> table.column ON DELETE rule" strings. */
async function foreignKeys(): Promise<string[]> {
  const rows = await db('information_schema.referential_constraints as rc')
    .join('information_schema.key_column_usage as kcu', function () {
      this.on('kcu.constraint_schema', '=', 'rc.constraint_schema')
        .andOn('kcu.constraint_name', '=', 'rc.constraint_name')
        .andOn('kcu.table_name', '=', 'rc.table_name');
    })
    .where('rc.constraint_schema', schema)
    .select<
      {
        tableName: string;
        columnName: string;
        refTable: string;
        refColumn: string;
        onDelete: string;
      }[]
    >(
      'kcu.table_name as tableName',
      'kcu.column_name as columnName',
      'kcu.referenced_table_name as refTable',
      'kcu.referenced_column_name as refColumn',
      'rc.delete_rule as onDelete',
    );
  return rows
    .map(
      (r) =>
        `${r.tableName}.${r.columnName} -> ${r.refTable}.${r.refColumn} ON DELETE ${r.onDelete}`,
    )
    .sort();
}

beforeAll(async () => {
  const config = loadTestConfig();
  schema = config.db.database;
  db = createDb(config);
  // Start from an empty schema even if another test file already migrated it.
  await db.migrate.rollback(migratorConfig, true);
});

afterAll(async () => {
  await db.destroy();
});

describe('migrations', () => {
  it('runs against the test database, never the development one', () => {
    expect(schema).toMatch(/_test$/);
  });

  it('migrates an empty database to the latest version', async () => {
    expect(await appTables()).toEqual([]);

    const [, applied] = (await db.migrate.latest(migratorConfig)) as [number, string[]];

    expect(applied).toEqual(MIGRATION_NAMES);
    const [completed, pending] = (await db.migrate.list(migratorConfig)) as [unknown[], unknown[]];
    expect(completed).toHaveLength(MIGRATION_NAMES.length);
    expect(pending).toEqual([]);
  });

  it('creates the five tables as InnoDB with utf8mb4_unicode_ci', async () => {
    expect(await appTables()).toEqual(
      APP_TABLES.map((name) => ({ name, engine: 'InnoDB', collation: 'utf8mb4_unicode_ci' })),
    );
  });

  it('stores every text column as utf8mb4', async () => {
    const textColumns = [...(await columns()).values()].filter(
      (column) => column.charset !== null && APP_TABLES.includes(column.tableName),
    );

    expect(textColumns.length).toBeGreaterThan(10);
    for (const column of textColumns) {
      const label = `${column.tableName}.${column.name}`;
      expect(column.charset, label).toBe('utf8mb4');
      // MariaDB's JSON type is LONGTEXT with a binary collation.
      const expected = label === 'jobs.result' ? 'utf8mb4_bin' : 'utf8mb4_unicode_ci';
      expect(column.collation, label).toBe(expected);
    }
  });

  it('creates the key columns with the expected types and defaults', async () => {
    const cols = await columns();
    const col = (key: string) => {
      const column = cols.get(key);
      if (!column) throw new Error(`Column ${key} is missing`);
      return column;
    };
    const currentTimestamp = /^current_timestamp(\(\))?$/i;

    expect(col('users.id')).toMatchObject({ type: 'int(10) unsigned', extra: 'auto_increment' });
    expect(col('users.email')).toMatchObject({ type: 'varchar(255)', nullable: 'NO' });
    expect(col('users.role')).toMatchObject({
      type: "enum('admin','broker')",
      nullable: 'NO',
      defaultValue: "'broker'",
    });

    expect(col('properties.ref_code')).toMatchObject({ type: 'varchar(32)', nullable: 'NO' });
    expect(col('properties.title')).toMatchObject({ type: 'varchar(200)', nullable: 'YES' });
    expect(col('properties.type').type).toBe(
      "enum('apartment','house','office','shop','land','garage','other')",
    );
    expect(col('properties.deal_type').type).toBe("enum('sale','rent')");
    expect(col('properties.price')).toMatchObject({
      type: 'decimal(12,2) unsigned',
      nullable: 'YES',
    });
    expect(col('properties.currency')).toMatchObject({
      type: 'char(3)',
      nullable: 'NO',
      defaultValue: "'EUR'",
    });
    expect(col('properties.area_m2').type).toBe('decimal(8,2) unsigned');
    expect(col('properties.rooms').type).toMatch(/^tinyint(\(\d+\))? unsigned$/);
    expect(col('properties.floor').type).toMatch(/^smallint(\(\d+\))?$/);
    expect(col('properties.total_floors').type).toMatch(/^smallint(\(\d+\))? unsigned$/);
    expect(col('properties.description').type).toBe('text');
    expect(col('properties.status')).toMatchObject({
      type: "enum('draft','active','archived')",
      defaultValue: "'draft'",
    });
    expect(col('properties.created_by')).toMatchObject({
      type: 'int(10) unsigned',
      nullable: 'YES',
    });
    expect(col('properties.created_at')).toMatchObject({ type: 'datetime', nullable: 'NO' });
    expect(col('properties.created_at').defaultValue).toMatch(currentTimestamp);
    expect(col('properties.updated_at').defaultValue).toMatch(currentTimestamp);
    expect(col('properties.updated_at').extra).toMatch(/on update current_timestamp/i);

    expect(col('property_images.url')).toMatchObject({ type: 'varchar(500)', nullable: 'NO' });
    expect(col('property_images.sort_order')).toMatchObject({
      type: 'int(10) unsigned',
      defaultValue: '0',
    });
    expect(col('property_images.size_bytes').type).toBe('int(10) unsigned');

    expect(col('portal_listings.portal')).toMatchObject({ type: 'varchar(32)', nullable: 'NO' });
    expect(col('portal_listings.status')).toMatchObject({
      type: "enum('draft','pending','published','error','removed')",
      defaultValue: "'draft'",
    });
    expect(col('portal_listings.published_at')).toMatchObject({
      type: 'datetime',
      nullable: 'YES',
    });

    expect(col('jobs.id')).toMatchObject({
      type: 'bigint(20) unsigned',
      extra: 'auto_increment',
    });
    expect(col('jobs.action').type).toBe("enum('publish','update','remove')");
    expect(col('jobs.status')).toMatchObject({
      type: "enum('queued','running','succeeded','failed')",
      defaultValue: "'queued'",
    });
    expect(col('jobs.attempts').defaultValue).toBe('0');
    expect(col('jobs.max_attempts').defaultValue).toBe('5');
    expect(col('jobs.run_after')).toMatchObject({ type: 'datetime', nullable: 'NO' });
    expect(col('jobs.run_after').defaultValue).toMatch(currentTimestamp);
    expect(col('jobs.result').type).toMatch(/^(json|longtext)$/);
  });

  it('creates the unique keys', async () => {
    expect((await indexes(true)).sort()).toEqual([
      'portal_listings(property_id,portal)',
      'properties(ref_code)',
      'users(email)',
    ]);
  });

  it('creates the lookup indexes', async () => {
    expect(await indexes(false)).toEqual(
      expect.arrayContaining([
        'properties(status)',
        'properties(city)',
        'properties(deal_type,type)',
        'properties(created_by)',
        'property_images(property_id,sort_order)',
        'portal_listings(portal,status)',
        'jobs(status,run_after)',
        'jobs(portal_listing_id)',
      ]),
    );
  });

  it('creates the foreign keys with their delete rules', async () => {
    expect(await foreignKeys()).toEqual([
      'jobs.portal_listing_id -> portal_listings.id ON DELETE CASCADE',
      'portal_listings.property_id -> properties.id ON DELETE CASCADE',
      'properties.created_by -> users.id ON DELETE SET NULL',
      'property_images.property_id -> properties.id ON DELETE CASCADE',
    ]);
  });

  it('rolls everything back, then migrates up again', async () => {
    const [, rolledBack] = (await db.migrate.rollback(migratorConfig, true)) as [number, string[]];

    expect([...rolledBack].sort()).toEqual([...MIGRATION_NAMES].sort());
    expect(await appTables()).toEqual([]);

    const [, applied] = (await db.migrate.latest(migratorConfig)) as [number, string[]];
    expect(applied).toEqual(MIGRATION_NAMES);
    expect((await appTables()).map((table) => table.name)).toEqual(APP_TABLES);
  });
});
