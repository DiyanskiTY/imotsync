import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Knex } from 'knex';
import type { RetryConfig } from '../../src/config.js';
import type { JobRow, PortalListingRow, PropertyRow } from '../../src/db/types.js';
import { claimNextJob } from '../../src/jobs/claim.js';
import { createJobRunner, type JobRunReport, type JobRunner } from '../../src/jobs/job-runner.js';
import { createLogger } from '../../src/logger.js';
import { createDemoAdapter } from '../../src/portals/demo/demo-adapter.js';
import {
  registryFrom,
  type PortalRegistration,
  type PortalRegistry,
} from '../../src/portals/registry.js';
import type { FeedPayload, PortalAdapter } from '../../src/portals/types.js';
import type { ApiFixture } from './api-fixture.js';

/*
 * Helpers for the publishing tests: a deterministic demo portal, fake feed portals under
 * the keys of the seeded listings, test properties, and running jobs one at a time.
 */

export type DemoAnswer = 'ok' | '503' | '429' | '422';

/**
 * The random() of a demo adapter with DEMO_PORTAL_FAILURE_RATE 0.5, scripted: each queued
 * answer decides one call (in the order calls are made); with nothing queued, calls succeed.
 */
export function scriptedDemoRandom() {
  const values: number[] = [];
  return {
    random: () => values.shift() ?? 0.99,
    /** Queues the answers of the next calls. */
    answer(...answers: DemoAnswer[]) {
      for (const answer of answers) {
        // First value: fail (< 0.5) or not; second: which of six failures; third: 422 reason.
        if (answer === 'ok') values.push(0.99);
        if (answer === '503') values.push(0, 0.01);
        if (answer === '429') values.push(0, 3.5 / 6);
        if (answer === '422') values.push(0, 5.5 / 6, 0);
      }
    },
    /** Forgets answers that were never used. */
    reset() {
      values.length = 0;
    },
  };
}

export type ScriptedRandom = ReturnType<typeof scriptedDemoRandom>;

/**
 * A feed portal that accepts every property with a title and stores a recognisable payload
 * (registered under the seeded keys 'realistimo' and 'bazar', so every seeded job can run).
 */
export function fakeFeedPortal(key: string): PortalRegistration {
  const payload = (refCode: string, title: string | null): FeedPayload => ({ ref: refCode, title });
  const adapter: PortalAdapter = {
    key,
    displayName: `Fake ${key}`,
    mode: 'feed',
    validate: (property) =>
      property.title ? [] : [{ field: 'title', message: `Fake ${key} needs a title.` }],
    publish: (property) =>
      Promise.resolve({
        message: 'In the feed',
        payload: payload(property.refCode, property.title),
      }),
    update: (property) =>
      Promise.resolve({ message: 'Updated', payload: payload(property.refCode, property.title) }),
    remove: (listing) =>
      Promise.resolve({
        message: 'Out of the feed',
        payload: listing.payload === null ? null : { ...listing.payload, removed: true },
      }),
  };
  return { adapter, feedRenderer: { contentType: 'application/xml', render: () => '<feed/>' } };
}

/** The demo portal (no latency, failures as scripted) plus fake feed portals. */
export function testRegistry(demoRandom: ScriptedRandom = scriptedDemoRandom()): PortalRegistry {
  return registryFrom([
    { adapter: createDemoAdapter({ failureRate: 0.5, latencyMs: 0, random: demoRandom.random }) },
    fakeFeedPortal('realistimo'),
    fakeFeedPortal('bazar'),
  ]);
}

/** Back-off of the tests: random() = 0, so the first retry waits exactly 15 s. */
export const TEST_RETRY: RetryConfig = { baseSeconds: 30, capSeconds: 3600 };

export function testRunner(
  fx: ApiFixture,
  registry: PortalRegistry,
  options: { jobTimeoutMs?: number; retry?: RetryConfig; now?: () => Date } = {},
): JobRunner {
  return createJobRunner({
    db: fx.db,
    registry,
    logger: createLogger(fx.config),
    publicBaseUrl: 'https://imotsync.example',
    jobTimeoutMs: options.jobTimeoutMs ?? 5_000,
    retry: options.retry ?? TEST_RETRY,
    random: () => 0,
    now: options.now,
  });
}

/** Claims the next due job (of the registered portals) and runs it; null when none is due. */
export async function runNext(
  fx: ApiFixture,
  runner: JobRunner,
  registry: PortalRegistry,
  workerId = 'test-host:1:aaaaaa',
): Promise<JobRunReport | null> {
  const job = await claimNextJob(fx.db, { workerId, portals: registry.keys() });
  return job ? runner.runJob(job) : null;
}

/** Runs due jobs until none is left; returns the reports in order. */
export async function drain(
  fx: ApiFixture,
  runner: JobRunner,
  registry: PortalRegistry,
): Promise<JobRunReport[]> {
  const reports: JobRunReport[] = [];
  for (let report = await runNext(fx, runner, registry); report;) {
    reports.push(report);
    report = await runNext(fx, runner, registry);
  }
  return reports;
}

let counter = 0;

export interface TestPropertyOptions {
  title?: string | null;
  price?: number | null;
  status?: PropertyRow['status'];
  /** Photos: rows plus real files under the fixture's UPLOAD_DIR. */
  photos?: number;
}

/** A property that passes every test portal's rules (unless told otherwise); returns its id. */
export async function insertProperty(
  fx: ApiFixture,
  options: TestPropertyOptions = {},
): Promise<number> {
  counter++;
  const [id] = await fx.db('properties').insert({
    ref_code: `T-${process.pid}-${counter}`,
    title: options.title === undefined ? `Тестов имот ${counter}` : options.title,
    type: 'apartment',
    deal_type: 'sale',
    city: 'Sofia',
    district: 'Lozenets',
    price: options.price === undefined ? 100_000 + counter : options.price,
    status: options.status ?? 'active',
    created_by: 1,
  });
  if (id === undefined) throw new Error('INSERT into properties returned no id');

  const photos = options.photos ?? 1;
  const folder = path.join(fx.uploadDir, 'properties', String(id));
  await mkdir(folder, { recursive: true });
  for (let number = 1; number <= photos; number++) {
    await writeFile(path.join(folder, `photo-${number}.jpg`), 'jpeg');
    await fx.db('property_images').insert({
      property_id: id,
      url: `/uploads/properties/${id}/photo-${number}.jpg`,
      sort_order: number - 1,
      width: 1600,
      height: 1067,
      size_bytes: 4,
    });
  }
  return id;
}

/** A listing row as a past job left it. */
export async function insertListing(
  fx: ApiFixture,
  propertyId: number,
  portal: string,
  fields: Partial<Omit<PortalListingRow, 'id' | 'property_id' | 'portal' | 'payload'>> & {
    payload?: string | null;
  } = {},
): Promise<number> {
  const [id] = await fx.db('portal_listings').insert({
    property_id: propertyId,
    portal,
    status: 'draft',
    ...fields,
  });
  if (id === undefined) throw new Error('INSERT into portal_listings returned no id');
  return id;
}

/** A listing that is live on the portal (published by an earlier job). */
export const insertPublishedListing = (fx: ApiFixture, propertyId: number, portal: string) =>
  insertListing(fx, propertyId, portal, {
    status: 'published',
    published_at: new Date('2026-11-01T10:00:00Z'),
    external_id: portal === 'demo' ? `demo-${String(propertyId).padStart(6, '0')}` : null,
  });

export const listingRow = async (fx: ApiFixture, id: number): Promise<PortalListingRow> => {
  const row = await fx.db('portal_listings').where({ id }).first();
  if (!row) throw new Error(`Listing ${id} is gone`);
  return row;
};

export const listingOf = async (
  fx: ApiFixture,
  propertyId: number,
  portal: string,
): Promise<PortalListingRow | undefined> =>
  fx.db('portal_listings').where({ property_id: propertyId, portal }).first();

/** The listing's jobs, oldest first. */
export const jobsOf = (db: Knex, listingId: number): Promise<JobRow[]> =>
  db('jobs').where({ portal_listing_id: listingId }).orderBy('id');

export const jobRow = async (db: Knex, id: number): Promise<JobRow> => {
  const row = await db('jobs').where({ id }).first();
  if (!row) throw new Error(`Job ${id} is gone`);
  return row;
};

/** Lets time pass for a job waiting for its retry: its run_after moves into the past. */
export async function makeDue(db: Knex, jobId: number): Promise<void> {
  await db('jobs')
    .where({ id: jobId })
    .update({ run_after: db.raw('DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 SECOND)') });
}

/** Seconds from now (database clock) until the job may run. */
export async function secondsUntilDue(db: Knex, jobId: number): Promise<number> {
  const [rows] = (await db.raw(
    'SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), run_after) AS seconds FROM jobs WHERE id = ?',
    [jobId],
  )) as [{ seconds: number }[], unknown];
  const seconds = rows[0]?.seconds;
  if (seconds === undefined) throw new Error(`Job ${jobId} is gone`);
  return Number(seconds);
}

/** Removes every queued and running job (the seeded ones), so a test controls the queue. */
export async function clearUnfinishedJobs(db: Knex): Promise<void> {
  await db('jobs').whereIn('status', ['queued', 'running']).delete();
}
