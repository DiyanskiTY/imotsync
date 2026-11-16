import { spawn } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_ROOT } from '../../src/config.js';
import { queueTransaction } from '../../src/jobs/transaction.js';
import { enqueueListingJob } from '../../src/jobs/enqueue.js';
import {
  createRealistimoSyncTask,
  DEFAULT_AWAITING_POLL_MS,
  REALISTIMO_SYNC_LOCK,
  runRealistimoSync,
  withExclusiveLock,
} from '../../src/jobs/realistimo-sync.js';
import { createWorker } from '../../src/jobs/worker.js';
import { LocalFileStorage } from '../../src/lib/storage.js';
import { createLogger } from '../../src/logger.js';
import {
  createRealistimoClient,
  type RealistimoClient,
} from '../../src/portals/realistimo/index.js';
import {
  sendJson,
  startFakeServer,
  type FakeServer,
  type RecordedRequest,
} from '../unit/portals/realistimo/fixtures.js';
import { closeApiFixture, startApiFixture, type ApiFixture } from './api-fixture.js';
import {
  clearUnfinishedJobs,
  insertListing,
  insertProperty,
  listingRow,
  testRegistry,
  TEST_RETRY,
} from './publishing-fixture.js';

/*
 * The optional Realistimo import sync (REALISTIMO_API_KEY) against a local fake of
 * Realistimo's REST API: when it starts an import, what it records in portal_sync_state and
 * how the import log reaches the listings. Nothing is ever sent to realistimo.com.
 */

const API_KEY = 'fake-realistimo-key';
/** 10:00 in Sofia: inside the 08:00-20:59 import window. */
const NOW = new Date('2026-11-16T08:00:00Z');
const minutes = (n: number) => n * 60_000;
const at = (offsetMinutes: number) => new Date(NOW.getTime() + minutes(offsetMinutes));

let fx: ApiFixture;
let server: FakeServer;
let client: RealistimoClient;

/** What the fake API answers. */
const fake = {
  start: { message: 'import-in-queue' } as unknown,
  startStatus: 200,
  log: { message: null, logDate: null, logResult: null, logOffers: [] } as unknown,
  logStatus: 200,
};

function handler(req: RecordedRequest, res: Parameters<Parameters<typeof startFakeServer>[0]>[1]) {
  if (req.url === '/rest-api/import/start') sendJson(res, fake.startStatus, fake.start);
  else if (req.url === '/rest-api/import/latest-log') sendJson(res, fake.logStatus, fake.log);
  else sendJson(res, 404, { error: 'not found' });
}

const calls = (path: string) => server.requests.filter((req) => req.url === path).length;
const START = '/rest-api/import/start';
const LATEST_LOG = '/rest-api/import/latest-log';

beforeAll(async () => {
  fx = await startApiFixture();
  server = await startFakeServer(handler);
  client = createRealistimoClient({ apiKey: API_KEY, baseUrl: server.baseUrl, timeoutMs: 5_000 });
  await clearUnfinishedJobs(fx.db);
});

afterAll(async () => {
  await server.close();
  await closeApiFixture(fx);
});

beforeEach(async () => {
  server.requests.length = 0;
  fake.start = { message: 'import-in-queue' };
  fake.startStatus = 200;
  fake.log = { message: null, logDate: null, logResult: null, logOffers: [] };
  fake.logStatus = 200;
  await fx.db('portal_sync_state').delete();
  // Only the listings a test creates count as feed changes.
  await fx
    .db('portal_listings')
    .where({ portal: 'realistimo' })
    .update({ payload: null, payload_updated_at: null });
});

/** A Realistimo listing that is in the feed; returns its ids and reference code. */
async function feedListing(
  fields: { status?: 'published' | 'error'; lastError?: string; payloadAt?: Date } = {},
) {
  const propertyId = await insertProperty(fx);
  const refCode = (await fx.db('properties').where({ id: propertyId }).first())?.ref_code ?? '';
  const listingId = await insertListing(fx, propertyId, 'realistimo', {
    status: fields.status ?? 'published',
    last_error: fields.lastError ?? null,
    published_at: at(-24 * 60),
    payload: JSON.stringify({ offer_uid: refCode }),
    payload_updated_at: fields.payloadAt ?? at(-60),
  });
  return { propertyId, listingId, refCode };
}

const syncState = () => fx.db('portal_sync_state').where({ portal: 'realistimo' }).first();

function completedLog(logDate: Date, offers: { uid: string; errors: unknown[] }[]) {
  return {
    message: 'completed',
    logDate: logDate.toISOString(),
    logResult: {
      0: 'success_with_warnings',
      found_offers: offers.length,
      imported_offers: offers.length,
      updated_offers: offers.length,
      errors: [{ type: 'images', count: 1 }],
    },
    logOffers: offers.map(({ uid, errors }, index) => ({
      uuid: `log-${index}`,
      createdAt: logDate.toISOString(),
      errors,
      offerSourceData: { offer_uid: uid },
    })),
  };
}

describe('starting an import', () => {
  it('starts one when the feed changed, inside the window, and records it', async () => {
    await feedListing();

    const run = await runRealistimoSync(fx.db, client, { now: NOW });

    expect(run).toMatchObject({ started: 'queued', error: null, awaitingResult: true });
    expect(server.requests.map((req) => req.url)).toEqual([LATEST_LOG, START]);
    for (const req of server.requests) {
      expect(req.method).toBe('POST');
      expect(req.headers['api-key']).toBe(API_KEY);
      expect(req.headers.accept).toBe('application/json');
    }
    const state = await syncState();
    expect(state).toMatchObject({
      last_triggered_at: NOW,
      last_trigger_message: 'queued',
      last_log_date: null,
      feed_changed_at: null,
    });
    expect(state?.last_result).toMatchObject({
      lastAttempt: { at: NOW.toISOString(), outcome: 'queued', message: 'import-in-queue' },
    });

    // Nothing changed since: the next cycle only reads the log.
    const next = await runRealistimoSync(fx.db, client, { now: at(5) });
    expect(next.decision).toEqual({ trigger: false, reason: 'unchanged' });
    expect(calls(START)).toBe(1);
  });

  it('does not start one outside 08:00-20:59 Bulgarian time, and tries again later', async () => {
    await feedListing();

    const night = await runRealistimoSync(fx.db, client, { now: new Date('2026-11-16T20:00:00Z') });

    expect(night.decision).toEqual({ trigger: false, reason: 'outside-window' });
    expect(calls(START)).toBe(0);
    const morning = await runRealistimoSync(fx.db, client, {
      now: new Date('2026-11-17T07:00:00Z'),
    });
    expect(morning.started).toBe('queued');
  });

  it("records Realistimo's refusal (cooldown) and asks again in the next cycle", async () => {
    await feedListing();
    fake.start = { message: 'import-request-cooldown-is-time-given' };

    const refused = await runRealistimoSync(fx.db, client, { now: NOW });

    expect(refused.started).toBe('cooldown');
    expect(await syncState()).toMatchObject({
      last_triggered_at: null,
      last_trigger_message: 'cooldown',
    });
    fake.start = { message: 'import-in-queue' };
    const accepted = await runRealistimoSync(fx.db, client, { now: at(31) });
    expect(accepted.started).toBe('queued');
    expect((await syncState())?.last_triggered_at).toEqual(at(31));
  });

  it('counts a property deleted from the feed as a change', async () => {
    await fx
      .db('portal_sync_state')
      .insert({ portal: 'realistimo', last_triggered_at: at(-120), feed_changed_at: at(-10) });

    const run = await runRealistimoSync(fx.db, client, { now: NOW });

    expect(run.started).toBe('queued');
    // The sync keeps the recorded feed change.
    expect((await syncState())?.feed_changed_at).toEqual(at(-10));
  });

  it("accepts the test key's answers: text instead of a slug, JSON strings in the log", async () => {
    const { listingId, refCode } = await feedListing({ payloadAt: at(-60) });
    fake.start = { message: 'Import in queue' };
    const log = completedLog(at(-20), [{ uid: refCode, errors: ['Невалиден адрес на снимка'] }]);
    fake.log = {
      ...log,
      logResult: JSON.stringify(log.logResult),
      logOffers: JSON.stringify(log.logOffers),
    };

    const run = await runRealistimoSync(fx.db, client, { now: NOW });

    expect(run.newLog).toBe(true);
    expect(run.applied.markedError).toEqual([refCode]);
    expect(await listingRow(fx, listingId)).toMatchObject({
      status: 'error',
      last_error: 'Realistimo import: Невалиден адрес на снимка',
    });
    // The import ran 20 minutes ago: Realistimo would refuse a new one for 10 more minutes.
    expect(run.decision).toEqual({ trigger: false, reason: 'cooldown' });
  });

  it('stops at a rejected key (HTTP 401) and changes nothing', async () => {
    const { listingId } = await feedListing();
    fake.logStatus = 401;
    fake.log = { status: 'error', message: 'API key could not be found' };

    const run = await runRealistimoSync(fx.db, client, { now: NOW });

    expect(run.error).toEqual({
      message: 'Realistimo rejected the API key: API key could not be found',
      retryable: false,
    });
    expect(calls(START)).toBe(0);
    expect((await listingRow(fx, listingId)).status).toBe('published');
  });
});

describe('applying the import log to the listings', () => {
  it('moves offers with errors to error, clears earlier import errors, and does it once', async () => {
    const failing = await feedListing();
    const fixed = await feedListing({
      status: 'error',
      lastError: 'Realistimo import: Липсва снимка',
    });
    const ok = await feedListing();
    fake.log = completedLog(at(-40), [
      {
        uid: failing.refCode,
        errors: ['Невалиден адрес на снимка', { type: 'price', message: 'Цената е 0' }],
      },
      { uid: fixed.refCode, errors: [] },
      { uid: ok.refCode, errors: [] },
    ]);

    const run = await runRealistimoSync(fx.db, client, { now: NOW });

    expect(run.applied).toEqual({ markedError: [failing.refCode], cleared: [fixed.refCode] });
    expect(await listingRow(fx, failing.listingId)).toMatchObject({
      status: 'error',
      last_error: 'Realistimo import: Невалиден адрес на снимка; price: Цената е 0',
    });
    expect(await listingRow(fx, fixed.listingId)).toMatchObject({
      status: 'published',
      last_error: null,
    });
    expect(await listingRow(fx, ok.listingId)).toMatchObject({ status: 'published' });
    const state = await syncState();
    expect(state?.last_log_date).toEqual(at(-40));
    expect(state?.last_result).toMatchObject({
      log: {
        logDate: at(-40).toISOString(),
        result: 'success_with_warnings',
        errorTypes: [{ type: 'images', count: 1 }],
        offersWithErrors: 1,
      },
    });

    // The same log is not applied twice: a listing published again stays published.
    await fx.db('portal_listings').where({ id: failing.listingId }).update({ status: 'published' });
    const again = await runRealistimoSync(fx.db, client, { now: at(1) });
    expect(again.newLog).toBe(false);
    expect((await listingRow(fx, failing.listingId)).status).toBe('published');
  });

  it('leaves a listing alone while a job of it is queued, after a failed job, or when it changed since', async () => {
    const queued = await feedListing();
    await queueTransaction(fx.db, (trx) => enqueueListingJob(trx, queued.listingId, 'update'));
    const newer = await feedListing({ payloadAt: at(-5) });
    const removed = await feedListing();
    await fx
      .db('portal_listings')
      .where({ id: removed.listingId })
      .update({ status: 'removed', removed_at: at(-50) });
    const failedJob = await feedListing({
      status: 'error',
      lastError: 'Gave up after 5 attempts: Realistimo did not answer',
    });
    fake.log = completedLog(at(-30), [
      { uid: failedJob.refCode, errors: [] },
      { uid: queued.refCode, errors: ['x'] },
      { uid: newer.refCode, errors: ['x'] },
      { uid: removed.refCode, errors: ['x'] },
      { uid: 'NOT-OURS-1', errors: ['x'] },
    ]);

    const run = await runRealistimoSync(fx.db, client, { now: NOW });

    expect(run.newLog).toBe(true);
    expect(run.offerErrors).toHaveLength(4);
    expect(run.offersOk).toEqual([failedJob.refCode]);
    expect(run.applied).toEqual({ markedError: [], cleared: [] });
    expect((await listingRow(fx, queued.listingId)).status).toBe('pending');
    expect((await listingRow(fx, newer.listingId)).status).toBe('published');
    expect((await listingRow(fx, removed.listingId)).status).toBe('removed');
    // An error from a failed job is not the import's to clear.
    expect(await listingRow(fx, failedJob.listingId)).toMatchObject({
      status: 'error',
      last_error: 'Gave up after 5 attempts: Realistimo did not answer',
    });
    await clearUnfinishedJobs(fx.db);
  });
});

describe('the sync in the worker', () => {
  const workerFor = (task: ReturnType<typeof createRealistimoSyncTask>, now?: () => Date) =>
    createWorker({
      db: fx.db,
      registry: testRegistry(),
      storage: new LocalFileStorage(fx.uploadDir),
      logger: createLogger(fx.config),
      config: {
        worker: {
          concurrency: 1,
          pollIntervalMs: 50,
          jobTimeoutSeconds: 5,
          lockTimeoutSeconds: 65,
        },
        retry: TEST_RETRY,
        publicBaseUrl: fx.config.publicBaseUrl,
      },
      periodicTasks: [task],
      maintenance: false,
      now,
    });

  const taskContext = () => ({
    signal: new AbortController().signal,
    logger: createLogger(fx.config),
  });

  /** Waits (polling) until `check` holds; fails after a generous timeout. */
  async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
    for (let i = 0; i < 500; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting until ${what}`);
  }

  it('runs once with --once, after the jobs, so it sees the feed they changed', async () => {
    // A queued publish to the (fake) Realistimo portal: its payload is the only feed change.
    // Before the job, the feed has never changed, so only a sync after it can start an import.
    const propertyId = await insertProperty(fx);
    const listingId = await insertListing(fx, propertyId, 'realistimo');
    await queueTransaction(fx.db, (trx) => enqueueListingJob(trx, listingId, 'publish'));
    // A fixed clock inside the import window: the outcome never depends on the time of day.
    const task = createRealistimoSyncTask({
      db: fx.db,
      client,
      intervalMs: 900_000,
      now: () => NOW,
    });

    const stats = await workerFor(task).runOnce();

    expect(stats).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(server.requests.map((req) => req.url)).toEqual([LATEST_LOG, START]);
    expect(await syncState()).toMatchObject({
      last_triggered_at: NOW,
      last_trigger_message: 'queued',
      last_log_date: null,
    });
    expect((await syncState())?.last_result).toMatchObject({
      lastAttempt: { at: NOW.toISOString(), outcome: 'queued' },
      log: null,
    });
  });

  it('asks to poll sooner while an import is awaited, at its interval otherwise', async () => {
    await feedListing();
    const task = createRealistimoSyncTask({
      db: fx.db,
      client,
      intervalMs: 900_000,
      awaitingPollMs: 100,
      now: () => NOW,
    });
    expect(DEFAULT_AWAITING_POLL_MS).toBe(60_000);

    // Queued by this cycle, then still awaited while the log reports nothing newer.
    expect(await task.run(taskContext())).toEqual({ nextRunInMs: 100 });
    expect(calls(START)).toBe(1);
    expect(await task.run(taskContext())).toEqual({ nextRunInMs: 100 });

    // Once the import is reported, nothing is awaited: the interval applies again.
    fake.log = completedLog(at(1), []);
    expect(await task.run(taskContext())).toBeUndefined();
    expect((await syncState())?.last_log_date).toEqual(at(1));
    expect(calls(LATEST_LOG)).toBe(3);
    expect(calls(START)).toBe(1);
  });

  it('the worker runs the task again after nextRunInMs, otherwise after its interval', async () => {
    await feedListing();
    let clock = NOW;
    const later = (ms: number) => {
      clock = new Date(NOW.getTime() + ms);
    };
    const task = createRealistimoSyncTask({
      db: fx.db,
      client,
      intervalMs: 900_000,
      awaitingPollMs: 100,
      now: () => clock,
    });
    const worker = workerFor(task, () => clock);
    const running = worker.run();
    try {
      // First cycle at NOW: queues an import and asks to poll again in 100 ms.
      await until(async () => (await syncState())?.last_trigger_message === 'queued', 'queued');
      expect(calls(LATEST_LOG)).toBe(1);

      // The clock decides when the next cycle is due: 100 ms later, not 15 minutes.
      later(100);
      await until(() => calls(LATEST_LOG) === 2, 'the second cycle');
      fake.log = completedLog(at(1), []);
      later(200);
      await until(
        async () => (await syncState())?.last_log_date?.getTime() === at(1).getTime(),
        'the import log is processed',
      );
      expect(calls(LATEST_LOG)).toBe(3);

      // Nothing awaited any more: the next cycle is due a whole interval later.
      later(200 + 900_000);
      await until(() => calls(LATEST_LOG) === 4, 'the cycle after the interval');
      expect(calls(START)).toBe(1);
    } finally {
      await worker.stop();
      await running;
    }
  });

  it('runs one cycle at a time across workers (GET_LOCK), so start() is called once', async () => {
    await feedListing();
    const tasks = [1, 2, 3].map(() =>
      createRealistimoSyncTask({ db: fx.db, client, intervalMs: 900_000, now: () => NOW }),
    );

    // While another connection holds the lock, a cycle is skipped without any API call.
    await withExclusiveLock(fx.db, REALISTIMO_SYNC_LOCK, async () => {
      expect(await tasks[0]?.run(taskContext())).toBeUndefined();
    });
    expect(server.requests).toEqual([]);

    // Three workers at the same moment: one queues the import; the others either skip their
    // cycle or run after it and find the feed unchanged.
    await Promise.all(tasks.map((task) => task.run(taskContext())));
    expect(calls(START)).toBe(1);
    expect(await syncState()).toMatchObject({
      last_triggered_at: NOW,
      last_trigger_message: 'queued',
    });
  });

  it('warns about a configuration problem and backs off for an hour', async () => {
    await feedListing();
    fake.start = { error: 'Agency not found' };
    const logger = createLogger(fx.config);
    const warn = vi.spyOn(logger, 'warn');
    let clock = NOW;
    const task = createRealistimoSyncTask({
      db: fx.db,
      client,
      intervalMs: 900_000,
      now: () => clock,
    });
    const context = { signal: new AbortController().signal, logger };

    await task.run(context);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ started: 'agency-not-found' }),
      expect.stringMatching(/Realistimo cannot import the feed/),
    );
    expect(await syncState()).toMatchObject({ last_trigger_message: 'agency-not-found' });

    clock = at(30);
    await task.run(context);
    expect(calls(START)).toBe(1);
    clock = at(61);
    await task.run(context);
    expect(calls(START)).toBe(2);
  });

  it('runs in the worker process (npm run worker:once) when REALISTIMO_API_KEY is set', async () => {
    const { listingId } = await feedListing();
    const listing = await listingRow(fx, listingId);
    // An import was queued after the feed's last change.
    const triggeredAt = new Date((listing.payload_updated_at?.getTime() ?? 0) + 60_000);
    await fx.db('portal_sync_state').insert({
      portal: 'realistimo',
      last_triggered_at: triggeredAt,
      last_trigger_message: 'queued',
    });

    const { code, output } = await new Promise<{ code: number | null; output: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts', '--once'], {
          cwd: API_ROOT,
          env: {
            ...process.env,
            NODE_ENV: 'test',
            DB_NAME: fx.config.db.database,
            UPLOAD_DIR: fx.uploadDir,
            // The local fake, never realistimo.com.
            REALISTIMO_API_KEY: API_KEY,
            REALISTIMO_API_BASE_URL: server.baseUrl,
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
    // The process uses the real clock: with the feed unchanged since the last import it
    // queued, the cycle only reads the log, at any time of day.
    expect(server.requests.map((req) => req.url)).toEqual([LATEST_LOG]);
    expect(server.requests[0]?.headers['api-key']).toBe(API_KEY);
    expect(await syncState()).toMatchObject({
      last_triggered_at: triggeredAt,
      last_trigger_message: 'queued',
      last_log_date: null,
    });
    expect((await syncState())?.last_result).toMatchObject({ lastAttempt: null, log: null });
  });
});
