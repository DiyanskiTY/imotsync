import type { Knex } from 'knex';
import { parseConfig, type Config } from '../../src/config.js';
import type { UserRow } from '../../src/db/types.js';
import { createTokenService } from '../../src/modules/auth/tokens.js';

/** The smallest environment that passes validation. */
export const MINIMAL_ENV = {
  NODE_ENV: 'test',
  JWT_SECRET: 'unit-test-secret',
  DB_USER: 'imotsync',
  DB_PASSWORD: 'not-a-real-password',
} as const;

export function makeConfig(env: Record<string, string | undefined> = {}): Config {
  return parseConfig({ ...MINIMAL_ENV, ...env });
}

/**
 * A query chain that ignores every condition and resolves to the given rows
 * (`.first()` to the first one). Enough for code paths that only look rows up.
 */
function fakeQuery(rows: readonly unknown[]): unknown {
  const query: unknown = new Proxy(() => undefined, {
    get(_target, property) {
      if (property === 'then') {
        return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject);
      }
      if (property === 'first') return () => Promise.resolve(rows[0]);
      return () => query;
    },
  });
  return query;
}

/**
 * Stands in for Knex in unit tests: db.raw() for the health check, and db(table) for
 * simple look-ups, which resolve to the rows given for that table.
 */
export function fakeDb(
  raw: () => Promise<unknown>,
  tables: Partial<Record<string, readonly unknown[]>> = {},
): Knex {
  const db = (table: string) => fakeQuery(tables[table] ?? []);
  return Object.assign(db, { raw }) as unknown as Knex;
}

export const DEMO_ADMIN: UserRow = {
  id: 1,
  email: 'admin@imotsync.local',
  password_hash: '$scrypt$not-used-in-unit-tests',
  full_name: 'Demo Admin',
  role: 'admin',
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

export const healthyDb = (tables: Partial<Record<string, readonly unknown[]>> = {}) =>
  fakeDb(() => Promise.resolve([[{ 1: 1 }], []]), tables);
export const failingDb = () => fakeDb(() => Promise.reject(new Error('connect ECONNREFUSED')));
export const hangingDb = () => fakeDb(() => new Promise<never>(() => undefined));

/** A database in which the demo admin exists, so requireAuth accepts tokens for user 1. */
export const dbWithAdmin = () => healthyDb({ users: [DEMO_ADMIN] });

/** A valid access token for a user, signed with the config's secret. */
export async function tokenFor(
  config: Config,
  user: Pick<UserRow, 'id' | 'role'> = DEMO_ADMIN,
): Promise<string> {
  const tokens = createTokenService({ secret: config.jwtSecret, ttlSeconds: config.jwtTtlSeconds });
  return (await tokens.sign({ userId: user.id, role: user.role })).token;
}
