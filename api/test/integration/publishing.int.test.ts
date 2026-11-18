import { existsSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { collectUnusedPhotos } from '../../src/jobs/photo-gc.js';
import { finishRequestedDeletion } from '../../src/jobs/property-deletion.js';
import { LocalFileStorage } from '../../src/lib/storage.js';
import { createLogger } from '../../src/logger.js';
import type { ErrorBody } from '../../src/middleware/error-handler.js';
import type { JobDto } from '../../src/modules/jobs/jobs.mappers.js';
import type { PropertyImageDto } from '../../src/modules/images/images.mappers.js';
import type { PropertyDetailDto } from '../../src/modules/properties/properties.mappers.js';
import type {
  BulkDeleteItemDto,
  BulkPublishItemDto,
  PortalCheckDto,
  PortalDto,
  PublishResultDto,
} from '../../src/modules/publishing/publishing.mappers.js';
import { registryFrom, type PortalRegistry } from '../../src/portals/registry.js';
import type { PortalAdapter } from '../../src/portals/types.js';
import { testImage } from '../support/images.js';
import { expectDocumented } from '../support/openapi.js';
import {
  authHeader,
  closeApiFixture,
  fileForUrl,
  startApiFixture,
  type ApiFixture,
} from './api-fixture.js';
import {
  clearUnfinishedJobs,
  drain,
  fakeFeedPortal,
  insertListing,
  insertProperty,
  insertPublishedListing,
  jobRow,
  jobsOf,
  listingOf,
  listingRow,
  scriptedDemoRandom,
  testRegistry,
  testRunner,
  type ScriptedRandom,
} from './publishing-fixture.js';

let fx: ApiFixture;
let auth: { Authorization: string };
let demo: ScriptedRandom;
let registry: PortalRegistry;
let runner: ReturnType<typeof testRunner>;
/** Seeded properties by reference code. */
const seeded = new Map<string, number>();

beforeAll(async () => {
  demo = scriptedDemoRandom();
  registry = testRegistry(demo);
  fx = await startApiFixture({ registry });
  auth = await authHeader(fx.app);
  runner = testRunner(fx, registry);
  // The seeded queued and running jobs would compete with the tests' own jobs.
  await clearUnfinishedJobs(fx.db);
  for (const row of await fx.db('properties').select('id', 'ref_code')) {
    seeded.set(row.ref_code, row.id);
  }
});

afterAll(async () => {
  await closeApiFixture(fx);
});

beforeEach(() => {
  demo.reset();
});

const seededId = (refCode: string) => {
  const id = seeded.get(refCode);
  if (id === undefined) throw new Error(`${refCode} is not seeded`);
  return id;
};

const api = {
  get: (path: string) => request(fx.app).get(`/api${path}`).set(auth),
  post: (path: string, body?: object) => {
    const req = request(fx.app).post(`/api${path}`).set(auth);
    return body === undefined ? req : req.send(body);
  },
  patch: (path: string, body: object) => request(fx.app).patch(`/api${path}`).set(auth).send(body),
};

const jobCount = async () => Number((await fx.db('jobs').count({ n: '*' }).first())?.n ?? 0);

/**
 * Runs every due job of the test portals: the tests' own jobs (beforeAll cleared the seeded
 * ones; seed.int.test.ts runs those with the real adapters).
 */
const runQueue = () => drain(fx, runner, registry);

/** Lets the worker's photo sweep run as if two hours had passed (files are kept an hour). */
const sweepPhotos = () =>
  collectUnusedPhotos(fx.db, new LocalFileStorage(fx.uploadDir), createLogger(fx.config), {
    now: new Date(Date.now() + 2 * 3_600_000),
  });

/** The scripted demo adapter of the test registry. */
function demoAdapter(): PortalAdapter {
  const adapter = registry.get('demo');
  if (!adapter) throw new Error('The test registry has no demo portal');
  return adapter;
}

/** The app with another registry (same database), e.g. portals that keep removals in the feed. */
function appWith(other: PortalRegistry) {
  return createApp({
    config: fx.config,
    db: fx.db,
    logger: createLogger(fx.config),
    registry: other,
  });
}

describe('GET /api/portals', () => {
  it('lists the registered portals in order, with the feed URLs of feed portals', async () => {
    const res = await api.get('/portals');

    expect(res.status).toBe(200);
    expectDocumented(res, 'get', '/portals');
    const feedUrl = (key: string) =>
      `${fx.config.publicBaseUrl}/feeds/${key}/${fx.config.feeds.token}.xml`;
    expect((res.body as { data: PortalDto[] }).data).toEqual([
      { key: 'demo', displayName: 'Demo portal', mode: 'push', feedUrl: null },
      {
        key: 'realistimo',
        displayName: 'Fake realistimo',
        mode: 'feed',
        feedUrl: feedUrl('realistimo'),
      },
      { key: 'bazar', displayName: 'Fake bazar', mode: 'feed', feedUrl: feedUrl('bazar') },
    ]);
  });
});

describe('GET /api/properties/:id/checks', () => {
  it("runs every portal's rules and changes nothing", async () => {
    const id = seededId('IS-00009'); // no price, no photos
    const before = await jobCount();

    const res = await api.get(`/properties/${id}/checks`);

    expect(res.status).toBe(200);
    expectDocumented(res, 'get', '/properties/{id}/checks');
    expect((res.body as { data: PortalCheckDto[] }).data).toEqual([
      {
        portal: 'demo',
        displayName: 'Demo portal',
        ready: false,
        issues: [
          { field: 'price', message: 'The demo portal needs a price above 0.' },
          { field: 'images', message: 'The demo portal needs at least one photo.' },
        ],
      },
      { portal: 'realistimo', displayName: 'Fake realistimo', ready: true, issues: [] },
      { portal: 'bazar', displayName: 'Fake bazar', ready: true, issues: [] },
    ]);
    expect(await jobCount()).toBe(before);
  });

  it('checks only the portals asked for', async () => {
    const res = await api.get(`/properties/${seededId('IS-00001')}/checks?portals=bazar,demo`);

    expect(res.status).toBe(200);
    expect((res.body as { data: PortalCheckDto[] }).data.map((c) => [c.portal, c.ready])).toEqual([
      ['bazar', true],
      ['demo', true],
    ]);
  });

  it('answers 404 for an unknown property', async () => {
    const res = await api.get('/properties/999999/checks');

    expect(res.status).toBe(404);
    expectDocumented(res, 'get', '/properties/{id}/checks');
  });
});

describe('POST /api/properties/:id/publish', () => {
  it('answers 422 NOT_READY with every problem per portal, and queues nothing', async () => {
    const id = seededId('IS-00009');
    const before = await jobCount();

    const res = await api.post(`/properties/${id}/publish`, { portals: ['realistimo', 'demo'] });

    expect(res.status).toBe(422);
    expectDocumented(res, 'post', '/properties/{id}/publish');
    expect((res.body as ErrorBody).error).toEqual({
      code: 'NOT_READY',
      message:
        'Property IS-00009 is not ready for Demo portal: 2 problems to fix first (see details)',
      details: [
        { portal: 'demo', field: 'price', message: 'The demo portal needs a price above 0.' },
        { portal: 'demo', field: 'images', message: 'The demo portal needs at least one photo.' },
      ],
    });
    expect(await jobCount()).toBe(before);
    expect(await listingOf(fx, id, 'realistimo')).toBeUndefined();
    expect((await fx.db('properties').where({ id }).first())?.status).toBe('draft');
  });

  it('answers 409 for an archived property and 404 for an unknown one', async () => {
    const archived = await api.post(`/properties/${seededId('IS-00008')}/publish`, {
      portals: ['demo'],
    });
    const unknown = await api.post('/properties/999999/publish', { portals: ['demo'] });

    expect(archived.status).toBe(409);
    expectDocumented(archived, 'post', '/properties/{id}/publish');
    expect((archived.body as ErrorBody).error.message).toMatch(/IS-00008 is archived/);
    expect(unknown.status).toBe(404);
    expectDocumented(unknown, 'post', '/properties/{id}/publish');
  });

  it('makes a draft active, creates the listings and queues a publish job per portal', async () => {
    const id = await insertProperty(fx, { status: 'draft' });

    const res = await api.post(`/properties/${id}/publish`, { portals: ['demo', 'bazar'] });

    expect(res.status).toBe(202);
    expectDocumented(res, 'post', '/properties/{id}/publish');
    const { listings, jobs } = (res.body as { data: PublishResultDto }).data;
    expect(listings.map((l) => [l.portal, l.status])).toEqual([
      ['bazar', 'pending'],
      ['demo', 'pending'],
    ]);
    expect(jobs.map((j) => [j.listing.portal, j.action, j.status, j.attempts])).toEqual([
      ['demo', 'publish', 'queued', 0],
      ['bazar', 'publish', 'queued', 0],
    ]);
    expect(jobs[0]?.property).toMatchObject({ id });
    expect((await fx.db('properties').where({ id }).first())?.status).toBe('active');

    // Asking again while the jobs wait merges into them.
    const again = await api.post(`/properties/${id}/publish`, { portals: ['bazar', 'demo'] });
    expect(again.status).toBe(202);
    expect((again.body as { data: PublishResultDto }).data.jobs.map((j) => j.id).sort()).toEqual(
      jobs.map((j) => j.id).sort(),
    );

    await runQueue();
    const detail = (await api.get(`/properties/${id}`)).body as PropertyDetailDto;
    expect(detail.portals.map((l) => [l.portal, l.status])).toEqual([
      ['bazar', 'published'],
      ['demo', 'published'],
    ]);

    // Published listings get update jobs.
    const update = await api.post(`/properties/${id}/publish`, { portals: ['demo'] });
    expect((update.body as { data: PublishResultDto }).data.jobs.map((j) => j.action)).toEqual([
      'update',
    ]);
  });

  it('publishes a listing that failed before it was ever online, and updates one that is', async () => {
    const id = await insertProperty(fx);
    await insertListing(fx, id, 'demo', { status: 'error', last_error: 'Rejected' });
    const liveError = await insertListing(fx, id, 'bazar', {
      status: 'error',
      last_error: 'An update failed',
      published_at: new Date('2026-11-01T00:00:00Z'),
    });

    const res = await api.post(`/properties/${id}/publish`, { portals: ['demo', 'bazar'] });

    expect(res.status).toBe(202);
    const { jobs } = (res.body as { data: PublishResultDto }).data;
    expect(jobs.map((j) => [j.listing.portal, j.action])).toEqual([
      ['demo', 'publish'],
      ['bazar', 'update'],
    ]);
    expect((await listingRow(fx, liveError)).status).toBe('pending');
  });

  it('queues one job per portal when the same publish arrives many times at once', async () => {
    const id = await insertProperty(fx);

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        api.post(`/properties/${id}/publish`, { portals: ['demo', 'realistimo'] }),
      ),
    );

    expect(responses.map((res) => res.status)).toEqual(Array<number>(8).fill(202));
    for (const portal of ['demo', 'realistimo']) {
      const listing = await listingOf(fx, id, portal);
      expect(await jobsOf(fx.db, listing?.id ?? 0), portal).toHaveLength(1);
    }
  });
});

describe('POST /api/properties/:id/unpublish', () => {
  it('queues removals, deletes listings that never went out and leaves removed ones', async () => {
    const id = await insertProperty(fx);
    const live = await insertPublishedListing(fx, id, 'demo');
    const draft = await insertListing(fx, id, 'bazar');
    const removed = await insertListing(fx, id, 'realistimo', {
      status: 'removed',
      published_at: new Date('2026-10-01T00:00:00Z'),
      removed_at: new Date('2026-10-02T00:00:00Z'),
    });

    const res = await api.post(`/properties/${id}/unpublish`);

    expect(res.status).toBe(202);
    expectDocumented(res, 'post', '/properties/{id}/unpublish');
    const { listings, jobs } = (res.body as { data: PublishResultDto }).data;
    expect(listings.map((l) => [l.portal, l.status])).toEqual([
      ['demo', 'pending'],
      ['realistimo', 'removed'],
    ]);
    expect(jobs.map((j) => [j.listing.id, j.action])).toEqual([[live, 'remove']]);
    expect(await fx.db('portal_listings').where({ id: draft })).toEqual([]);
    expect(await jobsOf(fx.db, removed)).toEqual([]);

    await runQueue();
    expect((await listingRow(fx, live)).status).toBe('removed');
  });

  it('takes a listing whose first publish failed off at once, without a remove job', async () => {
    const id = await insertProperty(fx);
    await api.post(`/properties/${id}/publish`, { portals: ['demo'] });
    const listingId = (await listingOf(fx, id, 'demo'))?.id ?? 0;
    demo.answer('422');
    await runQueue();
    expect(await listingRow(fx, listingId)).toMatchObject({ status: 'error', published_at: null });
    const history = await jobsOf(fx.db, listingId);

    const res = await api.post(`/properties/${id}/unpublish`);

    expect(res.status).toBe(202);
    expectDocumented(res, 'post', '/properties/{id}/unpublish');
    const { listings, jobs } = (res.body as { data: PublishResultDto }).data;
    expect(jobs).toEqual([]);
    expect(listings.map((l) => [l.portal, l.status, l.lastError])).toEqual([
      ['demo', 'removed', null],
    ]);
    expect((await listingRow(fx, listingId)).removed_at).toBeInstanceOf(Date);
    // Its job history stays; nothing new was queued.
    expect(await jobsOf(fx.db, listingId)).toEqual(history);
  });

  it('only touches the portals given, and a removal replaces a publish that never ran', async () => {
    const id = await insertProperty(fx);
    await api.post(`/properties/${id}/publish`, { portals: ['demo', 'bazar'] });
    const demoListing = (await listingOf(fx, id, 'demo'))?.id ?? 0;
    const bazarListing = (await listingOf(fx, id, 'bazar'))?.id ?? 0;

    const res = await api.post(`/properties/${id}/unpublish`, { portals: ['demo'] });

    expect(res.status).toBe(202);
    expect((await jobsOf(fx.db, demoListing)).map((j) => [j.action, j.status])).toEqual([
      ['remove', 'queued'],
    ]);
    expect((await jobsOf(fx.db, bazarListing)).map((j) => j.action)).toEqual(['publish']);
  });

  it('answers 404 for an unknown property', async () => {
    const res = await api.post('/properties/999999/unpublish', { portals: ['demo'] });

    expect(res.status).toBe(404);
    expectDocumented(res, 'post', '/properties/{id}/unpublish');
  });
});

describe('POST /api/properties/bulk/publish', () => {
  it('publishes the ready ones and reports the others, in the order given', async () => {
    const ready = await insertProperty(fx, { status: 'draft' });
    const notReady = await insertProperty(fx, { photos: 0 });
    const archived = seededId('IS-00008');

    const res = await api.post('/properties/bulk/publish', {
      propertyIds: [ready, notReady, 999_999, archived],
      portals: ['demo'],
    });

    expect(res.status).toBe(200);
    expectDocumented(res, 'post', '/properties/bulk/publish');
    const [first, second, third, fourth] = (res.body as { data: BulkPublishItemDto[] }).data;
    expect(first).toMatchObject({ propertyId: ready, ok: true });
    expect(first?.jobs?.map((j) => [j.action, j.listing.portal])).toEqual([['publish', 'demo']]);
    expect(second).toEqual({
      propertyId: notReady,
      ok: false,
      issues: [
        { portal: 'demo', field: 'images', message: 'The demo portal needs at least one photo.' },
      ],
      error: {
        code: 'NOT_READY',
        message: expect.stringContaining('1 problem to fix first') as string,
      },
    });
    expect(third).toMatchObject({ propertyId: 999_999, ok: false, error: { code: 'NOT_FOUND' } });
    expect(fourth).toMatchObject({ propertyId: archived, ok: false, error: { code: 'CONFLICT' } });
    expect(await listingOf(fx, notReady, 'demo')).toBeUndefined();
  });

  it('reports an unexpected error for its property and goes on with the others', async () => {
    const broken = await insertProperty(fx, { title: 'boom' });
    const fine = await insertProperty(fx);
    const exploding = registryFrom([
      {
        adapter: {
          ...demoAdapter(),
          validate: (property) => {
            if (property.title === 'boom') throw new Error('connection lost (simulated)');
            return [];
          },
        },
      },
    ]);

    const res = await request(appWith(exploding))
      .post('/api/properties/bulk/publish')
      .set(auth)
      .send({ propertyIds: [broken, fine], portals: ['demo'] });

    expect(res.status).toBe(200);
    expectDocumented(res, 'post', '/properties/bulk/publish');
    const [first, second] = (res.body as { data: BulkPublishItemDto[] }).data;
    expect(first).toEqual({
      propertyId: broken,
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
    expect(second).toMatchObject({ propertyId: fine, ok: true });
    expect(await listingOf(fx, broken, 'demo')).toBeUndefined();
    expect((await listingOf(fx, fine, 'demo'))?.status).toBe('pending');
    await clearUnfinishedJobs(fx.db);
  });
});

describe('POST /api/properties/bulk/delete', () => {
  it('deletes what is not online, and archives the rest until the portals removed it', async () => {
    const offline = await insertProperty(fx, { photos: 2 });
    await insertListing(fx, offline, 'bazar');
    const online = await insertProperty(fx, { photos: 1 });
    const onlineListing = await insertPublishedListing(fx, online, 'demo');
    const offlineFiles = (
      await fx.db('property_images').where({ property_id: offline }).pluck('url')
    ).map((url) => fileForUrl(fx, url));
    const onlineFiles = (
      await fx.db('property_images').where({ property_id: online }).pluck('url')
    ).map((url) => fileForUrl(fx, url));

    const res = await api.post('/properties/bulk/delete', {
      propertyIds: [offline, online, 999_999],
    });

    expect(res.status).toBe(200);
    expectDocumented(res, 'post', '/properties/bulk/delete');
    expect((res.body as { data: BulkDeleteItemDto[] }).data).toEqual([
      { propertyId: offline, result: 'deleted' },
      { propertyId: online, result: 'removal_queued' },
      { propertyId: 999_999, result: 'not_found' },
    ]);
    expect(await fx.db('properties').where({ id: offline })).toEqual([]);
    // The files go with the worker's photo sweep, once nothing refers to them.
    for (const file of offlineFiles) expect(existsSync(file)).toBe(true);
    await sweepPhotos();
    for (const file of offlineFiles) expect(existsSync(file)).toBe(false);
    const archived = await fx.db('properties').where({ id: online }).first();
    expect(archived?.status).toBe('archived');
    expect(archived?.delete_requested_at).toBeInstanceOf(Date);
    expect((await jobsOf(fx.db, onlineListing)).map((j) => [j.action, j.status])).toEqual([
      ['remove', 'queued'],
    ]);
    // A plain DELETE is still refused while the removal is pending.
    expect((await request(fx.app).delete(`/api/properties/${online}`).set(auth)).status).toBe(409);

    // Publishing it again is refused: it is archived and waiting to be deleted.
    const publish = await api.post(`/properties/${online}/publish`, { portals: ['demo'] });
    expect(publish.status).toBe(409);
    expect((publish.body as ErrorBody).error.message).toMatch(
      /archived and waiting to be deleted; to keep it, set its status to active \(this cancels the deletion\)/,
    );

    const reports = await runQueue();

    expect(reports.find((r) => r.propertyDeleted)).toBeDefined();
    expect(await fx.db('properties').where({ id: online })).toEqual([]);
    for (const file of onlineFiles) expect(existsSync(file)).toBe(true);
    await sweepPhotos();
    for (const file of onlineFiles) expect(existsSync(file)).toBe(false);
  });

  it('setting the status back to active cancels the deletion for good', async () => {
    const id = await insertProperty(fx, { photos: 1 });
    const listingId = await insertPublishedListing(fx, id, 'demo');
    const deleted = await api.post('/properties/bulk/delete', { propertyIds: [id] });
    expect((deleted.body as { data: BulkDeleteItemDto[] }).data).toEqual([
      { propertyId: id, result: 'removal_queued' },
    ]);

    // The broker changes their mind before the removal has run.
    const patch = await api.patch(`/properties/${id}`, { status: 'active' });
    expect(patch.status).toBe(200);
    expect(await fx.db('properties').where({ id }).first()).toMatchObject({
      status: 'active',
      delete_requested_at: null,
    });
    const publish = await api.post(`/properties/${id}/publish`, { portals: ['demo'] });
    expect(publish.status).toBe(202);
    await runQueue();
    expect((await listingRow(fx, listingId)).status).toBe('published');

    // Weeks later an ordinary unpublish: the listing comes off, the property stays.
    await api.post(`/properties/${id}/unpublish`);
    const reports = await runQueue();

    expect(reports.map((report) => report.propertyDeleted)).toEqual([false]);
    expect((await listingRow(fx, listingId)).status).toBe('removed');
    expect(await fx.db('properties').where({ id }).first()).toMatchObject({ status: 'active' });
    // Archiving it again by hand does not bring the old deletion back either.
    await api.patch(`/properties/${id}`, { status: 'archived' });
    expect(
      await finishRequestedDeletion(fx.db, createLogger(fx.config), id, {
        removedRetentionDays: new Map(),
      }),
    ).toBe(false);
    expect(await fx.db('properties').where({ id })).toHaveLength(1);
  });

  it('schedules the deletion of a property whose feed still serves its removal', async () => {
    const retaining = registryFrom([
      { adapter: demoAdapter() },
      { ...fakeFeedPortal('bazar'), removedRetentionDays: 30 },
    ]);
    const app = appWith(retaining);
    const removedAt = new Date(Date.now() - 2 * 86_400_000);
    const tombstoneOf = async (propertyId: number) =>
      insertListing(fx, propertyId, 'bazar', {
        status: 'removed',
        published_at: new Date(Date.now() - 20 * 86_400_000),
        removed_at: removedAt,
        payload: JSON.stringify({ ref: 'x', removed: true }),
        payload_updated_at: removedAt,
      });
    const bulk = await insertProperty(fx);
    await tombstoneOf(bulk);
    const single = await insertProperty(fx);
    await tombstoneOf(single);
    const old = await insertProperty(fx);
    const oldListing = await tombstoneOf(old);
    // Removed 31 days ago: past the retention period, so it may go now.
    await fx
      .db('portal_listings')
      .where({ id: oldListing })
      .update({ payload_updated_at: new Date(Date.now() - 31 * 86_400_000) });

    const res = await request(app)
      .post('/api/properties/bulk/delete')
      .set(auth)
      .send({ propertyIds: [bulk, old] });
    const del = await request(app).delete(`/api/properties/${single}`).set(auth);

    expect((res.body as { data: BulkDeleteItemDto[] }).data).toEqual([
      { propertyId: bulk, result: 'deletion_scheduled' },
      { propertyId: old, result: 'deleted' },
    ]);
    expectDocumented(res, 'post', '/properties/bulk/delete');
    expect(del.status).toBe(202);
    expectDocumented(del, 'delete', '/properties/{id}');
    expect(del.body).toEqual({ data: { result: 'deletion_scheduled' } });
    for (const id of [bulk, single]) {
      expect(await fx.db('properties').where({ id }).first()).toMatchObject({
        status: 'archived',
        delete_requested_at: expect.any(Date) as Date,
      });
      // No removal is queued: nothing is online.
      expect(
        await fx
          .db('jobs')
          .join('portal_listings', 'portal_listings.id', 'jobs.portal_listing_id')
          .where('portal_listings.property_id', id),
      ).toEqual([]);
    }
    expect(await fx.db('properties').where({ id: old })).toEqual([]);

    // The property says what it is waiting for and when it goes.
    const detail = await request(app).get(`/api/properties/${single}`).set(auth);
    expectDocumented(detail, 'get', '/properties/{id}');
    const served = await fx.db('portal_listings').where({ property_id: single }).first();
    expect((detail.body as PropertyDetailDto).deletion).toEqual({
      requestedAt: expect.any(String) as string,
      state: 'feed_retention',
      portals: ['bazar'],
      deletesAfter: new Date(
        (served as { payload_updated_at: Date }).payload_updated_at.getTime() + 30 * 86_400_000,
      ).toISOString(),
    });
  });

  it('reports an unexpected error for its property and goes on with the others', async () => {
    const broken = await insertProperty(fx);
    await insertListing(fx, broken, 'bazar', {
      status: 'removed',
      published_at: new Date('2026-11-01T10:00:00Z'),
      removed_at: new Date(),
      payload: JSON.stringify({ ref: 'x' }),
      payload_updated_at: new Date(),
    });
    const fine = await insertProperty(fx);
    // Reading the retention period of the broken property's portal fails (a stand-in for a
    // lost connection or another error that is not the API's own).
    const failing: PortalRegistry = {
      ...registry,
      removedRetentionDays: new Map([['bazar', 30]]),
    };
    failing.removedRetentionDays.get = () => {
      throw new Error('connection lost (simulated)');
    };

    const res = await request(appWith(failing))
      .post('/api/properties/bulk/delete')
      .set(auth)
      .send({ propertyIds: [broken, fine] });

    expect(res.status).toBe(200);
    expectDocumented(res, 'post', '/properties/bulk/delete');
    expect((res.body as { data: BulkDeleteItemDto[] }).data).toEqual([
      {
        propertyId: broken,
        result: 'error',
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      },
      { propertyId: fine, result: 'deleted' },
    ]);
    expect(await fx.db('properties').where({ id: broken })).toHaveLength(1);
    expect(await fx.db('properties').where({ id: fine })).toEqual([]);
  });
});

describe('edits queue update jobs', () => {
  /** A property published on the demo portal, with nothing queued. */
  async function publishedProperty() {
    const id = await insertProperty(fx, { photos: 2 });
    const listingId = await insertPublishedListing(fx, id, 'demo');
    const draftListing = await insertListing(fx, id, 'bazar');
    return { id, listingId, draftListing };
  }

  const actions = async (listingId: number) =>
    (await jobsOf(fx.db, listingId)).map((job) => [job.action, job.status]);

  it('PATCH with a real change queues an update for the published listing only', async () => {
    const { id, listingId, draftListing } = await publishedProperty();

    const res = await api.patch(`/properties/${id}`, { price: 99_000 });

    expect(res.status).toBe(200);
    expectDocumented(res, 'patch', '/properties/{id}');
    expect(await actions(listingId)).toEqual([['update', 'queued']]);
    expect((await listingRow(fx, listingId)).status).toBe('pending');
    expect(await jobsOf(fx.db, draftListing)).toEqual([]);

    // A second edit merges into the waiting update.
    await api.patch(`/properties/${id}`, { title: 'Ново заглавие' });
    expect(await actions(listingId)).toEqual([['update', 'queued']]);
  });

  it('PATCH without a change to what portals show queues nothing', async () => {
    const { id, listingId } = await publishedProperty();
    const current = await fx.db('properties').where({ id }).first();

    const same = await api.patch(`/properties/${id}`, {
      price: current?.price,
      title: current?.title,
    });
    const statusOnly = await api.patch(`/properties/${id}`, { status: 'active' });

    expect([same.status, statusOnly.status]).toEqual([200, 200]);
    expect(await jobsOf(fx.db, listingId)).toEqual([]);
    expect((await listingRow(fx, listingId)).status).toBe('published');
  });

  it('a photo upload, a new order and a deleted photo each queue an update', async () => {
    const { id, listingId } = await publishedProperty();

    const upload = await request(fx.app)
      .post(`/api/properties/${id}/images`)
      .set(auth)
      .attach('photos', await testImage({ width: 800, height: 600 }), 'new.jpg');
    expect(upload.status).toBe(201);
    expect(await actions(listingId)).toEqual([['update', 'queued']]);
    await runQueue();

    const images = (await api.get(`/properties/${id}`)).body as PropertyDetailDto;
    const ids = images.images.map((image: PropertyImageDto) => image.id);
    const reorder = await request(fx.app)
      .put(`/api/properties/${id}/images/order`)
      .set(auth)
      .send({ imageIds: [...ids].reverse() });
    expect(reorder.status).toBe(200);
    expect((await actions(listingId)).at(-1)).toEqual(['update', 'queued']);
    await runQueue();

    // The same order again changes nothing.
    await request(fx.app)
      .put(`/api/properties/${id}/images/order`)
      .set(auth)
      .send({ imageIds: [...ids].reverse() });
    expect((await actions(listingId)).at(-1)).toEqual(['update', 'succeeded']);

    const removed = await request(fx.app)
      .delete(`/api/properties/${id}/images/${ids[0] ?? 0}`)
      .set(auth);
    expect(removed.status).toBe(204);
    expect((await actions(listingId)).at(-1)).toEqual(['update', 'queued']);
    expect(await jobsOf(fx.db, listingId)).toHaveLength(3);
  });

  it('an edit while a publish waits merges into it', async () => {
    const id = await insertProperty(fx);
    await api.post(`/properties/${id}/publish`, { portals: ['demo'] });
    const listingId = (await listingOf(fx, id, 'demo'))?.id ?? 0;

    await api.patch(`/properties/${id}`, { price: 123_456 });

    expect(await actions(listingId)).toEqual([['publish', 'queued']]);
  });
});

describe('job log and retry', () => {
  /** A property whose demo publish failed for good (HTTP 422). */
  async function failedPublish() {
    // Earlier tests' jobs first, so the scripted failure goes to this property's job.
    await runQueue();
    const id = await insertProperty(fx);
    await api.post(`/properties/${id}/publish`, { portals: ['demo'] });
    const listingId = (await listingOf(fx, id, 'demo'))?.id ?? 0;
    demo.answer('422');
    await runQueue();
    const [job] = await jobsOf(fx.db, listingId);
    expect(job?.status).toBe('failed');
    return { id, listingId, jobId: job?.id ?? 0 };
  }

  it('lists jobs newest first with their listing and property, paginated', async () => {
    const res = await api.get('/jobs?pageSize=5');

    expect(res.status).toBe(200);
    expectDocumented(res, 'get', '/jobs');
    const body = res.body as { data: JobDto[]; meta: { total: number; pageSize: number } };
    expect(body.data).toHaveLength(5);
    expect(body.meta).toMatchObject({ page: 1, pageSize: 5 });
    expect(body.meta.total).toBeGreaterThan(20);
    const created = body.data.map((job) => job.createdAt);
    expect([...created].sort().reverse()).toEqual(created);
    expect(body.data[0]?.listing).toEqual({
      id: expect.any(Number) as number,
      portal: expect.any(String) as string,
      status: expect.any(String) as string,
    });

    const page2 = await api.get('/jobs?pageSize=5&page=2&sort=id');
    const ids = (page2.body as { data: JobDto[] }).data.map((job) => job.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('filters by status, portal, action and property', async () => {
    const id = seededId('IS-00001');
    const failedDemo = await api.get('/jobs?status=failed&portal=demo');
    const forProperty = await api.get(`/jobs?propertyId=${id}&action=publish,update`);

    expect(failedDemo.status).toBe(200);
    const failed = (failedDemo.body as { data: JobDto[] }).data;
    expect(failed.length).toBeGreaterThan(0);
    for (const job of failed) expect([job.status, job.listing.portal]).toEqual(['failed', 'demo']);
    const own = (forProperty.body as { data: JobDto[] }).data;
    expect(own.length).toBeGreaterThanOrEqual(4);
    for (const job of own) {
      expect(job.property?.refCode).toBe('IS-00001');
      expect(['publish', 'update']).toContain(job.action);
    }
  });

  it('returns one job, or 404', async () => {
    const { jobId } = await failedPublish();

    const res = await api.get(`/jobs/${jobId}`);
    const missing = await api.get('/jobs/99999999');

    expect(res.status).toBe(200);
    expectDocumented(res, 'get', '/jobs/{id}');
    expect((res.body as { data: JobDto }).data).toMatchObject({
      id: jobId,
      action: 'publish',
      status: 'failed',
      attempts: 1,
      maxAttempts: 5,
      lockedAt: null,
      lockedBy: null,
      result: { retryable: false, httpStatus: 422 },
    });
    expect(missing.status).toBe(404);
    expectDocumented(missing, 'get', '/jobs/{id}');
  });

  it('retries a failed job as a new job; the failed one stays in the log', async () => {
    const { listingId, jobId } = await failedPublish();

    const res = await api.post(`/jobs/${jobId}/retry`);

    expect(res.status).toBe(202);
    expectDocumented(res, 'post', '/jobs/{id}/retry');
    const retried = (res.body as { data: JobDto }).data;
    expect(retried).toMatchObject({
      action: 'publish',
      status: 'queued',
      attempts: 0,
      listing: { id: listingId, portal: 'demo', status: 'pending' },
    });
    expect(retried.id).toBeGreaterThan(jobId);
    expect((await jobRow(fx.db, jobId)).status).toBe('failed');

    // Retrying the old job again: a newer job exists.
    const again = await api.post(`/jobs/${jobId}/retry`);
    expect(again.status).toBe(409);
    expectDocumented(again, 'post', '/jobs/{id}/retry');

    await runQueue();
    expect((await listingRow(fx, listingId)).status).toBe('published');
    // A succeeded job cannot be retried.
    const succeeded = await api.post(`/jobs/${retried.id}/retry`);
    expect(succeeded.status).toBe(409);
    expect((succeeded.body as ErrorBody).error.message).toMatch(/only a failed job can be retried/);
  });

  it('refuses to retry while another job of the listing is unfinished, or for an archived property', async () => {
    const { id, listingId, jobId } = await failedPublish();
    await fx.db('jobs').insert({ portal_listing_id: listingId, action: 'remove' });

    const busy = await api.post(`/jobs/${jobId}/retry`);
    expect(busy.status).toBe(409);
    expect((busy.body as ErrorBody).error.message).toMatch(/is queued; wait until it has finished/);

    await fx.db('jobs').where({ portal_listing_id: listingId, action: 'remove' }).delete();
    await fx.db('properties').where({ id }).update({ status: 'archived' });
    const archived = await api.post(`/jobs/${jobId}/retry`);
    expect(archived.status).toBe(409);
    expect((archived.body as ErrorBody).error.message).toMatch(/is archived/);
  });

  it('answers 404 when retrying an unknown job', async () => {
    const res = await api.post('/jobs/99999999/retry');

    expect(res.status).toBe(404);
    expectDocumented(res, 'post', '/jobs/{id}/retry');
  });
});
