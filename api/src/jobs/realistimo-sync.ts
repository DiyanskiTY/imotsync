import type { Knex } from 'knex';
import type { Logger } from '../logger.js';
import { feedLastChanged } from '../portals/feed-items.js';
import {
  EMPTY_SYNC_STATE,
  isConfigurationOutcome,
  REALISTIMO_IMPORT_ERROR_PREFIX,
  REALISTIMO_KEY,
  runRealistimoSyncCycle,
  type RealistimoClient,
  type RealistimoSyncCycleInput,
  type RealistimoSyncCycleResult,
  type RealistimoSyncState,
} from '../portals/realistimo/index.js';
import { isOnPortal, UNFINISHED_JOB_STATUSES } from './listing-state.js';
import { queueTransaction } from './transaction.js';
import type { PeriodicTask } from './worker.js';

/*
 * The optional Realistimo import sync (REALISTIMO_API_KEY set), as a periodic task of the
 * worker. The decisions of a cycle are pure (src/portals/realistimo/sync.ts); this file loads
 * and saves portal_sync_state and applies the import results to the listings:
 * - an offer the latest completed import reported errors for moves its listing to 'error'
 *   with last_error 'Realistimo import: ...';
 * - an offer a later import reported without errors clears such an import error again
 *   (back to 'published').
 * A listing is left alone while a job of it is queued or running (that job decides its next
 * state), when it is not on the portal, when it is in error because a job failed (that error
 * and the failed job's retry stay), or when its payload changed after the import started
 * (the import judged an older version of the offer).
 *
 * One cycle runs at a time across all workers: a cycle holds the MariaDB user lock
 * REALISTIMO_SYNC_LOCK (GET_LOCK) from loading portal_sync_state until it has saved it, and a
 * worker that finds the lock taken skips its cycle. Otherwise two workers could both call
 * start(), and the second would save its older state over the first one's.
 */

export const REALISTIMO_SYNC_TASK_NAME = 'realistimo-sync';

/** How often to poll while an import that ImotSync queued is waiting or running. */
export const DEFAULT_AWAITING_POLL_MS = 60_000;

const PORTAL = REALISTIMO_KEY;

type StoredState = RealistimoSyncCycleInput['state'];

/** portal_sync_state for Realistimo, as the sync cycle reads it. */
export async function loadRealistimoSyncState(db: Knex): Promise<StoredState> {
  const row = await db('portal_sync_state').where({ portal: PORTAL }).first();
  if (!row) return { ...EMPTY_SYNC_STATE };
  return {
    lastTriggeredAt: row.last_triggered_at,
    lastTriggerMessage: row.last_trigger_message,
    lastLogDate: row.last_log_date,
    lastResult: row.last_result,
  };
}

/** Writes the cycle's state (feed_changed_at, written when properties are deleted, stays). */
export async function saveRealistimoSyncState(db: Knex, state: RealistimoSyncState): Promise<void> {
  await db('portal_sync_state')
    .insert({
      portal: PORTAL,
      last_triggered_at: state.lastTriggeredAt,
      last_trigger_message: state.lastTriggerMessage,
      last_log_date: state.lastLogDate,
      last_result: state.lastResult === null ? null : JSON.stringify(state.lastResult),
    })
    .onConflict('portal')
    .merge(['last_triggered_at', 'last_trigger_message', 'last_log_date', 'last_result']);
}

export interface ImportResultsApplied {
  /** Reference codes whose listing moved to 'error'. */
  markedError: string[];
  /** Reference codes whose import error was cleared. */
  cleared: string[];
}

/** The Realistimo listing ids of the given reference codes (offer_uid = ref_code). */
async function listingIdsByRefCode(db: Knex, refCodes: string[]): Promise<Map<string, number>> {
  if (refCodes.length === 0) return new Map();
  const rows = await db('portal_listings')
    .join('properties', 'properties.id', 'portal_listings.property_id')
    .where('portal_listings.portal', PORTAL)
    .whereIn('properties.ref_code', refCodes)
    .select<{ id: number; ref_code: string }[]>('portal_listings.id', 'properties.ref_code');
  return new Map(rows.map((row) => [row.ref_code, row.id]));
}

/**
 * Locks one listing (the listing row only, like recording a job's outcome) and applies
 * `change` when the listing may take an import result. Returns whether it changed.
 */
async function updateListingFromImport(
  db: Knex,
  listingId: number,
  logDate: Date,
  change: (listing: { status: string; last_error: string | null }) => {
    status: 'error' | 'published';
    last_error: string | null;
  } | null,
): Promise<boolean> {
  return queueTransaction(db, async (trx) => {
    const listing = await trx('portal_listings').where({ id: listingId }).forUpdate().first();
    if (!listing || listing.status === 'pending' || !isOnPortal(listing)) return false;
    // The import read an older version of the offer: a newer payload is waiting for the next.
    if (listing.payload_updated_at !== null && listing.payload_updated_at > logDate) return false;
    const unfinished = await trx('jobs')
      .where({ portal_listing_id: listingId })
      .whereIn('status', UNFINISHED_JOB_STATUSES)
      .first('id');
    if (unfinished) return false;
    const next = change(listing);
    if (next === null) return false;
    await trx('portal_listings').where({ id: listingId }).update(next);
    return true;
  });
}

/** In error because of an earlier import (not because a job failed). */
const hasImportError = (listing: { status: string; last_error: string | null }) =>
  listing.status === 'error' &&
  (listing.last_error ?? '').startsWith(REALISTIMO_IMPORT_ERROR_PREFIX);

/** Applies a newly processed import log to the Realistimo listings. */
export async function applyImportResults(
  db: Knex,
  result: Pick<RealistimoSyncCycleResult, 'offerErrors' | 'offersOk'>,
  logDate: Date,
): Promise<ImportResultsApplied> {
  const applied: ImportResultsApplied = { markedError: [], cleared: [] };
  const ids = await listingIdsByRefCode(db, [
    ...result.offerErrors.map((entry) => entry.offerUid),
    ...result.offersOk,
  ]);

  for (const { offerUid, lastError } of result.offerErrors) {
    const listingId = ids.get(offerUid);
    if (listingId === undefined) continue;
    // A listing in error because a job failed keeps that error (and its job stays retryable).
    const changed = await updateListingFromImport(db, listingId, logDate, (listing) =>
      listing.status === 'published' || hasImportError(listing)
        ? { status: 'error', last_error: lastError }
        : null,
    );
    if (changed) applied.markedError.push(offerUid);
  }

  for (const offerUid of result.offersOk) {
    const listingId = ids.get(offerUid);
    if (listingId === undefined) continue;
    const changed = await updateListingFromImport(db, listingId, logDate, (listing) =>
      hasImportError(listing) ? { status: 'published', last_error: null } : null,
    );
    if (changed) applied.cleared.push(offerUid);
  }
  return applied;
}

export interface RealistimoSyncRun extends RealistimoSyncCycleResult {
  applied: ImportResultsApplied;
}

/** The MariaDB user lock that serialises sync cycles across workers. */
export const REALISTIMO_SYNC_LOCK = 'imotsync:realistimo-sync';

/**
 * Runs `work` while holding the MariaDB user lock `name`, or returns null at once when another
 * connection holds it. The lock belongs to one pooled connection, kept for the whole run by
 * an otherwise empty transaction; it is released at the end, or by the server when the
 * connection drops (a crashed worker never leaves it behind).
 */
export async function withExclusiveLock<T>(
  db: Knex,
  name: string,
  work: () => Promise<T>,
): Promise<T | null> {
  return db.transaction(async (trx) => {
    const [rows] = (await trx.raw('SELECT GET_LOCK(?, 0) AS acquired', [name])) as [
      { acquired: number | null }[],
      unknown,
    ];
    if (Number(rows[0]?.acquired) !== 1) return null;
    try {
      return await work();
    } finally {
      await trx.raw('SELECT RELEASE_LOCK(?)', [name]);
    }
  });
}

/** One sync cycle against the database: load the state, run the cycle, save and apply. */
export async function runRealistimoSync(
  db: Knex,
  client: RealistimoClient,
  options: { now?: Date; signal?: AbortSignal } = {},
): Promise<RealistimoSyncRun> {
  const [state, feedChangedAt] = await Promise.all([
    loadRealistimoSyncState(db),
    feedLastChanged(db, PORTAL),
  ]);
  const result = await runRealistimoSyncCycle({
    client,
    now: options.now ?? new Date(),
    state,
    feedChangedAt,
    signal: options.signal,
  });
  await saveRealistimoSyncState(db, result.state);

  const logDate = result.log?.logDate ?? null;
  const applied =
    result.newLog && logDate !== null
      ? await applyImportResults(db, result, logDate)
      : { markedError: [], cleared: [] };
  return { ...result, applied };
}

export interface RealistimoSyncTaskOptions {
  db: Knex;
  client: RealistimoClient;
  /** REALISTIMO_SYNC_INTERVAL_SECONDS in milliseconds. */
  intervalMs: number;
  /** Poll interval while an import is awaited (default 60 s; never longer than intervalMs). */
  awaitingPollMs?: number;
  /** Clock (tests). */
  now?: () => Date;
}

function logRun(logger: Logger, run: RealistimoSyncRun): void {
  const summary = {
    decision: run.decision,
    started: run.started,
    importState: run.log?.state ?? null,
    newLog: run.newLog,
    importResult: run.log?.result ?? null,
    offersWithErrors: run.applied.markedError,
    errorsCleared: run.applied.cleared,
    awaitingResult: run.awaitingResult,
  };
  if (run.error) {
    const level = run.error.retryable ? 'warn' : 'error';
    logger[level]({ ...summary, err: run.error.message }, 'Realistimo sync: API call failed');
  } else if (run.started !== null && isConfigurationOutcome(run.started)) {
    // Needs a person: the agency id, or the feed registered at Realistimo. start() is not
    // called again until the feed changes or an hour has passed.
    logger.warn(
      { ...summary, message: run.state.lastResult?.lastAttempt?.message ?? null },
      'Realistimo sync: Realistimo cannot import the feed (check REALISTIMO_AGENCY_UID and the feed registered at Realistimo); retrying after the next feed change or in an hour',
    );
  } else {
    logger.info(summary, 'Realistimo sync cycle done');
  }
}

/** The worker's periodic task (src/worker.ts adds it when REALISTIMO_API_KEY is set). */
export function createRealistimoSyncTask(options: RealistimoSyncTaskOptions): PeriodicTask {
  const { db, client, intervalMs } = options;
  const awaitingPollMs = Math.min(options.awaitingPollMs ?? DEFAULT_AWAITING_POLL_MS, intervalMs);
  const clock = options.now ?? (() => new Date());

  return {
    name: REALISTIMO_SYNC_TASK_NAME,
    intervalMs,
    async run({ signal, logger }) {
      const run = await withExclusiveLock(db, REALISTIMO_SYNC_LOCK, () =>
        runRealistimoSync(db, client, { now: clock(), signal }),
      );
      if (run === null) {
        logger.debug('Realistimo sync: another worker is running a cycle; skipped');
        return undefined;
      }
      logRun(logger, run);
      return run.awaitingResult ? { nextRunInMs: awaitingPollMs } : undefined;
    },
  };
}
