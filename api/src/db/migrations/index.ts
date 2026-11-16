import type { Knex } from 'knex';
import * as createUsers from './0001_create_users.js';
import * as createProperties from './0002_create_properties.js';
import * as createPropertyImages from './0003_create_property_images.js';
import * as createPortalListings from './0004_create_portal_listings.js';
import * as createJobs from './0005_create_jobs.js';
import * as addPublishingColumns from './0006_add_publishing_columns.js';
import * as createPortalSyncState from './0007_create_portal_sync_state.js';
import * as addFeedChangedAt from './0008_add_feed_changed_at.js';

/**
 * All migrations, in the order they run. New migrations are appended here.
 *
 * Static imports instead of a directory scan: the list is identical under tsx (.ts files)
 * and in the compiled dist/ (.js files), and the names stored in knex_migrations carry no
 * file extension.
 */
export const MIGRATIONS: readonly (readonly [name: string, migration: Knex.Migration])[] = [
  ['0001_create_users', createUsers],
  ['0002_create_properties', createProperties],
  ['0003_create_property_images', createPropertyImages],
  ['0004_create_portal_listings', createPortalListings],
  ['0005_create_jobs', createJobs],
  ['0006_add_publishing_columns', addPublishingColumns],
  ['0007_create_portal_sync_state', createPortalSyncState],
  ['0008_add_feed_changed_at', addFeedChangedAt],
];

export const MIGRATION_NAMES: readonly string[] = MIGRATIONS.map(([name]) => name);

const migrationSource: Knex.MigrationSource<string> = {
  getMigrations: () => Promise.resolve([...MIGRATION_NAMES]),
  getMigrationName: (name) => name,
  getMigration: (name) => {
    const entry = MIGRATIONS.find(([candidate]) => candidate === name);
    if (!entry) {
      return Promise.reject(new Error(`Unknown migration "${name}"`));
    }
    return Promise.resolve(entry[1]);
  },
};

/** Pass to db.migrate.latest() / rollback() / list(). */
export const migratorConfig: Knex.MigratorConfig = {
  migrationSource,
  tableName: 'knex_migrations',
};
