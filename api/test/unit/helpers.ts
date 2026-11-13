import type { Knex } from 'knex';
import { parseConfig, type Config } from '../../src/config.js';

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

/** Stands in for Knex in unit tests: only db.raw() is used by the health check. */
export function fakeDb(raw: () => Promise<unknown>): Knex {
  return { raw } as unknown as Knex;
}

export const healthyDb = () => fakeDb(() => Promise.resolve([[{ 1: 1 }], []]));
export const failingDb = () => fakeDb(() => Promise.reject(new Error('connect ECONNREFUSED')));
export const hangingDb = () => fakeDb(() => new Promise<never>(() => undefined));
