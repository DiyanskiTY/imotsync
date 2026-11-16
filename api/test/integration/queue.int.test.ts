import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_ROOT } from '../../src/config.js';
import { createDb } from '../../src/db/knex.js';
import type { JobRow } from '../../src/db/types.js';
import { claimNextJob } from '../../src/jobs/claim.js';
import {
  enqueueListingJob,
  enqueueUpdatesForProperty,
  type EnqueueIntent,
} from '../../src/jobs/enqueue.js';
import { UNEXPECTED_ERROR_MESSAGE } from '../../src/jobs/failure.js';
import { recordSuccess } from '../../src/jobs/outcome.js';
import { collectUnusedPhotos } from '../../src/jobs/photo-gc.js';
import {
  finishPendingDeletions,
  finishRequestedDeletion,
} from '../../src/jobs/property-deletion.js';
import { sweepStaleJobs } from '../../src/jobs/sweep.js';
import { queueTransaction } from '../../src/jobs/transaction.js';
import { createWorker } from '../../src/jobs/worker.js';
import { LocalFileStorage } from '../../src/lib/storage.js';
import { createLogger } from '../../src/logger.js';
import { feedLastChanged, loadFeedItems } from '../../src/portals/feed-items.js';
import { registryFrom, type PortalRegistry } from '../../src/portals/registry.js';
import type { AdapterContext, PortalAdapter, PortalListingInfo } from '../../src/portals/types.js';
import { closeApiFixture, startApiFixture, type ApiFixture } from './api-fixture.js';
import {
  clearUnfinishedJobs,
  insertListing,
  insertProperty,
  insertPublishedListing,
  jobRow,
  jobsOf,
  listingRow,
  makeDue,
  runNext,
  scriptedDemoRandom,
  secondsUntilDue,
  testRegistry,
  testRunner,
  TEST_RETRY,
  type ScriptedRandom,
} from './publishing-fixture.js';

let fx: ApiFixture;
let demo: ScriptedRandom;
let registry: PortalRegistry;
let runner: ReturnType<typeof testRunner>;
let storage: LocalFileStorage;
const logger = createLogger({ nodeEnv: 'test' });
const hoursLater = (hours: number) => new Date(Date.now() + hours * 3_600_000);

beforeAll(async () => {
  fx = await startApiFixture();
  demo = scriptedDemoRandom();
  registry = testRegistry(demo);
  runner = testRunner(fx, registry);
  storage = new LocalFileStorage(fx.uploadDir);
});

afterAll(async () => {
  await closeApiFixture(fx);
});

beforeEach(async () => {
  // Every test controls the whole queue: the seeded jobs and earlier tests' leftovers go.
  await clearUnfinishedJobs(fx.db);
  demo.reset();
});

const enqueue = (listingId: number, intent: EnqueueIntent) =>
  queueTransaction(fx.db, (trx) => enqueueListingJob(trx, listingId, intent));

/** A new property with a draft listing on the portal; returns both ids. */
async function newListing(portal = 'demo') {
  const propertyId = await insertProperty(fx);
  const listingId = await insertListing(fx, propertyId, portal);
  return { propertyId, listingId };
}

const unfinished = async (listingId: number) =>
  (await jobsOf(fx.db, listingId)).filter((job) => ['queued', 'running'].includes(job.status));

const claim = (workerId = 'test-host:1:aaaaaa') =>
  claimNextJob(fx.db, { workerId, portals: registry.keys() });

describe('enqueue rules', () => {
  it('creates one publish job for a new listing and moves the listing to pending', async () => {
    const { listingId } = await newListing();

    const result = await enqueue(listingId, 'publish');

    expect(result.effect).toBe('created');
    expect(result.job).toMatchObject({ action: 'publish', status: 'queued', attempts: 0 });
    expect(result.listing.status).toBe('pending');
    expect(await jobsOf(fx.db, listingId)).toHaveLength(1);
  });

  it('merges into a queued job, and a removal replaces a job that never ran', async () => {
    const { listingId } = await newListing();
    const first = await enqueue(listingId, 'publish');

    const again = await enqueue(listingId, 'publish');
    const edit = await enqueue(listingId, 'update');
    const removal = await enqueue(listingId, 'remove');

    expect([again.effect, edit.effect, removal.effect]).toEqual(['merged', 'merged', 'replaced']);
    expect(again.job?.id).toBe(first.job?.id);
    const jobs = await jobsOf(fx.db, listingId);
    expect(jobs.map((job) => [job.id, job.action, job.status])).toEqual([
      [first.job?.id, 'remove', 'queued'],
    ]);
  });

  it('queues one job behind a running one, never a third', async () => {
    const { listingId } = await newListing();
    await enqueue(listingId, 'publish');
    const running = await claim();
    expect(running?.portal_listing_id).toBe(listingId);

    const behind = await enqueue(listingId, 'update');
    const merged = await enqueue(listingId, 'update');
    const replaced = await enqueue(listingId, 'remove');
    const backAgain = await enqueue(listingId, 'publish');

    expect([behind.effect, merged.effect, replaced.effect, backAgain.effect]).toEqual([
      'created',
      'merged',
      'replaced',
      'replaced',
    ]);
    const jobs = await jobsOf(fx.db, listingId);
    expect(jobs.map((job) => [job.action, job.status])).toEqual([
      ['publish', 'running'],
      ['publish', 'queued'],
    ]);
  });

  it('queues a removal behind a publish that waits for a retry, and runs them in order', async () => {
    const { listingId } = await newListing();
    await enqueue(listingId, 'publish');
    demo.answer('503');
    expect((await runNext(fx, runner, registry))?.recordedAs).toBe('retrying');

    const removal = await enqueue(listingId, 'remove');
    expect(removal.effect).toBe('created');
    const [publish, remove] = await jobsOf(fx.db, listingId);
    expect([publish?.action, publish?.attempts, remove?.action]).toEqual(['publish', 1, 'remove']);

    // The removal is due, but waits behind the publish until it has finished.
    expect(await claim()).toBeNull();
    await makeDue(fx.db, publish?.id ?? 0);
    const first = await claim();
    expect(first?.id).toBe(publish?.id);
    expect(await claim()).toBeNull();
    await runner.runJob(first!);
    expect((await claim())?.id).toBe(remove?.id);
  });

  it('queues no removal for a listing that never reached the portal', async () => {
    const { listingId } = await newListing();
    await enqueue(listingId, 'publish');
    demo.answer('422');
    expect((await runNext(fx, runner, registry))?.recordedAs).toBe('failed');
    expect(await listingRow(fx, listingId)).toMatchObject({ status: 'error', published_at: null });

    const removal = await enqueue(listingId, 'remove');

    expect(removal).toMatchObject({ effect: 'skipped', job: null });
    expect(removal.reason).toMatch(/nothing to remove/);
    expect((await jobsOf(fx.db, listingId)).map((job) => job.action)).toEqual(['publish']);
  });

  it('a publish merged into a queued update becomes a publish, and publishes', async () => {
    // A first publish is running; an edit queues an update behind it; the publish then
    // fails for good, so the listing never reached the portal.
    const { propertyId, listingId } = await newListing();
    await enqueue(listingId, 'publish');
    const first = (await claim())!;
    const edit = await enqueue(listingId, 'update');
    expect(edit.job?.action).toBe('update');
    demo.answer('422');
    expect((await runner.runJob(first)).recordedAs).toBe('failed');
    // A newer job waits, so the failed one leaves the listing pending.
    expect(await listingRow(fx, listingId)).toMatchObject({
      status: 'pending',
      published_at: null,
    });

    const publish = await enqueue(listingId, 'publish');

    expect(publish).toMatchObject({
      effect: 'replaced',
      job: { id: edit.job?.id, action: 'publish' },
    });
    const report = await runNext(fx, runner, registry);
    expect(report).toMatchObject({ jobId: edit.job?.id, recordedAs: 'succeeded' });
    const externalId = `demo-${String(propertyId).padStart(6, '0')}`;
    expect((await jobRow(fx.db, edit.job?.id ?? 0)).result).toMatchObject({
      message: `Published on the demo portal as ${externalId} (simulated)`,
    });
    expect(await listingRow(fx, listingId)).toMatchObject({
      status: 'published',
      external_id: externalId,
    });
  });

  it('ignores an edit of a listing that is not published', async () => {
    const { listingId } = await newListing();

    const result = await enqueue(listingId, 'update');

    expect(result).toMatchObject({ effect: 'skipped', job: null });
    expect((await listingRow(fx, listingId)).status).toBe('draft');
    expect(await jobsOf(fx.db, listingId)).toEqual([]);
  });

  it('queues edits for published listings and merges them into pending ones', async () => {
    const propertyId = await insertProperty(fx);
    const published = await insertPublishedListing(fx, propertyId, 'demo');
    const draft = await insertListing(fx, propertyId, 'realistimo');
    const pending = await insertListing(fx, propertyId, 'bazar');
    const queued = await enqueue(pending, 'publish');

    const results = await queueTransaction(fx.db, (trx) =>
      enqueueUpdatesForProperty(trx, propertyId),
    );

    expect(results.map((result) => [result.listing.portal, result.effect])).toEqual([
      ['bazar', 'merged'],
      ['demo', 'created'],
    ]);
    expect((await jobsOf(fx.db, published)).map((job) => job.action)).toEqual(['update']);
    expect((await listingRow(fx, published)).status).toBe('pending');
    expect(await jobsOf(fx.db, draft)).toEqual([]);
    expect((await jobsOf(fx.db, pending)).map((job) => job.id)).toEqual([queued.job?.id]);
  });

  it('queues edits for a listing in error that is still online, not for one being removed', async () => {
    const propertyId = await insertProperty(fx);
    // An update failed (or the portal reported an import error): the old version is online.
    const failedUpdate = await insertListing(fx, propertyId, 'demo', {
      status: 'error',
      published_at: new Date('2026-11-01T10:00:00Z'),
      last_error: 'The demo portal rejected the listing',
    });
    // Its removal failed: it was meant to go, so an edit must not bring it back.
    const failedRemoval = await insertListing(fx, propertyId, 'bazar', {
      status: 'error',
      published_at: new Date('2026-11-01T10:00:00Z'),
    });
    await fx.db('jobs').insert({
      portal_listing_id: failedRemoval,
      action: 'remove',
      status: 'failed',
      attempts: 1,
    });
    // A first publish that failed: never online.
    const neverOnline = await insertListing(fx, propertyId, 'realistimo', { status: 'error' });

    const results = await queueTransaction(fx.db, (trx) =>
      enqueueUpdatesForProperty(trx, propertyId),
    );

    expect(results.map((result) => [result.listing.portal, result.effect])).toEqual([
      ['demo', 'created'],
    ]);
    expect((await jobsOf(fx.db, failedUpdate)).map((job) => job.action)).toEqual(['update']);
    expect((await listingRow(fx, failedUpdate)).status).toBe('pending');
    expect((await listingRow(fx, failedRemoval)).status).toBe('error');
    expect(await jobsOf(fx.db, neverOnline)).toEqual([]);
  });
});

describe('enqueue under concurrency', () => {
  it('twenty simultaneous publish requests for one listing leave exactly one job', async () => {
    const { listingId } = await newListing();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => enqueue(listingId, 'publish')),
    );

    expect(results.filter((result) => result.effect === 'created')).toHaveLength(1);
    expect(new Set(results.map((result) => result.job?.id)).size).toBe(1);
    expect(await jobsOf(fx.db, listingId)).toHaveLength(1);
  });

  it('simultaneous requests for many new listings neither deadlock nor duplicate', async () => {
    const listingIds: number[] = [];
    for (let i = 0; i < 12; i++) listingIds.push((await newListing()).listingId);

    await Promise.all(
      [...listingIds, ...listingIds].map((listingId) => enqueue(listingId, 'publish')),
    );

    for (const listingId of listingIds) {
      expect(await jobsOf(fx.db, listingId), `listing ${listingId}`).toHaveLength(1);
    }
  });

  it('a claim racing a removal: the removal replaces the publish only if it never started', async () => {
    for (let round = 0; round < 12; round++) {
      const { listingId } = await newListing();
      const { job: publish } = await enqueue(listingId, 'publish');

      const [claimed, removal] = await Promise.all([
        claim(`race:${round}:x`),
        enqueue(listingId, 'remove'),
      ]);

      const jobs = await unfinished(listingId);
      const running = jobs.filter((job) => job.status === 'running');
      expect(running.length, `round ${round}`).toBeLessThanOrEqual(1);
      if (removal.effect === 'replaced') {
        // The publish never ran: it became the removal (and may have been claimed as one).
        expect(jobs.map((job) => [job.id, job.action])).toEqual([[publish?.id, 'remove']]);
        if (claimed) expect(claimed).toMatchObject({ id: publish?.id, action: 'remove' });
      } else {
        // The worker claimed the publish first: the removal waits behind it.
        expect(removal.effect).toBe('created');
        expect(claimed).toMatchObject({ id: publish?.id, action: 'publish' });
        expect(jobs.map((job) => [job.action, job.status])).toEqual([
          ['publish', 'running'],
          ['remove', 'queued'],
        ]);
      }
      // A running job always does what it was claimed for.
      for (const job of running) expect(job.action).toBe(claimed?.action);
      await clearUnfinishedJobs(fx.db);
    }
  });

  it('simultaneous edits and removals behind a running job keep at most two unfinished jobs', async () => {
    const { listingId } = await newListing();
    await enqueue(listingId, 'publish');
    await claim();

    const intents: EnqueueIntent[] = ['update', 'remove', 'publish', 'update', 'remove', 'update'];
    await Promise.all([...intents, ...intents].map((intent) => enqueue(listingId, intent)));

    const jobs = await unfinished(listingId);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.status).toBe('running');
    expect(jobs[1]?.status).toBe('queued');
  });
});

describe('claiming jobs', () => {
  it('marks the job running with attempts + 1, the worker id and the lock time', async () => {
    const { listingId } = await newListing();
    const { job } = await enqueue(listingId, 'publish');

    const claimed = await claim('host-a:42:abcdef');

    expect(claimed).toMatchObject({
      id: job?.id,
      status: 'running',
      attempts: 1,
      locked_by: 'host-a:42:abcdef',
    });
    expect(claimed?.locked_at).toBeInstanceOf(Date);
  });

  it('two workers never claim the same job', async () => {
    const jobIds: number[] = [];
    for (let i = 0; i < 6; i++) {
      const { listingId } = await newListing();
      jobIds.push((await enqueue(listingId, 'publish')).job?.id ?? 0);
    }

    const claims = await Promise.all(
      Array.from({ length: 14 }, (_, i) => claim(`worker-${i % 2}:1:${String(i)}`)),
    );

    const claimed = claims.filter((job): job is JobRow => job !== null);
    expect(claimed.map((job) => job.id).sort((a, b) => a - b)).toEqual(jobIds);
    for (const job of claimed) {
      const row = await jobRow(fx.db, job.id);
      expect([row.status, row.attempts, row.locked_by]).toEqual(['running', 1, job.locked_by]);
    }
  });

  it('never starts two jobs of one listing, even when both are due', async () => {
    const { listingId } = await newListing();
    // Two due jobs of one listing (a retrying publish and a removal behind it).
    await enqueue(listingId, 'publish');
    demo.answer('503');
    await runNext(fx, runner, registry);
    await enqueue(listingId, 'remove');
    const [older, newer] = await jobsOf(fx.db, listingId);
    await makeDue(fx.db, older?.id ?? 0);

    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => claim(`w:${i}:x`)));

    const claimed = claims.filter((job) => job !== null);
    expect(claimed.map((job) => job.id)).toEqual([older?.id]);
    expect((await jobRow(fx.db, newer?.id ?? 0)).status).toBe('queued');
  });

  it('does not claim a job before its run_after', async () => {
    const { listingId } = await newListing();
    const { job } = await enqueue(listingId, 'publish');
    await fx
      .db('jobs')
      .where({ id: job?.id })
      .update({ run_after: fx.db.raw('DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 HOUR)') });

    expect(await claim()).toBeNull();
  });

  it('leaves the jobs of portals this worker has no adapter for in the queue', async () => {
    const { listingId } = await newListing('imotbg');
    const { job } = await enqueue(listingId, 'publish');

    expect(await claim()).toBeNull();
    expect(await claimNextJob(fx.db, { workerId: 'any' })).toMatchObject({ id: job?.id });
  });
});

describe('running jobs', () => {
  it('retries a temporary failure after the back-off, then publishes', async () => {
    const { propertyId, listingId } = await newListing();
    const { job } = await enqueue(listingId, 'publish');
    demo.answer('503');

    const failed = await runNext(fx, runner, registry);

    expect(failed).toMatchObject({ jobId: job?.id, recordedAs: 'retrying', retryInSeconds: 15 });
    const waiting = await jobRow(fx.db, job?.id ?? 0);
    expect(waiting).toMatchObject({
      status: 'queued',
      attempts: 1,
      locked_at: null,
      locked_by: null,
      finished_at: null,
      last_error: 'The demo portal answered HTTP 503 Service Unavailable (simulated outage)',
      result: {
        error: 'The demo portal answered HTTP 503 Service Unavailable (simulated outage)',
        retryable: true,
        httpStatus: 503,
        code: 'DEMO_UNAVAILABLE',
        retryInSeconds: 15,
      },
    });
    expect(await secondsUntilDue(fx.db, job?.id ?? 0)).toBeGreaterThanOrEqual(13);
    expect(await secondsUntilDue(fx.db, job?.id ?? 0)).toBeLessThanOrEqual(15);
    expect((await listingRow(fx, listingId)).status).toBe('pending');
    expect(await runNext(fx, runner, registry)).toBeNull();

    await makeDue(fx.db, job?.id ?? 0);
    const succeeded = await runNext(fx, runner, registry);

    expect(succeeded).toMatchObject({ jobId: job?.id, recordedAs: 'succeeded' });
    const done = await jobRow(fx.db, job?.id ?? 0);
    const externalId = `demo-${String(propertyId).padStart(6, '0')}`;
    expect(done).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      last_error: null,
      locked_by: null,
      result: {
        message: `Published on the demo portal as ${externalId} (simulated)`,
        externalId,
        details: { simulated: true, attempt: 2, latencyMs: 0 },
      },
    });
    expect(done.finished_at).toBeInstanceOf(Date);
    const listing = await listingRow(fx, listingId);
    expect(listing).toMatchObject({
      status: 'published',
      external_id: externalId,
      last_error: null,
    });
    expect(listing.published_at).toBeInstanceOf(Date);
    expect(listing.removed_at).toBeNull();
  });

  it('waits at least as long as the portal asks (HTTP 429 with Retry-After)', async () => {
    const quickRetries = testRunner(fx, registry, { retry: { baseSeconds: 1, capSeconds: 1 } });
    const { listingId } = await newListing();
    const { job } = await enqueue(listingId, 'publish');
    demo.answer('429');

    const report = await runNext(fx, quickRetries, registry);

    expect(report).toMatchObject({ recordedAs: 'retrying', retryInSeconds: 5 });
    expect(await secondsUntilDue(fx.db, job?.id ?? 0)).toBeGreaterThanOrEqual(3);
  });

  it('fails for good on a permanent error and moves the listing to error', async () => {
    const { listingId } = await newListing();
    const { job } = await enqueue(listingId, 'publish');
    demo.answer('422');

    const report = await runNext(fx, runner, registry);

    expect(report?.recordedAs).toBe('failed');
    const failed = await jobRow(fx.db, job?.id ?? 0);
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, locked_by: null });
    expect(failed.finished_at).toBeInstanceOf(Date);
    expect(failed.last_error).toMatch(/^The demo portal rejected the listing: .+ \(HTTP 422/);
    expect(failed.result).toMatchObject({ retryable: false, httpStatus: 422 });
    expect(await listingRow(fx, listingId)).toMatchObject({
      status: 'error',
      last_error: failed.last_error,
      published_at: null,
    });
  });

  it('gives up after the last attempt', async () => {
    const { listingId } = await newListing();
    const { job } = await enqueue(listingId, 'publish');
    await fx.db('jobs').where({ id: job?.id }).update({ max_attempts: 2 });
    demo.answer('503', '503');

    expect((await runNext(fx, runner, registry))?.recordedAs).toBe('retrying');
    await makeDue(fx.db, job?.id ?? 0);
    expect((await runNext(fx, runner, registry))?.recordedAs).toBe('failed');

    expect(await jobRow(fx.db, job?.id ?? 0)).toMatchObject({ status: 'failed', attempts: 2 });
    expect((await listingRow(fx, listingId)).last_error).toBe(
      'Gave up after 2 attempts: The demo portal answered HTTP 503 Service Unavailable (simulated outage)',
    );
  });

  it('validates the property again before calling the portal', async () => {
    const { propertyId, listingId } = await newListing();
    const { job } = await enqueue(listingId, 'publish');
    // The property changed after the job was queued.
    await fx.db('property_images').where({ property_id: propertyId }).delete();

    const report = await runNext(fx, runner, registry);

    expect(report?.recordedAs).toBe('failed');
    expect((await jobRow(fx.db, job?.id ?? 0)).last_error).toBe(
      'Validation failed: images: The demo portal needs at least one photo.',
    );
    expect((await listingRow(fx, listingId)).status).toBe('error');
  });

  it('fails a publish or update of a property archived in the meantime, without sending it', async () => {
    const { propertyId, listingId } = await newListing();
    const { job } = await enqueue(listingId, 'publish');
    await fx.db('properties').where({ id: propertyId }).update({ status: 'archived' });

    const report = await runNext(fx, runner, registry);

    expect(report).toMatchObject({
      recordedAs: 'failed',
      failure: { message: 'The property is archived', retryable: false, code: 'ARCHIVED' },
    });
    expect((await jobRow(fx.db, job?.id ?? 0)).result).toMatchObject({ code: 'ARCHIVED' });
    expect(await listingRow(fx, listingId)).toMatchObject({
      status: 'error',
      last_error: 'The property is archived',
      published_at: null,
      external_id: null,
    });
  });

  it('removes without validating: a property the portal would now refuse still comes off', async () => {
    const propertyId = await insertProperty(fx);
    const listingId = await insertPublishedListing(fx, propertyId, 'demo');
    // No photos and no price any more: publish and update would fail validation.
    await fx.db('property_images').where({ property_id: propertyId }).delete();
    await fx.db('properties').where({ id: propertyId }).update({ price: null });
    await enqueue(listingId, 'remove');

    const report = await runNext(fx, runner, registry);

    expect(report?.recordedAs).toBe('succeeded');
    expect(await listingRow(fx, listingId)).toMatchObject({ status: 'removed' });
  });

  it('a job that fails for good leaves the listing pending while a newer job waits', async () => {
    const { listingId } = await newListing();
    await enqueue(listingId, 'publish');
    const first = (await claim())!;
    const removal = await enqueue(listingId, 'remove');
    demo.answer('422');

    expect((await runner.runJob(first)).recordedAs).toBe('failed');

    expect((await jobRow(fx.db, first.id)).status).toBe('failed');
    expect((await listingRow(fx, listingId)).status).toBe('pending');
    // The newer job decides the listing.
    expect((await runNext(fx, runner, registry))?.jobId).toBe(removal.job?.id);
    expect((await listingRow(fx, listingId)).status).toBe('removed');
  });

  it('keeps the listing pending while a newer job of it waits', async () => {
    const { listingId } = await newListing();
    await enqueue(listingId, 'publish');
    const first = await claim();
    const edit = await enqueue(listingId, 'update');

    await runner.runJob(first!);

    const between = await listingRow(fx, listingId);
    expect(between.status).toBe('pending');
    expect(between.external_id).toMatch(/^demo-/);
    expect(between.published_at).toBeInstanceOf(Date);

    expect((await runNext(fx, runner, registry))?.jobId).toBe(edit.job?.id);
    expect((await listingRow(fx, listingId)).status).toBe('published');
  });

  it('stores the payload of a feed portal, and what it serves after a removal', async () => {
    const { propertyId, listingId } = await newListing('bazar');
    const refCode = (await fx.db('properties').where({ id: propertyId }).first())?.ref_code;

    await enqueue(listingId, 'publish');
    await runNext(fx, runner, registry);
    const published = await listingRow(fx, listingId);
    expect(published).toMatchObject({ status: 'published', external_id: null, removed_at: null });
    expect(published.payload).toEqual({ ref: refCode, title: expect.any(String) as string });
    expect(published.payload_updated_at).toBeInstanceOf(Date);

    await enqueue(listingId, 'remove');
    await runNext(fx, runner, registry);
    const removed = await listingRow(fx, listingId);
    expect(removed.status).toBe('removed');
    expect(removed.removed_at).toBeInstanceOf(Date);
    expect(removed.payload).toMatchObject({ ref: refCode, removed: true });

    // Published again: back in the feed; the first publication time stays.
    await enqueue(listingId, 'publish');
    expect((await jobsOf(fx.db, listingId)).at(-1)?.action).toBe('publish');
    await runNext(fx, runner, registry);
    const again = await listingRow(fx, listingId);
    expect(again).toMatchObject({ status: 'published', removed_at: null });
    expect(again.published_at).toEqual(published.published_at);
    expect(again.payload).toEqual(published.payload);
  });

  it('retries a call that runs out of its time budget, and an unexpected exception', async () => {
    const stuck: PortalAdapter = {
      key: 'stuck',
      displayName: 'Stuck portal',
      mode: 'push',
      validate: () => [],
      // Ignores the signal on purpose: the runner must not wait for it.
      publish: () => new Promise(() => undefined),
      update: () =>
        Promise.reject(new TypeError("Cannot read properties of undefined (reading 'id')")),
      remove: () => Promise.resolve({ message: 'ok' }),
    };
    const stuckRegistry = registryFrom([{ adapter: stuck }]);
    const stuckRunner = testRunner(fx, stuckRegistry, { jobTimeoutMs: 1000 });
    const propertyId = await insertProperty(fx);
    const timingOut = await insertListing(fx, propertyId, 'stuck');
    await enqueue(timingOut, 'publish');

    const started = Date.now();
    const timedOut = await runNext(fx, stuckRunner, stuckRegistry);

    expect(Date.now() - started).toBeLessThan(4000);
    expect(timedOut).toMatchObject({
      recordedAs: 'retrying',
      failure: {
        message: 'Stuck portal did not answer within 1 s (JOB_TIMEOUT_SECONDS)',
        code: 'TIMEOUT',
      },
    });

    const throwing = await insertPublishedListing(fx, await insertProperty(fx), 'stuck');
    await enqueue(throwing, 'publish');
    const crashed = await runNext(fx, stuckRunner, stuckRegistry);

    // Only a generic message and an error id are stored; the details are in the worker log.
    expect(crashed).toMatchObject({ recordedAs: 'retrying', failure: { code: 'UNEXPECTED' } });
    const errorId = crashed?.failure?.errorId ?? '';
    expect(errorId).toMatch(/^[0-9a-f]{12}$/);
    const crashedJob = (await jobsOf(fx.db, throwing))[0];
    expect(crashedJob?.last_error).toBe(`${UNEXPECTED_ERROR_MESSAGE}. Error id: ${errorId}`);
    expect(crashedJob?.result).toMatchObject({ code: 'UNEXPECTED', errorId });
    expect(JSON.stringify(crashedJob)).not.toContain('Cannot read properties');
  });

  it('fails a job whose portal has no adapter', async () => {
    const { listingId } = await newListing('imotbg');
    await enqueue(listingId, 'publish');
    const job = await claimNextJob(fx.db, { workerId: 'any' });

    const report = await runner.runJob(job!);

    expect(report.recordedAs).toBe('failed');
    expect((await listingRow(fx, listingId)).last_error).toBe(
      'No adapter is registered for portal "imotbg"',
    );
  });
});

describe('stale-lock sweep', () => {
  const sweep = () =>
    sweepStaleJobs(fx.db, { lockTimeoutSeconds: 300, retry: TEST_RETRY, random: () => 0 });

  it('returns an abandoned job to the queue; its old worker can no longer record anything', async () => {
    const abandoned = await newListing();
    const active = await newListing();
    await enqueue(abandoned.listingId, 'publish');
    await enqueue(active.listingId, 'publish');
    const crashed = (await claim('crashed-host:7:dead00'))!;
    const alive = (await claim('alive-host:8:beef00'))!;
    await fx
      .db('jobs')
      .where({ id: crashed.id })
      .update({ locked_at: fx.db.raw('DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)') });

    expect(await sweep()).toEqual({ requeued: 1, failed: 0 });

    const requeued = await jobRow(fx.db, crashed.id);
    expect(requeued).toMatchObject({ status: 'queued', attempts: 1, locked_by: null });
    expect(requeued.last_error).toBe(
      'The worker running this job (crashed-host:7:dead00) stopped responding: its lock is older than 300 s',
    );
    expect(requeued.result).toMatchObject({ code: 'LOCK_EXPIRED', retryable: true });
    expect(await secondsUntilDue(fx.db, crashed.id)).toBeGreaterThan(0);
    expect((await jobRow(fx.db, alive.id)).status).toBe('running');
    expect((await listingRow(fx, abandoned.listingId)).status).toBe('pending');

    // The crashed worker comes back and reports success: the job is no longer its own.
    const late = await recordSuccess(fx.db, crashed, { message: 'too late' });
    expect(late.recordedAs).toBe('lost');
    expect((await jobRow(fx.db, crashed.id)).status).toBe('queued');
  });

  it('fails an abandoned job that has no attempts left, and the listing with it', async () => {
    const { listingId } = await newListing();
    await enqueue(listingId, 'publish');
    const crashed = (await claim('gone:1:000000'))!;
    await fx
      .db('jobs')
      .where({ id: crashed.id })
      .update({
        max_attempts: 1,
        locked_at: fx.db.raw('DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR)'),
      });

    expect(await sweep()).toEqual({ requeued: 0, failed: 1 });

    expect((await jobRow(fx.db, crashed.id)).status).toBe('failed');
    expect(await listingRow(fx, listingId)).toMatchObject({
      status: 'error',
      last_error:
        'The worker running this job (gone:1:000000) stopped responding: its lock is older than 300 s, and no attempts are left',
    });
  });

  it('fails an abandoned job but leaves the listing pending while a newer job waits', async () => {
    const { listingId } = await newListing();
    await enqueue(listingId, 'publish');
    const crashed = (await claim('gone:2:000000'))!;
    const edit = await enqueue(listingId, 'update');
    await fx
      .db('jobs')
      .where({ id: crashed.id })
      .update({
        max_attempts: 1,
        locked_at: fx.db.raw('DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR)'),
      });

    expect(await sweep()).toEqual({ requeued: 0, failed: 1 });

    expect((await jobRow(fx.db, crashed.id)).status).toBe('failed');
    expect((await listingRow(fx, listingId)).status).toBe('pending');
    // The update queued behind it runs and publishes (the listing is not on the portal yet).
    expect((await runNext(fx, runner, registry))?.jobId).toBe(edit.job?.id);
    expect((await listingRow(fx, listingId)).status).toBe('published');
  });
});

describe('finishing a bulk delete', () => {
  async function propertyBeingDeleted() {
    const propertyId = await insertProperty(fx, { photos: 2 });
    const demoListing = await insertPublishedListing(fx, propertyId, 'demo');
    const bazarListing = await insertPublishedListing(fx, propertyId, 'bazar');
    await fx
      .db('properties')
      .where({ id: propertyId })
      .update({ status: 'archived', delete_requested_at: new Date() });
    await enqueue(demoListing, 'remove');
    await enqueue(bazarListing, 'remove');
    const files = (
      await fx.db('property_images').where({ property_id: propertyId }).pluck('url')
    ).map((url) => path.join(fx.uploadDir, ...url.replace(/^\/uploads\//, '').split('/')));
    return { propertyId, demoListing, bazarListing, files };
  }

  it('deletes the property and its rows after the last removal; the photo sweep its files', async () => {
    const { propertyId, demoListing, files } = await propertyBeingDeleted();
    for (const file of files) expect(existsSync(file)).toBe(true);

    const first = await runNext(fx, runner, registry);
    expect(first).toMatchObject({ recordedAs: 'succeeded', propertyDeleted: false });
    expect(await fx.db('properties').where({ id: propertyId })).toHaveLength(1);

    const second = await runNext(fx, runner, registry);
    expect(second).toMatchObject({ recordedAs: 'succeeded', propertyDeleted: true });
    expect(await fx.db('properties').where({ id: propertyId })).toEqual([]);
    expect(await fx.db('portal_listings').where({ property_id: propertyId })).toEqual([]);
    expect(await jobsOf(fx.db, demoListing)).toEqual([]);

    // The files stay until the worker's photo sweep finds nothing refers to them; a file
    // younger than an hour is kept (an upload saves its files before their rows).
    for (const file of files) expect(existsSync(file)).toBe(true);
    await collectUnusedPhotos(fx.db, storage, logger);
    for (const file of files) expect(existsSync(file)).toBe(true);
    await collectUnusedPhotos(fx.db, storage, logger, { now: hoursLater(2) });
    for (const file of files) expect(existsSync(file)).toBe(false);
    expect(existsSync(path.join(fx.uploadDir, 'properties', String(propertyId)))).toBe(false);
  });

  it('keeps a photo file while a stored feed payload still links to it', async () => {
    const propertyId = await insertProperty(fx, { photos: 2 });
    const [kept, dropped] = await fx
      .db('property_images')
      .where({ property_id: propertyId })
      .orderBy('sort_order')
      .pluck('url');
    // A feed listing whose stored payload (an update is still due) links to the first photo.
    await insertListing(fx, propertyId, 'bazar', {
      status: 'published',
      published_at: new Date('2026-11-01T10:00:00Z'),
      payload: JSON.stringify({ imageLink: `https://imotsync.example${kept ?? ''}` }),
      payload_updated_at: new Date('2026-11-01T10:00:00Z'),
    });
    // Both photos are deleted (their rows).
    await fx.db('property_images').where({ property_id: propertyId }).delete();
    const fileOf = (url = '') =>
      path.join(fx.uploadDir, ...url.replace(/^\/uploads\//, '').split('/'));

    expect(await collectUnusedPhotos(fx.db, storage, logger, { now: hoursLater(2) })).toMatchObject(
      { failed: 0 },
    );

    expect(existsSync(fileOf(kept))).toBe(true);
    expect(existsSync(fileOf(dropped))).toBe(false);
  });

  it('finishes a deletion whose last job failed, when nothing of it went online', async () => {
    const { propertyId, listingId } = await newListing();
    await enqueue(listingId, 'publish');
    const publish = (await claim())!;
    // Bulk delete while the first publish runs: archived, a removal queued behind it.
    await fx
      .db('properties')
      .where({ id: propertyId })
      .update({ status: 'archived', delete_requested_at: new Date() });
    await enqueue(listingId, 'remove');
    demo.answer('422', '422');

    expect(await runner.runJob(publish)).toMatchObject({
      recordedAs: 'failed',
      propertyDeleted: false,
    });
    // The removal fails too; nothing of the property was ever online, so it may go.
    expect(await runNext(fx, runner, registry)).toMatchObject({
      recordedAs: 'failed',
      propertyDeleted: true,
    });
    expect(await fx.db('properties').where({ id: propertyId })).toEqual([]);
  });

  it('the periodic sweep finishes requested deletions that are ready, and only those', async () => {
    const ready = await insertProperty(fx);
    await insertListing(fx, ready, 'demo', {
      status: 'removed',
      published_at: new Date('2026-11-01T10:00:00Z'),
      removed_at: new Date('2026-11-02T10:00:00Z'),
    });
    const stillOnline = await insertProperty(fx);
    await insertPublishedListing(fx, stillOnline, 'demo');
    const reactivated = await insertProperty(fx);
    for (const id of [ready, stillOnline]) {
      await fx
        .db('properties')
        .where({ id })
        .update({ status: 'archived', delete_requested_at: new Date() });
    }
    // Requested once, then set back to active (the API clears delete_requested_at too).
    await fx
      .db('properties')
      .where({ id: reactivated })
      .update({ status: 'active', delete_requested_at: new Date() });

    const deleted = await finishPendingDeletions(fx.db, logger, {
      removedRetentionDays: new Map(),
    });

    expect(deleted).toContain(ready);
    expect(deleted).not.toContain(stillOnline);
    expect(deleted).not.toContain(reactivated);
    expect(await fx.db('properties').whereIn('id', [stillOnline, reactivated])).toHaveLength(2);
  });

  it('keeps a property whose feed still serves its removal until the retention has passed', async () => {
    const propertyId = await insertProperty(fx);
    const removedAt = new Date('2026-11-10T10:00:00Z');
    await insertListing(fx, propertyId, 'bazar', {
      status: 'removed',
      published_at: new Date('2026-11-01T10:00:00Z'),
      removed_at: removedAt,
      payload: JSON.stringify({ id: 'x', availability: 'out_of_stock' }),
      payload_updated_at: removedAt,
    });
    await fx
      .db('properties')
      .where({ id: propertyId })
      .update({ status: 'archived', delete_requested_at: new Date() });
    const rules = (now: Date) => ({ removedRetentionDays: new Map([['bazar', 30]]), now });

    // 29 days later the out-of-stock item is still served: the property stays.
    expect(
      await finishPendingDeletions(fx.db, logger, rules(new Date('2026-12-09T10:00:00Z'))),
    ).not.toContain(propertyId);
    expect(
      await finishRequestedDeletion(
        fx.db,
        logger,
        propertyId,
        rules(new Date('2026-12-09T10:00:00Z')),
      ),
    ).toBe(false);
    expect(await fx.db('properties').where({ id: propertyId })).toHaveLength(1);

    // After 30 days it has dropped out of the feed: the property goes.
    expect(
      await finishPendingDeletions(fx.db, logger, rules(new Date('2026-12-10T10:00:01Z'))),
    ).toContain(propertyId);
    expect(await fx.db('properties').where({ id: propertyId })).toEqual([]);
  });

  it('holds the delete back while a removal failed (the listing may still be online)', async () => {
    const { propertyId, demoListing } = await propertyBeingDeleted();
    demo.answer('422');

    await runNext(fx, runner, registry);
    await runNext(fx, runner, registry);

    expect((await listingRow(fx, demoListing)).status).toBe('error');
    expect(await fx.db('properties').where({ id: propertyId }).first()).toMatchObject({
      status: 'archived',
    });
  });
});

/** A push portal that answers after `latencyMs` and records which listings it was busy with. */
function recordingPortal(latencyMs: number) {
  const busy = new Set<number>();
  const log: { listingId: number; action: string; start: number; end: number }[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  let overlaps = 0;
  const call =
    (action: string) =>
    async (
      _p: unknown,
      listing: PortalListingInfo,
      ctx: AdapterContext,
    ): Promise<{ message: string }> => {
      if (busy.has(listing.id)) overlaps++;
      busy.add(listing.id);
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const start = Date.now();
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
      ctx.signal.throwIfAborted();
      concurrent--;
      busy.delete(listing.id);
      log.push({ listingId: listing.id, action, start, end: Date.now() });
      return { message: `${action} done` };
    };
  const adapter: PortalAdapter = {
    key: 'recorder',
    displayName: 'Recorder',
    mode: 'push',
    validate: () => [],
    publish: (property, listing, ctx) => call('publish')(property, listing, ctx),
    update: (property, listing, ctx) => call('update')(property, listing, ctx),
    remove: (listing, property, ctx) => call('remove')(property, listing, ctx),
  };
  return {
    registry: registryFrom([{ adapter }]),
    log,
    stats: () => ({ maxConcurrent, overlaps }),
  };
}

const workerConfig = (concurrency: number) => ({
  worker: { concurrency, pollIntervalMs: 100, jobTimeoutSeconds: 5, lockTimeoutSeconds: 300 },
  retry: TEST_RETRY,
  publicBaseUrl: 'https://imotsync.example',
});

describe('worker', () => {
  it('runs every due job with at most WORKER_CONCURRENCY at a time, then stops (--once)', async () => {
    const portal = recordingPortal(40);
    for (let i = 0; i < 7; i++) {
      const { listingId } = await newListing('recorder');
      await enqueue(listingId, 'publish');
    }
    const worker = createWorker({
      db: fx.db,
      registry: portal.registry,
      storage: new LocalFileStorage(fx.uploadDir),
      logger: createLogger(fx.config),
      config: workerConfig(3),
      workerId: 'once-host:1:000001',
    });

    const stats = await worker.runOnce();

    expect(stats).toEqual({ claimed: 7, succeeded: 7, retrying: 0, failed: 0, lost: 0 });
    expect(portal.log).toHaveLength(7);
    expect(portal.stats().maxConcurrent).toBeGreaterThan(1);
    expect(portal.stats().maxConcurrent).toBeLessThanOrEqual(3);
  });

  it('two workers side by side never run two jobs of one listing at once, and keep their order', async () => {
    const portal = recordingPortal(25);
    const listingIds: number[] = [];
    for (let i = 0; i < 6; i++) {
      const { listingId } = await newListing('recorder');
      listingIds.push(listingId);
      // Two due jobs per listing: a publish and the update queued behind it.
      await fx.db('jobs').insert([
        { portal_listing_id: listingId, action: 'publish' },
        { portal_listing_id: listingId, action: 'update' },
      ]);
    }
    const workers = ['a', 'b'].map((name) =>
      createWorker({
        db: fx.db,
        registry: portal.registry,
        storage: new LocalFileStorage(fx.uploadDir),
        logger: createLogger(fx.config),
        config: workerConfig(4),
        workerId: `${name}:1:000000`,
      }),
    );

    const stats = await Promise.all(workers.map((worker) => worker.runOnce()));

    expect(stats.reduce((sum, s) => sum + s.succeeded, 0)).toBe(12);
    expect(portal.stats().overlaps).toBe(0);
    for (const listingId of listingIds) {
      const calls = portal.log.filter((entry) => entry.listingId === listingId);
      expect(calls.map((entry) => entry.action)).toEqual(['publish', 'update']);
      expect(calls[1]?.start).toBeGreaterThanOrEqual(calls[0]?.end ?? Infinity);
    }
  });

  it('fails --once instead of reporting success when the database is unreachable', async () => {
    // Nothing listens on port 1.
    const unreachable = createDb({ db: { ...fx.config.db, port: 1 } });
    try {
      const worker = createWorker({
        db: unreachable,
        registry,
        storage: new LocalFileStorage(fx.uploadDir),
        logger: createLogger(fx.config),
        config: workerConfig(1),
      });

      await expect(worker.runOnce()).rejects.toThrow();
    } finally {
      await unreachable.destroy();
    }
  });

  it('stops within the time budget when an adapter call hangs: the job is retried later', async () => {
    const hanging: PortalAdapter = {
      key: 'hanging',
      displayName: 'Hanging portal',
      mode: 'push',
      validate: () => [],
      // Never answers and ignores the signal.
      publish: () => new Promise(() => undefined),
      update: () => new Promise(() => undefined),
      remove: () => new Promise(() => undefined),
    };
    const propertyId = await insertProperty(fx);
    const listingId = await insertListing(fx, propertyId, 'hanging');
    const { job } = await enqueue(listingId, 'publish');
    const worker = createWorker({
      db: fx.db,
      registry: registryFrom([{ adapter: hanging }]),
      storage,
      logger,
      config: {
        ...workerConfig(1),
        worker: {
          concurrency: 1,
          pollIntervalMs: 50,
          jobTimeoutSeconds: 1,
          lockTimeoutSeconds: 61,
        },
      },
      maintenance: false,
    });

    const running = worker.run();
    for (let i = 0; i < 100 && (await jobRow(fx.db, job?.id ?? 0)).status !== 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const stopping = Date.now();
    await worker.stop();
    const stats = await running;

    expect(Date.now() - stopping).toBeLessThan(5_000);
    expect(stats).toMatchObject({ claimed: 1, retrying: 1 });
    expect(await jobRow(fx.db, job?.id ?? 0)).toMatchObject({
      status: 'queued',
      attempts: 1,
      locked_by: null,
      result: { code: 'TIMEOUT', retryable: true },
    });
    expect((await listingRow(fx, listingId)).status).toBe('pending');
  });

  it('stops gracefully: claims nothing more and lets the running job finish', async () => {
    const portal = recordingPortal(300);
    const listingIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { listingId } = await newListing('recorder');
      listingIds.push(listingId);
      await enqueue(listingId, 'publish');
    }
    const worker = createWorker({
      db: fx.db,
      registry: portal.registry,
      storage: new LocalFileStorage(fx.uploadDir),
      logger: createLogger(fx.config),
      config: workerConfig(1),
    });

    const running = worker.run();
    // Wait until the first job is running, then stop.
    for (
      let i = 0;
      i < 50 && (await fx.db('jobs').where({ status: 'running' })).length === 0;
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await worker.stop();
    const stats = await running;

    expect(stats).toMatchObject({ claimed: 1, succeeded: 1 });
    const statuses = await Promise.all(
      listingIds.map(async (id) => (await jobsOf(fx.db, id))[0]?.status),
    );
    expect(statuses.sort()).toEqual(['queued', 'queued', 'succeeded']);
    expect(worker.id).toMatch(/^.+:\d+:[0-9a-f]{6}$/);
  });
});

describe('worker process (npm run worker:once)', () => {
  it('publishes the due jobs and exits with code 0', async () => {
    const { propertyId, listingId } = await newListing('demo');
    const { job } = await enqueue(listingId, 'publish');

    const { code, output } = await new Promise<{ code: number | null; output: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts', '--once'], {
          cwd: API_ROOT,
          env: {
            ...process.env,
            NODE_ENV: 'test',
            DB_NAME: fx.config.db.database,
            UPLOAD_DIR: fx.uploadDir,
            DEMO_PORTAL_FAILURE_RATE: '0',
            DEMO_PORTAL_LATENCY_MS: '0',
            // Never the real Realistimo, whatever the developer's .env holds: the sync stays
            // off without a key, and the base URL points at a closed local port anyway.
            REALISTIMO_API_KEY: '',
            REALISTIMO_API_BASE_URL: 'http://127.0.0.1:9',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let text = '';
        child.stdout.on('data', (chunk: Buffer) => (text += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (text += chunk.toString()));
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`worker --once did not exit in time:\n${text}`));
        }, 45_000);
        child.on('error', reject);
        child.on('exit', (exitCode) => {
          clearTimeout(timer);
          resolve({ code: exitCode, output: text });
        });
      },
    );

    expect(code, output).toBe(0);
    expect(await jobRow(fx.db, job?.id ?? 0)).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(await listingRow(fx, listingId)).toMatchObject({
      status: 'published',
      external_id: `demo-${String(propertyId).padStart(6, '0')}`,
    });
  });
});

describe('feed items (what GET /feeds/<portal>/<token>.xml serves)', () => {
  it('serves the last good payload of every listing that has one, by its last successful job', async () => {
    const portal = `feedtest${process.pid % 1000}`;
    const at = new Date('2026-11-10T08:00:00Z');
    const later = new Date('2026-11-12T08:00:00Z');
    const payload = (n: number) => JSON.stringify({ n });
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await insertProperty(fx));
    const [published, pendingUpdate, failedUpdate, removed, neverSent, dropped] = ids;
    await insertListing(fx, published ?? 0, portal, {
      status: 'published',
      published_at: at,
      payload: payload(1),
      payload_updated_at: at,
    });
    await insertListing(fx, pendingUpdate ?? 0, portal, {
      status: 'pending',
      published_at: at,
      payload: payload(2),
      payload_updated_at: at,
    });
    await insertListing(fx, failedUpdate ?? 0, portal, {
      status: 'error',
      published_at: at,
      payload: payload(3),
      payload_updated_at: at,
    });
    await insertListing(fx, removed ?? 0, portal, {
      status: 'removed',
      published_at: at,
      removed_at: later,
      payload: payload(4),
      payload_updated_at: later,
    });
    await insertListing(fx, neverSent ?? 0, portal, { status: 'pending' });
    await insertListing(fx, dropped ?? 0, portal, {
      status: 'removed',
      published_at: at,
      removed_at: later,
    });
    await insertListing(fx, published ?? 0, 'other-portal', {
      status: 'published',
      payload: payload(9),
      payload_updated_at: later,
    });

    const items = await loadFeedItems(fx.db, portal);

    const refCode = async (id: number | undefined) =>
      (await fx.db('properties').where({ id }).first())?.ref_code;
    expect(items).toEqual([
      {
        refCode: await refCode(published),
        status: 'published',
        payload: { n: 1 },
        payloadUpdatedAt: at,
      },
      {
        refCode: await refCode(pendingUpdate),
        status: 'published',
        payload: { n: 2 },
        payloadUpdatedAt: at,
      },
      {
        refCode: await refCode(failedUpdate),
        status: 'published',
        payload: { n: 3 },
        payloadUpdatedAt: at,
      },
      {
        refCode: await refCode(removed),
        status: 'removed',
        payload: { n: 4 },
        payloadUpdatedAt: later,
      },
    ]);
    expect(await feedLastChanged(fx.db, portal)).toEqual(later);
    expect(await feedLastChanged(fx.db, 'no-such-portal')).toBeNull();
    expect(await loadFeedItems(fx.db, 'no-such-portal')).toEqual([]);
  });
});
