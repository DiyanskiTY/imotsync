import knex, { type Knex } from 'knex';
import type { Connection } from 'mysql2';
import type { DbConfig } from '../config.js';

/**
 * Creates the Knex instance (connection pool) for MariaDB.
 *
 * - utf8mb4 end to end, so Cyrillic text and emoji survive the round trip.
 * - All DATETIME values are UTC: the driver reads and writes them as UTC (timezone 'Z')
 *   and every new connection sets the session time zone, so CURRENT_TIMESTAMP is UTC too.
 * - DECIMAL columns (price, area) come back as numbers instead of strings.
 */
export function createDb(config: { db: DbConfig }): Knex {
  const { host, port, database, user, password } = config.db;

  return knex({
    client: 'mysql2',
    connection: {
      host,
      port,
      database,
      user,
      password,
      charset: 'utf8mb4',
      timezone: 'Z',
      decimalNumbers: true,
      connectTimeout: 5_000,
    },
    pool: {
      // No idle connections are kept, so the API can start (and report "degraded")
      // while the database is down.
      min: 0,
      max: 10,
      afterCreate(
        connection: Connection,
        done: (error: Error | null, connection: Connection) => void,
      ) {
        connection.query("SET time_zone = '+00:00'", (error) => {
          done(error, connection);
        });
      },
    },
    acquireConnectionTimeout: 10_000,
  });
}
