import type { Knex } from 'knex';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDb } from '../../src/db/knex.js';
import { createLogger } from '../../src/logger.js';
import { loadTestConfig } from './test-db.js';

let db: Knex;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  const config = loadTestConfig();
  db = createDb(config);
  app = createApp({ config, db, logger: createLogger(config) });
});

afterAll(async () => {
  await db.destroy();
});

describe('GET /api/health with a real database', () => {
  it('reports the database as up', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'up' });
  });

  it('uses UTC for the database session', async () => {
    const [rows] = (await db.raw('SELECT @@session.time_zone AS tz')) as [{ tz: string }[]];

    expect(rows[0]?.tz).toBe('+00:00');
  });
});
