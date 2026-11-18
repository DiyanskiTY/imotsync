import { existsSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { createWorker, type WorkerStats } from '../../src/jobs/worker.js';
import { LocalFileStorage } from '../../src/lib/storage.js';
import { createLogger } from '../../src/logger.js';
import type { JobDto } from '../../src/modules/jobs/jobs.mappers.js';
import type {
  PortalDto,
  PublishResultDto,
} from '../../src/modules/publishing/publishing.mappers.js';
import type { PropertyDetailDto } from '../../src/modules/properties/properties.mappers.js';
import { createDemoAdapter } from '../../src/portals/demo/demo-adapter.js';
import { formatSofiaDateTime } from '../../src/portals/realistimo/time.js';
import { PORTAL_FACTORIES, registryFrom, type PortalRegistry } from '../../src/portals/registry.js';
import { testImage } from '../support/images.js';
import { expectDocumented } from '../support/openapi.js';
import {
  authHeader,
  closeApiFixture,
  fileForUrl,
  startApiFixture,
  type ApiFixture,
} from './api-fixture.js';
import { clearUnfinishedJobs, scriptedDemoRandom, TEST_RETRY } from './publishing-fixture.js';
import { loadTestConfig } from './test-db.js';

/*
 * The whole publishing flow through the API with the real Realistimo and Bazar.bg adapters
 * and a deterministic demo portal: publish to all three portals, run the worker, read both
 * feeds; edit, unpublish and bulk delete, each followed by the worker.
 */

let fx: ApiFixture;
let config: Config;
let auth: { Authorization: string };
let registry: PortalRegistry;
const demo = scriptedDemoRandom();

const PORTALS = ['realistimo', 'bazar', 'demo'];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  isArray: (name) => ['offer', 'Broker', 'item', 'g:additional_image_link'].includes(name),
});

type Offer = Record<string, string>;
type Item = Record<string, string | string[]>;

interface RealistimoFeed {
  feed: { updated: string; agency_uid: string; offers: '' | { offer: Offer[] } };
}
interface BazarFeed {
  rss: { channel: { item?: Item[] } };
}

beforeAll(async () => {
  config = loadTestConfig();
  // The configured Realistimo and Bazar entries of PORTAL_FACTORIES, plus a demo portal whose
  // answers the test scripts (everything succeeds unless told otherwise).
  registry = registryFrom([
    ...PORTAL_FACTORIES.slice(0, 2).map((factory) => factory(config)),
    { adapter: createDemoAdapter({ failureRate: 0.5, latencyMs: 0, random: demo.random }) },
  ]);
  expect(registry.keys()).toEqual(PORTALS);
  fx = await startApiFixture({ registry });
  auth = await authHeader(fx.app);
  await clearUnfinishedJobs(fx.db);
});

afterAll(async () => {
  await closeApiFixture(fx);
});

const api = {
  get: (path: string) => request(fx.app).get(`/api${path}`).set(auth),
  post: (path: string, body?: object) => request(fx.app).post(`/api${path}`).set(auth).send(body),
  patch: (path: string, body: object) => request(fx.app).patch(`/api${path}`).set(auth).send(body),
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `npm run worker:once` in process: every due job, then its periodic tasks once (finishing
 * requested deletions, the photo sweep). `now` lets time pass for those.
 */
function runWorkerOnce(now?: () => Date): Promise<WorkerStats> {
  return createWorker({
    db: fx.db,
    registry,
    storage: new LocalFileStorage(fx.uploadDir),
    logger: createLogger(fx.config),
    config: {
      worker: {
        concurrency: 2,
        pollIntervalMs: 100,
        jobTimeoutSeconds: 10,
        lockTimeoutSeconds: 60,
      },
      retry: TEST_RETRY,
      publicBaseUrl: fx.config.publicBaseUrl,
    },
    random: () => 0,
    now,
  }).runOnce();
}

/** The feed URLs exactly as GET /api/portals hands them out, as paths on this app. */
async function feedPaths(): Promise<Record<string, string>> {
  const res = await api.get('/portals');
  expect(res.status).toBe(200);
  const paths: Record<string, string> = {};
  for (const portal of (res.body as { data: PortalDto[] }).data) {
    if (portal.feedUrl !== null) paths[portal.key] = new URL(portal.feedUrl).pathname;
  }
  return paths;
}

async function realistimoFeed() {
  const res = await request(fx.app).get((await feedPaths()).realistimo ?? '');
  expect(res.status).toBe(200);
  expectDocumented(res, 'get', '/feeds/{portal}/{token}.xml');
  const parsed = parser.parse(res.text) as RealistimoFeed;
  const offers = parsed.feed.offers === '' ? [] : parsed.feed.offers.offer;
  return {
    res,
    feed: parsed.feed,
    offers,
    offer: (refCode: string) => offers.find((o) => o.offer_uid === refCode),
  };
}

async function bazarFeed() {
  const res = await request(fx.app).get((await feedPaths()).bazar ?? '');
  expect(res.status).toBe(200);
  expectDocumented(res, 'get', '/feeds/{portal}/{token}.xml');
  const items = (parser.parse(res.text) as BazarFeed).rss.channel.item ?? [];
  return { res, items, item: (refCode: string) => items.find((i) => i['g:id'] === refCode) };
}

/** A property every portal accepts, created and given two photos through the API. */
async function createReadyProperty(title: string, price: number): Promise<PropertyDetailDto> {
  const created = await api.post('/properties', {
    type: 'apartment',
    dealType: 'sale',
    city: 'Sofia',
    district: 'Lozenets',
    title,
    description: 'Светъл тристаен апартамент с южно изложение, асансьор и гледка към Витоша.',
    price,
    areaM2: 98,
    rooms: 3,
    floor: 4,
    totalFloors: 6,
  });
  expect(created.status).toBe(201);
  const property = created.body as PropertyDetailDto;
  const upload = await request(fx.app)
    .post(`/api/properties/${property.id}/images`)
    .set(auth)
    .attach('photos', await testImage({ width: 1200, height: 900 }), 'front.jpg')
    .attach('photos', await testImage({ width: 900, height: 1200 }), 'kitchen.jpg');
  expect(upload.status).toBe(201);
  return (await api.get(`/properties/${property.id}`)).body as PropertyDetailDto;
}

async function jobsOfProperty(propertyId: number): Promise<JobDto[]> {
  const res = await api.get(`/jobs?propertyId=${propertyId}&sort=createdAt&pageSize=100`);
  expect(res.status).toBe(200);
  expectDocumented(res, 'get', '/jobs');
  return (res.body as { data: JobDto[] }).data;
}

describe('publishing to Realistimo, Bazar.bg and the demo portal', () => {
  let property: PropertyDetailDto;

  it('passes the pre-publish check of every portal', async () => {
    property = await createReadyProperty('Тристаен апартамент в Лозенец', 245_000);

    const res = await api.get(`/properties/${property.id}/checks`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [
        { portal: 'realistimo', displayName: 'Realistimo', ready: true, issues: [] },
        { portal: 'bazar', displayName: 'Bazar.bg', ready: true, issues: [] },
        { portal: 'demo', displayName: 'Demo portal', ready: true, issues: [] },
      ],
    });
  });

  it('publishes: the worker runs one job per portal, then both feeds contain the property', async () => {
    const res = await api.post(`/properties/${property.id}/publish`, { portals: PORTALS });
    expect(res.status).toBe(202);
    // Queued, not sent yet.
    expect(
      (res.body as { data: PublishResultDto }).data.listings.map((listing) => listing.lastSentAt),
    ).toEqual([null, null, null]);
    expect((res.body as { data: PublishResultDto }).data.jobs.map((job) => job.action)).toEqual([
      'publish',
      'publish',
      'publish',
    ]);

    const stats = await runWorkerOnce();

    expect(stats).toMatchObject({ claimed: 3, succeeded: 3, failed: 0, retrying: 0 });
    const detail = (await api.get(`/properties/${property.id}`)).body as PropertyDetailDto;
    expect(detail.status).toBe('active');
    expect(detail.portals.map((l) => [l.portal, l.status, l.externalId])).toEqual(
      expect.arrayContaining([
        ['realistimo', 'published', null],
        ['bazar', 'published', null],
        ['demo', 'published', `demo-${String(property.id).padStart(6, '0')}`],
      ]),
    );

    // The job log shows the three jobs with the adapters' own messages.
    const jobs = await jobsOfProperty(property.id);
    expect(jobs.map((job) => [job.listing.portal, job.action, job.status, job.attempts])).toEqual(
      expect.arrayContaining([
        ['realistimo', 'publish', 'succeeded', 1],
        ['bazar', 'publish', 'succeeded', 1],
        ['demo', 'publish', 'succeeded', 1],
      ]),
    );
    // Each listing says when it was last sent: when its successful job finished.
    for (const listing of detail.portals) {
      const job = jobs.find((j) => j.listing.portal === listing.portal);
      expect(listing.lastSentAt).toBe(job?.finishedAt);
    }
    const realistimoJob = jobs.find((job) => job.listing.portal === 'realistimo');
    expect(realistimoJob?.result).toMatchObject({
      message: 'Added to the Realistimo feed (next import picks it up)',
    });

    const { feed, offer } = await realistimoFeed();
    const photoUrls = detail.images.map((image) => `${fx.config.publicBaseUrl}${image.url}`);
    expect(feed.agency_uid).toBe(config.portals.realistimo.agencyUid);
    expect(offer(property.refCode)).toMatchObject({
      offer_uid: property.refCode,
      offer_code: property.refCode,
      title: 'Тристаен апартамент в Лозенец',
      price: '245000',
      currency: 'eur',
      category: 'продажби',
      subcategory: '3-СТАЕН',
      surface: '98',
      images: photoUrls.join(';'),
      broker_id: 'imotsync-1',
    });

    const { item } = await bazarFeed();
    expect(item(property.refCode)).toMatchObject({
      'g:id': property.refCode,
      title: 'Тристаен апартамент в Лозенец',
      'g:price': '245000.00 EUR',
      'g:availability': 'in_stock',
      'g:product_type': 'Имоти > Продажби > Апартаменти',
      'g:custom_label_0': 'София',
      'g:image_link': photoUrls[0],
      'g:additional_image_link': [photoUrls[1]],
    });
  });

  it('answers 304 to a portal that already has the current feed', async () => {
    const { res } = await realistimoFeed();
    const path = (await feedPaths()).realistimo ?? '';

    const again = await request(fx.app).get(path).set('If-None-Match', String(res.headers.etag));
    const since = await request(fx.app)
      .get(path)
      .set('If-Modified-Since', String(res.headers['last-modified']));

    expect(again.status).toBe(304);
    expect(since.status).toBe(304);
  });

  it('queues update jobs for an edit, and the feeds show the new price after the worker', async () => {
    const before = await realistimoFeed();

    const edit = await api.patch(`/properties/${property.id}`, { price: 239_500 });
    expect(edit.status).toBe(200);
    const queued = (await jobsOfProperty(property.id)).filter((job) => job.status === 'queued');
    expect(queued.map((job) => [job.listing.portal, job.action]).sort()).toEqual([
      ['bazar', 'update'],
      ['demo', 'update'],
      ['realistimo', 'update'],
    ]);
    // Until the jobs ran, the feeds keep serving the last good version.
    expect((await realistimoFeed()).offer(property.refCode)?.price).toBe('245000');

    expect(await runWorkerOnce()).toMatchObject({ claimed: 3, succeeded: 3 });

    const after = await realistimoFeed();
    expect(after.offer(property.refCode)?.price).toBe('239500');
    expect((await bazarFeed()).item(property.refCode)?.['g:price']).toBe('239500.00 EUR');
    // The old copy is stale now.
    const stale = await request(fx.app)
      .get((await feedPaths()).realistimo ?? '')
      .set('If-None-Match', String(before.res.headers.etag));
    expect(stale.status).toBe(200);
  });

  it('unpublishes: Realistimo leaves the offer out, Bazar.bg keeps it as out of stock', async () => {
    const res = await api.post(`/properties/${property.id}/unpublish`, {});
    expect(res.status).toBe(202);

    expect(await runWorkerOnce()).toMatchObject({ claimed: 3, succeeded: 3 });

    const realistimo = await realistimoFeed();
    expect(realistimo.offer(property.refCode)).toBeUndefined();
    const removedAt = await fx
      .db('portal_listings')
      .where({ property_id: property.id, portal: 'realistimo' })
      .first();
    expect(removedAt?.status).toBe('removed');
    // The removal moved <updated>, so Realistimo imports the feed again and drops the offer.
    expect(realistimo.feed.updated).toBe(
      formatSofiaDateTime(removedAt?.payload_updated_at ?? new Date(0)),
    );

    expect((await bazarFeed()).item(property.refCode)).toMatchObject({
      'g:id': property.refCode,
      'g:availability': 'out_of_stock',
    });
    const detail = (await api.get(`/properties/${property.id}`)).body as PropertyDetailDto;
    expect(detail.portals.map((l) => l.status)).toEqual(['removed', 'removed', 'removed']);
  });
});

describe('deleting a property that was on the portals', () => {
  it('bulk delete: removals first, then Bazar.bg serves the item as out of stock for the retention period before the worker deletes the property', async () => {
    const property = await createReadyProperty('Двустаен апартамент в Лозенец', 182_000);
    expect(
      (await api.post(`/properties/${property.id}/publish`, { portals: PORTALS })).status,
    ).toBe(202);
    await runWorkerOnce();
    expect((await realistimoFeed()).offer(property.refCode)).toBeDefined();
    expect((await bazarFeed()).item(property.refCode)).toBeDefined();
    const listingIds = await fx
      .db('portal_listings')
      .where({ property_id: property.id })
      .pluck('id');
    expect(listingIds).toHaveLength(3);

    const res = await api.post('/properties/bulk/delete', { propertyIds: [property.id] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [{ propertyId: property.id, result: 'removal_queued' }] });
    expect(((await api.get(`/properties/${property.id}`)).body as PropertyDetailDto).status).toBe(
      'archived',
    );

    expect(await runWorkerOnce()).toMatchObject({ claimed: 3, succeeded: 3 });

    // Removed everywhere, but Bazar.bg downloads its feed only every 6 to 24 hours: the item
    // stays in the feed as out of stock (Bazar archives it then) instead of vanishing, which
    // would shrink the feed. So the property waits, archived, with its listings.
    expect((await realistimoFeed()).offer(property.refCode)).toBeUndefined();
    expect((await bazarFeed()).item(property.refCode)).toMatchObject({
      'g:availability': 'out_of_stock',
    });
    expect(((await api.get(`/properties/${property.id}`)).body as PropertyDetailDto).status).toBe(
      'archived',
    );
    expect(await fx.db('portal_listings').whereIn('id', listingIds)).toHaveLength(3);
    // The out-of-stock item still links to the photos: their files stay.
    for (const image of property.images) expect(existsSync(fileForUrl(fx, image.url))).toBe(true);
    // The worker's sweep checks again: still within the retention period.
    await runWorkerOnce();
    expect((await api.get(`/properties/${property.id}`)).status).toBe(200);

    // BAZAR_REMOVED_RETENTION_DAYS later the item has dropped out of the feed, and the
    // worker's periodic sweep deletes the property, then its photo files.
    const retention = config.portals.bazar.removedRetentionDays;
    const later = new Date(Date.now() + (retention + 1) * DAY_MS);
    await runWorkerOnce(() => later);

    expect((await api.get(`/properties/${property.id}`)).status).toBe(404);
    expect(await fx.db('portal_listings').whereIn('id', listingIds)).toEqual([]);
    expect(await fx.db('jobs').whereIn('portal_listing_id', listingIds)).toEqual([]);
    for (const image of property.images) expect(existsSync(fileForUrl(fx, image.url))).toBe(false);

    // The deletion is recorded as a feed change, so Realistimo's <updated> never falls back.
    const realistimo = await realistimoFeed();
    expect(realistimo.offer(property.refCode)).toBeUndefined();
    expect((await bazarFeed()).item(property.refCode)).toBeUndefined();
    const state = await fx.db('portal_sync_state').where({ portal: 'realistimo' }).first();
    expect(state?.feed_changed_at).toBeInstanceOf(Date);
    expect(realistimo.feed.updated).toBe(
      formatSofiaDateTime(state?.feed_changed_at ?? new Date(0)),
    );
    expect(realistimo.res.headers['last-modified']).toBe(state?.feed_changed_at?.toUTCString());
  });

  it('DELETE of a property removed from Bazar.bg within the retention period schedules its deletion', async () => {
    const property = await createReadyProperty('Студио в Лозенец', 99_000);
    expect(
      (await api.post(`/properties/${property.id}/publish`, { portals: ['bazar'] })).status,
    ).toBe(202);
    await runWorkerOnce();
    expect((await api.post(`/properties/${property.id}/unpublish`, {})).status).toBe(202);
    await runWorkerOnce();

    const res = await request(fx.app).delete(`/api/properties/${property.id}`).set(auth);

    expect(res.status).toBe(202);
    expectDocumented(res, 'delete', '/properties/{id}');
    expect(res.body).toEqual({ data: { result: 'deletion_scheduled' } });
    expect((await bazarFeed()).item(property.refCode)).toMatchObject({
      'g:availability': 'out_of_stock',
    });
    expect(((await api.get(`/properties/${property.id}`)).body as PropertyDetailDto).status).toBe(
      'archived',
    );

    const later = new Date(Date.now() + (config.portals.bazar.removedRetentionDays + 1) * DAY_MS);
    await runWorkerOnce(() => later);

    expect((await api.get(`/properties/${property.id}`)).status).toBe(404);
    expect((await bazarFeed()).item(property.refCode)).toBeUndefined();
  });
});
