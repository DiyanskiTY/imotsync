import { readdir, stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Knex } from 'knex';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { createDb } from '../../src/db/knex.js';
import { migratorConfig } from '../../src/db/migrations/index.js';
import { DEMO_PROPERTIES } from '../../src/db/seeds/demo-data.js';
import { DEMO_PHOTO_FOLDER, runDemoSeed } from '../../src/db/seeds/demo-seed.js';
import { JOB_ACTIONS, JOB_STATUSES } from '../../src/db/types.js';
import { verifyPassword } from '../../src/lib/password.js';
import { loadTestConfig } from './test-db.js';

const TABLES = ['users', 'properties', 'property_images', 'portal_listings', 'jobs'] as const;

let config: Config;
let db: Knex;
let uploadDir: string;

async function rowCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const row = await db(table).count<{ count: number }>({ count: '*' }).first();
    counts[table] = Number(row?.count ?? 0);
  }
  return counts;
}

const seed = () => runDemoSeed(db, { uploadDir, demoPassword: config.seed.demoPassword });

beforeAll(async () => {
  // Generated photos go to a temporary folder, never to the real UPLOAD_DIR.
  uploadDir = await mkdtemp(path.join(tmpdir(), 'imotsync-seed-'));
  config = loadTestConfig({ uploadDir });
  db = createDb(config);
  await db.migrate.latest(migratorConfig);
});

afterAll(async () => {
  await db.destroy();
  await rm(uploadDir, { recursive: true, force: true });
});

describe('demo seed', () => {
  it('gives identical row counts when run twice', async () => {
    const firstSummary = await seed();
    const firstCounts = await rowCounts();
    const secondSummary = await seed();
    const secondCounts = await rowCounts();

    expect(secondSummary).toEqual(firstSummary);
    expect(secondCounts).toEqual(firstCounts);
    expect(firstCounts).toEqual({
      users: 2,
      properties: DEMO_PROPERTIES.length,
      property_images: firstSummary.propertyImages,
      portal_listings: firstSummary.portalListings,
      jobs: firstSummary.jobs,
    });
    expect(firstCounts.properties).toBeGreaterThanOrEqual(10);
    expect(firstCounts.property_images).toBeGreaterThan(20);
  });

  it('creates the demo accounts with the configured password', async () => {
    const users = await db('users').orderBy('id');

    expect(users.map((u) => [u.email, u.role, u.full_name])).toEqual([
      ['admin@imotsync.local', 'admin', 'Demo Admin'],
      ['broker@imotsync.local', 'broker', 'Demo Broker'],
    ]);
    for (const user of users) {
      expect(await verifyPassword(config.seed.demoPassword, user.password_hash)).toBe(true);
    }
  });

  it('assigns stable reference codes and uses EUR', async () => {
    const properties = await db('properties').orderBy('id');

    expect(properties[0]?.ref_code).toBe('IS-00001');
    expect(properties.at(-1)?.ref_code).toBe(`IS-${String(properties.length).padStart(5, '0')}`);
    expect(new Set(properties.map((p) => p.currency))).toEqual(new Set(['EUR']));
    expect(new Set(properties.map((p) => p.status))).toEqual(
      new Set(['draft', 'active', 'archived']),
    );
    expect(typeof properties[0]?.price).toBe('number');
    expect(properties[0]?.created_at).toBeInstanceOf(Date);
  });

  it('covers every portal and every listing status', async () => {
    const listings = await db('portal_listings');

    expect(new Set(listings.map((l) => l.portal))).toEqual(
      new Set(['realistimo', 'bazar', 'demo']),
    );
    expect(new Set(listings.map((l) => l.status))).toEqual(
      new Set(['draft', 'pending', 'published', 'error', 'removed']),
    );
    for (const listing of listings.filter((l) => l.status === 'error')) {
      expect(listing.last_error).toBeTruthy();
    }
  });

  it('covers every job status and action', async () => {
    const jobs = await db('jobs');

    expect(new Set(jobs.map((j) => j.status))).toEqual(new Set(JOB_STATUSES));
    expect(new Set(jobs.map((j) => j.action))).toEqual(new Set(JOB_ACTIONS));
  });

  it('locks running jobs, and only running jobs, to a worker', async () => {
    const jobs = await db('jobs');
    const running = jobs.filter((j) => j.status === 'running');

    expect(running.length).toBeGreaterThan(0);
    for (const job of running) {
      expect(job.locked_at).toBeInstanceOf(Date);
      expect(job.locked_at?.getTime()).toBeLessThan(Date.now());
      expect(job.locked_at?.getTime()).toBeGreaterThanOrEqual(job.created_at.getTime());
      expect(job.locked_by).toBeTruthy();
      expect(job.attempts).toBeGreaterThan(0);
      expect(job.finished_at).toBeNull();
    }
    for (const job of jobs.filter((j) => j.status !== 'running')) {
      expect([job.locked_at, job.locked_by]).toEqual([null, null]);
    }

    // A listing with a job in flight shows as pending.
    const listings = await db('portal_listings').whereIn(
      'id',
      running.map((j) => j.portal_listing_id),
    );
    expect(listings.length).toBeGreaterThan(0);
    expect(new Set(listings.map((l) => l.status))).toEqual(new Set(['pending']));
  });

  it('includes job history: succeeded, failed after max attempts, queued and retrying', async () => {
    const jobs = await db('jobs');
    const now = Date.now();

    expect(jobs.some((j) => j.status === 'succeeded' && j.finished_at !== null)).toBe(true);
    expect(jobs.some((j) => j.status === 'failed' && j.attempts === j.max_attempts)).toBe(true);
    expect(jobs.some((j) => j.status === 'queued' && j.run_after.getTime() > now)).toBe(true);
    expect(jobs.some((j) => j.status === 'queued' && j.attempts > 0)).toBe(true);
    // The JSON column comes back parsed.
    const withResult = jobs.find((j) => j.result !== null);
    expect(withResult?.result).toBeTypeOf('object');
    expect(jobs.find((j) => j.result?.externalId === 'rlst-100231')).toBeDefined();
  });

  it('writes a real JPEG for every image row', async () => {
    const images = await db('property_images').orderBy('id');
    const files = await readdir(path.join(uploadDir, DEMO_PHOTO_FOLDER));

    expect(files).toHaveLength(images.length);
    for (const image of images) {
      expect(image.url).toMatch(/^\/uploads\/demo\/is-\d{5}-\d+\.jpg$/);
      const file = path.join(uploadDir, image.url.replace(/^\/uploads\//, ''));
      const metadata = await sharp(file).metadata();
      expect(metadata.format).toBe('jpeg');
      expect([metadata.width, metadata.height]).toEqual([image.width, image.height]);
      expect((await stat(file)).size).toBe(image.size_bytes);
    }
  });

  it('round-trips Cyrillic text and 4-byte characters', async () => {
    const title = 'Тристаен апартамент с гледка към Витоша 🏔️';
    const description = 'Описание: „кавички“, ъгъл, щъркел, юг, ябълка. Emoji: 🏠🔑';

    await db('properties').insert({
      id: 9_001,
      ref_code: 'IS-TEST-UTF8',
      title,
      type: 'apartment',
      deal_type: 'sale',
      city: 'София',
      district: 'Лозенец',
      description,
    });
    try {
      const row = await db('properties').where('ref_code', 'IS-TEST-UTF8').first();
      expect(row).toMatchObject({ title, description, city: 'София', district: 'Лозенец' });

      const found = await db('properties').where('city', 'софия').first();
      expect(found?.ref_code).toBe('IS-TEST-UTF8');
    } finally {
      await db('properties').where('ref_code', 'IS-TEST-UTF8').delete();
    }

    const seeded = await db('properties').where('ref_code', 'IS-00001').first();
    expect(seeded?.title).toBe(DEMO_PROPERTIES[0]?.title);
  });

  it('cascades deletes from a property to its images, listings and jobs', async () => {
    const property = await db('properties').where('ref_code', 'IS-00001').first();
    if (!property) throw new Error('IS-00001 missing');
    const listingIds = await db('portal_listings').where('property_id', property.id).pluck('id');
    expect(listingIds.length).toBeGreaterThan(0);

    await db('properties').where('id', property.id).delete();

    expect(await db('property_images').where('property_id', property.id)).toEqual([]);
    expect(await db('portal_listings').where('property_id', property.id)).toEqual([]);
    expect(await db('jobs').whereIn('portal_listing_id', listingIds)).toEqual([]);

    // Put the demo data back for any later test.
    await seed();
  });
});
