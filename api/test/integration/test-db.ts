import { loadConfig, type Config } from '../../src/config.js';

/** Integration tests never touch the development database, only "<DB_NAME>_test". */
export const testDatabaseName = (devDatabase: string) => `${devDatabase}_test`;

/** The app config (root .env + environment), pointed at the test database. */
export function loadTestConfig(overrides: Partial<Pick<Config, 'uploadDir'>> = {}): Config {
  const config = loadConfig();
  return {
    ...config,
    ...overrides,
    db: { ...config.db, database: testDatabaseName(config.db.database) },
  };
}
