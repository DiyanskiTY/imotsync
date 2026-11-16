import type { Knex } from 'knex';
import type { RetryConfig } from '../config.js';
import type {
  JobAction,
  JobRow,
  NewJob,
  NewPortalListing,
  PortalListingRow,
  UpdateWithRaw,
} from '../db/types.js';
import type { AdapterOutcome } from '../portals/types.js';
import { computeRetryDelayMs } from './backoff.js';
import type { JobFailure } from './failure.js';
import { createQueueRepository } from './queue.repository.js';
import { queueTransaction, utcIn, utcNow } from './transaction.js';

/*
 * Recording what happened to a claimed job. Each outcome is written in one transaction that
 * locks the listing row first and then its unfinished jobs, like every other queue change.
 */

export type RecordedAs =
  /** The job succeeded; the listing reflects it. */
  | 'succeeded'
  /** A retryable failure with attempts left: queued again for later. */
  | 'retrying'
  /** Failed for good; the listing is in 'error' (unless a newer job is pending). */
  | 'failed'
  /** Nothing written: the job was swept and handed on, or deleted with its property. */
  | 'lost';

export interface RecordResult {
  recordedAs: RecordedAs;
  /** The listing after the change (absent when lost). */
  listing?: PortalListingRow;
  /** retrying: seconds until the next attempt. */
  retryInSeconds?: number;
}

interface LockedJob {
  job: JobRow;
  listing: PortalListingRow;
  /** A newer job of the listing is queued: the listing stays pending until it has run. */
  newerPending: boolean;
}

/**
 * Locks the listing and its unfinished jobs, and checks that the claimed job is still this
 * worker's: a job swept back to the queue (lock expired) may meanwhile belong to another worker.
 */
async function lockClaimedJob(trx: Knex.Transaction, claimed: JobRow): Promise<LockedJob | null> {
  const queue = createQueueRepository(trx);
  const listing = await queue.lockListing(claimed.portal_listing_id);
  if (!listing) return null;
  const unfinished = await queue.lockUnfinishedJobs(listing.id);
  const job = unfinished.find((candidate) => candidate.id === claimed.id);
  if (
    job?.status !== 'running' ||
    job.locked_by !== claimed.locked_by ||
    job.attempts !== claimed.attempts
  ) {
    return null;
  }
  return { job, listing, newerPending: unfinished.some((other) => other.id > job.id) };
}

const listingStatusAfter = (action: JobAction) => (action === 'remove' ? 'removed' : 'published');

/** jobs.result of a successful attempt. */
export function successResult(outcome: AdapterOutcome): Record<string, unknown> {
  return {
    message: outcome.message,
    ...(typeof outcome.externalId === 'string' ? { externalId: outcome.externalId } : {}),
    ...(outcome.details !== undefined ? { details: outcome.details } : {}),
  };
}

/** jobs.result of a failed attempt. */
export function failureResult(failure: JobFailure, retryInSeconds?: number) {
  return {
    error: failure.message,
    retryable: failure.retryable,
    ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
    ...(failure.code !== undefined ? { code: failure.code } : {}),
    ...(failure.errorId !== undefined ? { errorId: failure.errorId } : {}),
    ...(retryInSeconds !== undefined ? { retryInSeconds } : {}),
  };
}

/**
 * Success: the job is finished, and the listing becomes published (removed after a remove)
 * with the external id, the first publication time and, for feed portals, the payload the
 * feed serves from now on. If a newer job of the listing is still queued the listing stays
 * pending: it reaches its final state when that job is done.
 */
export async function recordSuccess(
  db: Knex,
  claimed: JobRow,
  outcome: AdapterOutcome,
): Promise<RecordResult> {
  return queueTransaction(db, async (trx) => {
    const locked = await lockClaimedJob(trx, claimed);
    if (!locked) return { recordedAs: 'lost' };
    const { job, listing, newerPending } = locked;
    const queue = createQueueRepository(trx);

    const jobChanges: UpdateWithRaw<NewJob> = {
      status: 'succeeded',
      finished_at: utcNow(trx),
      locked_at: null,
      locked_by: null,
      last_error: null,
      result: JSON.stringify(successResult(outcome)),
    };
    await trx('jobs').where({ id: job.id }).update(jobChanges);

    const changes: UpdateWithRaw<NewPortalListing> = { last_error: null };
    if (!newerPending) changes.status = listingStatusAfter(job.action);
    if (outcome.externalId !== undefined) changes.external_id = outcome.externalId;
    if (job.action === 'remove') {
      changes.removed_at = utcNow(trx);
    } else {
      changes.removed_at = null;
      if (listing.published_at === null) changes.published_at = utcNow(trx);
    }
    if (outcome.payload !== undefined) {
      changes.payload = outcome.payload === null ? null : JSON.stringify(outcome.payload);
      changes.payload_updated_at = utcNow(trx);
    }
    await queue.updateListing(listing.id, changes);
    return { recordedAs: 'succeeded', listing: await queue.findListing(listing.id) };
  });
}

export interface FailureOptions {
  retry: RetryConfig;
  /** Jitter source for the back-off (default Math.random). */
  random?: () => number;
}

/** The listing's last_error after a job failed for good. */
export function listingErrorFor(job: Pick<JobRow, 'attempts'>, failure: JobFailure): string {
  return failure.retryable
    ? `Gave up after ${job.attempts} attempts: ${failure.message}`
    : failure.message;
}

/**
 * Failure: with a retryable error and attempts left, the job goes back to the queue with
 * run_after = now + back-off; otherwise it fails for good and the listing moves to 'error'
 * (unless a newer job is pending, which decides the listing's state instead).
 */
export async function recordFailure(
  db: Knex,
  claimed: JobRow,
  failure: JobFailure,
  options: FailureOptions,
): Promise<RecordResult> {
  return queueTransaction(db, async (trx) => {
    const locked = await lockClaimedJob(trx, claimed);
    if (!locked) return { recordedAs: 'lost' };
    return applyFailure(trx, locked, failure, options);
  });
}

/** Shared by recordFailure and the stale-lock sweep. The listing and the job are locked. */
export async function applyFailure(
  trx: Knex.Transaction,
  locked: LockedJob,
  failure: JobFailure,
  options: FailureOptions,
): Promise<RecordResult> {
  const { job, listing, newerPending } = locked;
  const queue = createQueueRepository(trx);

  if (failure.retryable && job.attempts < job.max_attempts) {
    const delayMs = computeRetryDelayMs(
      job.attempts,
      options.retry,
      options.random,
      failure.retryAfterMs,
    );
    const retryInSeconds = Math.max(1, Math.ceil(delayMs / 1000));
    await trx('jobs')
      .where({ id: job.id })
      .update({
        status: 'queued',
        run_after: utcIn(trx, retryInSeconds),
        locked_at: null,
        locked_by: null,
        last_error: failure.message,
        result: JSON.stringify(failureResult(failure, retryInSeconds)),
      });
    return { recordedAs: 'retrying', listing, retryInSeconds };
  }

  await trx('jobs')
    .where({ id: job.id })
    .update({
      status: 'failed',
      finished_at: utcNow(trx),
      locked_at: null,
      locked_by: null,
      last_error: failure.message,
      result: JSON.stringify(failureResult(failure)),
    });
  if (!newerPending) {
    await queue.updateListing(listing.id, {
      status: 'error',
      last_error: listingErrorFor(job, failure),
    });
  }
  return { recordedAs: 'failed', listing: await queue.findListing(listing.id) };
}

/** For the stale-lock sweep: locks a running job by id, whoever holds it. */
export async function lockRunningJob(
  trx: Knex.Transaction,
  jobId: number,
  listingId: number,
): Promise<LockedJob | null> {
  const queue = createQueueRepository(trx);
  const listing = await queue.lockListing(listingId);
  if (!listing) return null;
  const unfinished = await queue.lockUnfinishedJobs(listingId);
  const job = unfinished.find((candidate) => candidate.id === jobId);
  if (job?.status !== 'running') return null;
  return { job, listing, newerPending: unfinished.some((other) => other.id > job.id) };
}
