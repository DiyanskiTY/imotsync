import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { DEMO_ACCOUNT_EMAIL } from '../../src/db/seeds/demo-data.js';
import { createLogger } from '../../src/logger.js';
import { createPropertiesService } from '../../src/modules/properties/properties.service.js';
import { createPropertyRepository } from '../../src/modules/properties/properties.repository.js';
import { closeApiFixture, startApiFixture, type ApiFixture } from './api-fixture.js';

/*
 * The public demo's rules that need the database: the demo sign-in against the seeded account,
 * and the property limit, which counts only properties that are not waiting to be deleted.
 */

let fx: ApiFixture;

beforeAll(async () => {
  fx = await startApiFixture();
});

afterAll(async () => {
  await closeApiFixture(fx);
});

const newProperty = { type: 'apartment', dealType: 'sale', city: 'Sofia' } as const;

describe('the demo sign-in', () => {
  it('signs in the seeded demo broker', async () => {
    const config = { ...fx.config, demoMode: true };
    const app = createApp({ config, db: fx.db, logger: createLogger(config) });

    const res = await request(app).post('/api/auth/demo');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ user: { email: DEMO_ACCOUNT_EMAIL, role: 'broker' } });
  });
});

describe('the property limit', () => {
  it('does not count properties waiting to be deleted', async () => {
    const repo = createPropertyRepository(fx.db);
    const live = await repo.countLive();
    const all = await fx.db('properties').count<{ total: number }[]>({ total: '*' });
    const scheduled = await fx
      .db('properties')
      .whereNotNull('delete_requested_at')
      .count<{ n: number }[]>({ n: '*' });
    expect(live).toBe(Number(all[0]?.total) - Number(scheduled[0]?.n ?? 0));

    const [first] = await fx.db('properties').whereNull('delete_requested_at').select('id');
    await fx.db('properties').where({ id: first?.id }).update({ delete_requested_at: new Date() });
    try {
      expect(await repo.countLive()).toBe(live - 1);
    } finally {
      await fx.db('properties').where({ id: first?.id }).update({ delete_requested_at: null });
    }
  });

  it('refuses a create at the limit and allows one below it', async () => {
    const live = await createPropertyRepository(fx.db).countLive();

    const full = createPropertiesService({ db: fx.db, maxProperties: live });
    await expect(full.create(newProperty, 1)).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
    });

    const roomForOne = createPropertiesService({ db: fx.db, maxProperties: live + 1 });
    const created = await roomForOne.create(newProperty, 1);
    expect(created.city).toBe('Sofia');
    await fx.db('properties').where({ id: created.id }).delete();
  });
});
