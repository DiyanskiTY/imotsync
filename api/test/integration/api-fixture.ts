import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import type { Knex } from 'knex';
import request from 'supertest';
import { expect } from 'vitest';
import { createApp, type AppDeps } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { createDb } from '../../src/db/knex.js';
import { migratorConfig } from '../../src/db/migrations/index.js';
import { runDemoSeed } from '../../src/db/seeds/demo-seed.js';
import { createLogger } from '../../src/logger.js';
import { loadTestConfig } from './test-db.js';

export const DEMO_PASSWORD = 'demo1234';
export const ADMIN_EMAIL = 'admin@imotsync.local';
export const BROKER_EMAIL = 'broker@imotsync.local';

export interface ApiFixture {
  app: Express;
  db: Knex;
  config: Config;
  /** Temporary UPLOAD_DIR, removed by close(). */
  uploadDir: string;
  close(): Promise<void>;
}

/**
 * The real app on the test database, freshly migrated and loaded with the demo data,
 * with photos in a temporary UPLOAD_DIR. The login limit is raised so that tests can log
 * in as often as they need (the limit itself is tested with its own low value).
 */
export async function startApiFixture(overrides: Partial<AppDeps> = {}): Promise<ApiFixture> {
  const uploadDir = await mkdtemp(path.join(tmpdir(), 'imotsync-int-'));
  const config = loadTestConfig({ uploadDir });
  const db = createDb(config);
  try {
    await db.migrate.latest(migratorConfig);
    await runDemoSeed(db, { uploadDir, demoPassword: DEMO_PASSWORD });
  } catch (error) {
    // Nothing would clean up after a fixture that never started.
    await db.destroy();
    await rm(uploadDir, { recursive: true, force: true });
    throw error;
  }

  const app = createApp({
    config,
    db,
    logger: createLogger(config),
    loginRateLimit: { limit: 10_000 },
    ...overrides,
  });

  return {
    app,
    db,
    config,
    uploadDir,
    async close() {
      await db.destroy();
      await rm(uploadDir, { recursive: true, force: true });
    },
  };
}

/**
 * For afterAll: closes the fixture if beforeAll got as far as starting it, so a failed
 * start reports its own error instead of a TypeError from here.
 */
export async function closeApiFixture(fixture: ApiFixture | undefined): Promise<void> {
  await fixture?.close();
}

/** Logs in through the API and returns the Authorization header. */
export async function authHeader(
  app: Express,
  email: string = ADMIN_EMAIL,
): Promise<{ Authorization: string }> {
  const res = await request(app).post('/api/auth/login').send({ email, password: DEMO_PASSWORD });
  expect(res.status, 'login in the test fixture').toBe(200);
  return { Authorization: `Bearer ${(res.body as { accessToken: string }).accessToken}` };
}

/** Counts the SQL statements a piece of work sends. */
export async function countQueries(db: Knex, work: () => Promise<unknown>): Promise<number> {
  let count = 0;
  const listener = () => {
    count++;
  };
  db.on('query', listener);
  try {
    await work();
  } finally {
    db.removeListener('query', listener);
  }
  return count;
}

/** An updated_at long before any test runs, so a test sees any operation move it on. */
export const BACKDATED = '2020-01-01T00:00:00.000Z';

/** Sets the property's updated_at to BACKDATED (a whole-second column needs no sleeping). */
export async function backdate(fixture: ApiFixture, propertyId: number): Promise<void> {
  await fixture
    .db('properties')
    .where({ id: propertyId })
    .update({ updated_at: new Date(BACKDATED) });
  const row = await fixture.db('properties').where({ id: propertyId }).first();
  expect(row?.updated_at.toISOString(), 'backdated updated_at').toBe(BACKDATED);
}

/** The file behind an /uploads URL, inside the fixture's UPLOAD_DIR. */
export const fileForUrl = (fixture: ApiFixture, url: string) =>
  path.join(fixture.uploadDir, ...url.replace(/^\/uploads\//, '').split('/'));
