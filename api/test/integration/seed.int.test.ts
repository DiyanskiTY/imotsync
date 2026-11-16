import { existsSync } from 'node:fs';
import { mkdir, readdir, stat, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { JOB_ACTIONS, JOB_STATUSES, type PortalListingRow } from '../../src/db/types.js';
import { sweepStaleJobs } from '../../src/jobs/sweep.js';
import { createWorker } from '../../src/jobs/worker.js';
import { verifyPassword } from '../../src/lib/password.js';
import { LocalFileStorage } from '../../src/lib/storage.js';
import { createLogger } from '../../src/logger.js';
import { UPLOADED_PHOTOS_FOLDER } from '../../src/modules/images/stored-files.js';
import { demoExternalId } from '../../src/portals/demo/demo-adapter.js';
import {
  createPortalRegistry,
  registryFrom,
  type PortalRegistration,
  type PortalRegistry,
} from '../../src/portals/registry.js';
import type { PortalAdapter } from '../../src/portals/types.js';
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
    expect(jobs.find((j) => j.result?.externalId === 'demo-000001')).toBeDefined();
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

  it('deletes photos uploaded through the API, whose rows it replaces', async () => {
    // What an upload to property 11 leaves behind; after the seed, id 11 is a new property.
    const uploaded = path.join(uploadDir, UPLOADED_PHOTOS_FOLDER, '11');
    await mkdir(uploaded, { recursive: true });
    await writeFile(path.join(uploaded, '9269aaa4-607a-4961-bc18-a5396413ca0f.jpg'), 'jpeg');

    await seed();

    expect(existsSync(path.join(uploadDir, UPLOADED_PHOTOS_FOLDER))).toBe(false);
    expect((await readdir(path.join(uploadDir, DEMO_PHOTO_FOLDER))).length).toBeGreaterThan(20);
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

  it('records when listings were published and removed, and ids only where portals give one', async () => {
    const listings = await db('portal_listings').orderBy('id');

    for (const listing of listings) {
      const label = `listing ${listing.id} (${listing.portal}, ${listing.status})`;
      if (listing.status === 'published' || listing.status === 'removed') {
        expect(listing.published_at, label).toBeInstanceOf(Date);
      }
      expect(listing.removed_at !== null, label).toBe(listing.status === 'removed');
      // Feed portals assign no id; the demo portal answers "demo-" + the property id.
      if (listing.portal === 'demo' && listing.published_at !== null) {
        expect(listing.external_id, label).toBe(demoExternalId(listing.property_id));
      } else if (listing.portal !== 'demo') {
        expect(listing.external_id, label).toBeNull();
      }
    }
  });

  it('wipes the portal sync state', async () => {
    await db('portal_sync_state').insert({ portal: 'realistimo', last_trigger_message: 'queued' });

    await seed();

    expect(await db('portal_sync_state')).toEqual([]);
  });
});

/** A feed adapter that accepts everything and stores a recognisable payload. */
function fakeFeedPortal(key: string, rejectRefCode?: string): PortalRegistration {
  const adapter: PortalAdapter = {
    key,
    displayName: `Fake ${key}`,
    mode: 'feed',
    validate: (property) =>
      property.refCode === rejectRefCode ? [{ field: 'title', message: 'Not this one.' }] : [],
    publish: (property) =>
      Promise.resolve({
        message: 'stored',
        payload: { ref: property.refCode, firstImage: property.images[0]?.url ?? null },
      }),
    update: () => Promise.reject(new Error('the seed never updates')),
    remove: (listing) =>
      Promise.resolve({ message: 'gone', payload: { ...listing.payload, gone: true } }),
  };
  return { adapter, feedRenderer: { contentType: 'text/plain', render: () => '' } };
}

describe('demo seed with portal adapters (feed payloads)', () => {
  const seedWith = (registry: PortalRegistry) =>
    runDemoSeed(db, {
      uploadDir,
      demoPassword: config.seed.demoPassword,
      registry,
      publicBaseUrl: 'https://imotsync.example',
    });

  afterAll(async () => {
    await seed();
  });

  it('passes the rules of every registered portal and fills the feeds of feed portals', async () => {
    const registry = createPortalRegistry(config);
    const summary = await seedWith(registry);

    const listings = await db('portal_listings').orderBy('id');
    for (const listing of listings) {
      const adapter = registry.get(listing.portal);
      const label = `listing ${listing.id} (${listing.portal}, ${listing.status})`;
      if (adapter?.mode === 'feed' && listing.status === 'published') {
        expect(listing.payload, label).not.toBeNull();
      }
      if (adapter?.mode !== 'feed') expect(listing.payload, label).toBeNull();
      if (adapter?.mode === 'feed' && listing.status === 'removed' && listing.published_at) {
        // Like a remove job: the removal is dated, also when the payload is dropped.
        expect(listing.payload_updated_at, label).toEqual(listing.removed_at);
        // Realistimo leaves a removed offer out of the feed; Bazar keeps it as out of stock.
        if (listing.portal === 'realistimo') expect(listing.payload, label).toBeNull();
        if (listing.portal === 'bazar') {
          expect(listing.payload, label).toMatchObject({ availability: 'out_of_stock' });
        }
      }
    }
    const withPayload = listings.filter((listing) => listing.payload !== null);
    for (const [portal, count] of Object.entries(summary.feedPayloads)) {
      expect(withPayload.filter((listing) => listing.portal === portal)).toHaveLength(count);
    }
  });

  it('stores what the adapters return: publish for live listings, then remove for removed ones', async () => {
    const registry = registryFrom([fakeFeedPortal('realistimo'), fakeFeedPortal('bazar')]);

    const summary = await seedWith(registry);

    const listings = await db('portal_listings')
      .join('properties', 'properties.id', 'portal_listings.property_id')
      .orderBy('portal_listings.id')
      .select<(PortalListingRow & { ref_code: string })[]>(
        'portal_listings.*',
        'properties.ref_code',
      );
    const expected = listings.filter(
      (l) => l.portal !== 'demo' && (l.status === 'published' || l.status === 'removed'),
    );
    expect(expected.length).toBeGreaterThan(5);
    expect(summary.feedPayloads).toEqual({
      realistimo: expected.filter((l) => l.portal === 'realistimo').length,
      bazar: expected.filter((l) => l.portal === 'bazar').length,
    });
    for (const listing of listings) {
      const label = `${listing.ref_code} on ${listing.portal} (${listing.status})`;
      if (!expected.includes(listing)) {
        expect(listing.payload, label).toBeNull();
        continue;
      }
      expect(listing.payload, label).toEqual({
        ref: listing.ref_code,
        firstImage: expect.stringMatching(
          /^https:\/\/imotsync\.example\/uploads\/demo\//,
        ) as string,
        ...(listing.status === 'removed' ? { gone: true } : {}),
      });
      expect(listing.payload_updated_at, label).toEqual(
        listing.status === 'removed' ? listing.removed_at : listing.updated_at,
      );
    }
  });

  it('seeds queued and running jobs that the worker can process with the real adapters', async () => {
    // The real portals, with a demo portal that never fails (DEMO_PORTAL_FAILURE_RATE=0).
    const registry = createPortalRegistry({
      ...config,
      portals: { ...config.portals, demo: { failureRate: 0, latencyMs: 0 } },
    });
    await seedWith(registry);
    const seededJobs = await db('jobs').whereIn('status', ['queued', 'running']).orderBy('id');
    expect(seededJobs.map((job) => job.status)).toContain('running');
    expect(seededJobs.some((job) => job.run_after > new Date())).toBe(true);

    // Time passes: the delayed jobs become due, and the running job's worker is long gone.
    await db('jobs')
      .where({ status: 'running' })
      .update({ locked_at: db.raw('DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR)') });
    expect(
      await sweepStaleJobs(db, { lockTimeoutSeconds: 600, retry: config.retry, random: () => 0 }),
    ).toEqual({ requeued: 1, failed: 0 });
    await db('jobs')
      .where({ status: 'queued' })
      .update({ run_after: db.raw('DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 SECOND)') });

    const stats = await createWorker({
      db,
      registry,
      storage: new LocalFileStorage(uploadDir),
      logger: createLogger(config),
      config: {
        worker: {
          concurrency: 2,
          pollIntervalMs: 50,
          jobTimeoutSeconds: 30,
          lockTimeoutSeconds: 600,
        },
        retry: config.retry,
        publicBaseUrl: 'https://imotsync.example',
      },
      maintenance: false,
    }).runOnce();

    expect(stats).toMatchObject({ claimed: seededJobs.length, failed: 0, retrying: 0, lost: 0 });
    const after = await db('jobs').whereIn(
      'id',
      seededJobs.map((job) => job.id),
    );
    expect(after.map((job) => [job.id, job.status])).toEqual(
      seededJobs.map((job) => [job.id, 'succeeded']),
    );
    expect(await db('jobs').whereIn('status', ['queued', 'running'])).toEqual([]);
  });

  it('refuses demo data that a portal would reject, and keeps the previous data', async () => {
    await seed();
    const before = await db('portal_listings').orderBy('id');

    await expect(
      seedWith(registryFrom([fakeFeedPortal('realistimo', 'IS-00001'), fakeFeedPortal('bazar')])),
    ).rejects.toThrow(/IS-00001 is published on realistimo, but Fake realistimo would reject it/);

    expect(await db('portal_listings').orderBy('id')).toEqual(before);
  });
});
