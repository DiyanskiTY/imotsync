import knex from 'knex';
import { loadTestConfig } from './test-db.js';

/**
 * Runs once before the integration tests. Connects as root (DB_ROOT_PASSWORD), creates the
 * "<DB_NAME>_test" database if it is missing, grants the app user full access to it and
 * drops whatever tables an earlier run left behind, so every run starts from empty.
 */
export default async function setup(): Promise<void> {
  const config = loadTestConfig();
  const rootPassword = process.env.DB_ROOT_PASSWORD;
  if (!rootPassword) {
    throw new Error('DB_ROOT_PASSWORD must be set to run the integration tests.');
  }

  const { host, port, database, user } = config.db;
  const root = knex({
    client: 'mysql2',
    connection: { host, port, user: 'root', password: rootPassword, charset: 'utf8mb4' },
    // One connection, so the session-level FOREIGN_KEY_CHECKS below applies to every DROP.
    pool: { min: 0, max: 1 },
  });

  try {
    await root.raw(
      'CREATE DATABASE IF NOT EXISTS ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
      [database],
    );
    await root.raw("GRANT ALL PRIVILEGES ON ??.* TO ?@'%'", [database, user]);

    const tables = (
      await root('information_schema.tables')
        .where('table_schema', database)
        .select<{ name: string }[]>('table_name as name')
    ).map((row) => row.name);
    if (tables.length > 0) {
      await root.raw('SET FOREIGN_KEY_CHECKS = 0');
      for (const table of tables) {
        await root.raw('DROP TABLE ??.??', [database, table]);
      }
      await root.raw('SET FOREIGN_KEY_CHECKS = 1');
    }
  } catch (error) {
    throw new Error(
      `Could not prepare the test database "${database}" on ${host}:${port}. ` +
        'Is the database container running (docker compose up -d db)?',
      { cause: error },
    );
  } finally {
    await root.destroy();
  }
}
