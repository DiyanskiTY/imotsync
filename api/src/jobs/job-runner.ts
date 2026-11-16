import type { Knex } from 'knex';
import type { RetryConfig } from '../config.js';
import type { JobAction, JobRow, PortalListingRow } from '../db/types.js';
import type { Logger } from '../logger.js';
import { loadPortalProperty, toPortalListingInfo } from '../portals/property-loader.js';
import type { PortalRegistry } from '../portals/registry.js';
import type { AdapterContext, AdapterOutcome, PortalAdapter } from '../portals/types.js';
import {
  describeFailure,
  JobTimeoutError,
  permanentFailure,
  validationFailure,
  WorkerShutdownError,
  type JobFailure,
} from './failure.js';
import { isOnPortal } from './listing-state.js';
import { recordFailure, recordSuccess, type RecordResult } from './outcome.js';
import { finishRequestedDeletion } from './property-deletion.js';

export interface JobRunnerDeps {
  db: Knex;
  registry: PortalRegistry;
  logger: Logger;
  /** Absolute photo URLs in what adapters receive start with this. */
  publicBaseUrl: string;
  /** Time budget for one job, from the claim to the adapter's answer (JOB_TIMEOUT_SECONDS). */
  jobTimeoutMs: number;
  retry: RetryConfig;
  /** Jitter for the back-off (default Math.random). */
  random?: () => number;
  /** Clock for AdapterContext.now (default: new Date()). */
  now?: () => Date;
}

export interface JobRunReport extends RecordResult {
  jobId: number;
  durationMs: number;
  /** Set when the attempt failed. */
  failure?: JobFailure;
  /**
   * Set after a final outcome (succeeded or failed): whether the job was the last thing a
   * bulk delete waited for, so that the property was deleted.
   */
  propertyDeleted?: boolean;
}

type Attempt = { ok: true; outcome: AdapterOutcome } | { ok: false; failure: JobFailure };

const failed = (failure: JobFailure): Attempt => ({ ok: false, failure });

/**
 * Calls `work` with a signal that aborts at the deadline or when `outer` aborts, and rejects
 * at that moment even if `work` ignores the signal, so no call can hold a job beyond its budget.
 */
export async function withDeadline<T>(
  ms: number,
  outer: AbortSignal | undefined,
  timeoutMessage: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const { signal } = controller;
  const timer = setTimeout(() => {
    controller.abort(new JobTimeoutError(timeoutMessage));
  }, ms);
  const onOuterAbort = () => {
    controller.abort(new WorkerShutdownError('The worker shut down before the portal answered'));
  };
  if (outer?.aborted) onOuterAbort();
  else outer?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    return await new Promise<T>((resolve, reject) => {
      const rejectOnAbort = () => {
        reject(signal.reason as Error);
      };
      if (signal.aborted) {
        rejectOnAbort();
        return;
      }
      signal.addEventListener('abort', rejectOnAbort, { once: true });
      work(signal).then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * The adapter call a job makes. A remove removes. Otherwise the listing's state decides, not
 * the action the job was queued with: a listing that is on the portal is updated, any other
 * is published. So an update queued behind a first publish that then failed publishes, and a
 * publish queued behind a publish that succeeded updates instead of creating the listing twice.
 */
export function effectiveAction(
  action: JobAction,
  listing: Pick<PortalListingRow, 'published_at' | 'removed_at'>,
): JobAction {
  if (action === 'remove') return 'remove';
  return isOnPortal(listing) ? 'update' : 'publish';
}

/**
 * Runs one claimed job: builds the property as adapters see it, validates it (publish and
 * update), calls the adapter and records the outcome. The time budget (JOB_TIMEOUT_SECONDS)
 * starts when the runner receives the job, right after the claim, so loading the property
 * counts against it too. Portal failures are recorded, never thrown. If recording itself fails
 * (database down), the job stays 'running' and the stale-lock sweep returns it to the queue
 * later.
 */
export function createJobRunner(deps: JobRunnerDeps) {
  const { db, registry, logger, publicBaseUrl, jobTimeoutMs } = deps;
  const now = deps.now ?? (() => new Date());
  const failureOptions = { retry: deps.retry, random: deps.random };

  /** Loads and checks the property and calls the adapter, all within `budgetMs`. */
  async function attempt(
    adapter: PortalAdapter,
    job: JobRow,
    listingRow: PortalListingRow,
    budgetMs: number,
    shutdownSignal: AbortSignal | undefined,
  ): Promise<Attempt> {
    const listing = toPortalListingInfo(listingRow);
    const seconds = Math.round(jobTimeoutMs / 1000);
    return withDeadline(
      Math.max(0, budgetMs),
      shutdownSignal,
      `${adapter.displayName} did not answer within ${seconds} s (JOB_TIMEOUT_SECONDS)`,
      async (signal): Promise<Attempt> => {
        const property = await loadPortalProperty(db, listingRow.property_id, { publicBaseUrl });
        if (job.action !== 'remove') {
          if (!property) return failed(permanentFailure('The property no longer exists'));
          // Like the API (publish and retry answer 409): an archived property is not sent.
          if (property.status === 'archived') {
            return failed(permanentFailure('The property is archived', 'ARCHIVED'));
          }
          const issues = adapter.validate(property);
          if (issues.length > 0) return failed(validationFailure(issues));
        }
        // The deadline may have passed while loading: never call the portal after it.
        signal.throwIfAborted();

        const ctx: AdapterContext = { now: now(), signal, attempt: job.attempts };
        let outcome: AdapterOutcome;
        if (job.action === 'remove') {
          outcome = await adapter.remove(listing, property, ctx);
        } else if (!property) {
          throw new Error('unreachable: checked above');
        } else if (job.action === 'publish') {
          outcome = await adapter.publish(property, listing, ctx);
        } else {
          outcome = await adapter.update(property, listing, ctx);
        }
        return { ok: true, outcome };
      },
    );
  }

  /**
   * Stores the call the job is about to make (effectiveAction) when it differs from the action
   * it was queued with, so the job log says what was done. Only while this worker holds it.
   */
  async function settleAction(job: JobRow, listingRow: PortalListingRow): Promise<JobRow> {
    const action = effectiveAction(job.action, listingRow);
    if (action === job.action) return job;
    await db('jobs')
      .where({ id: job.id, status: 'running', attempts: job.attempts })
      .where('locked_by', job.locked_by ?? '')
      .update({ action });
    return { ...job, action };
  }

  /**
   * After a final outcome: if the property waits for a bulk delete and this job was the last
   * thing it waited for, deletes it. An error here is logged on its own (the outcome is
   * already recorded); the worker's periodic check tries again later.
   */
  async function finishDeletion(
    listingRow: PortalListingRow | undefined,
    log: Logger,
  ): Promise<boolean | undefined> {
    if (!listingRow) return undefined;
    try {
      return await finishRequestedDeletion(db, log, listingRow.property_id, {
        removedRetentionDays: registry.removedRetentionDays,
        now: now(),
      });
    } catch (error) {
      log.error(
        { err: error, propertyId: listingRow.property_id },
        'Could not finish the requested deletion of a property; the worker tries again later',
      );
      return false;
    }
  }

  return {
    async runJob(claimed: JobRow, shutdownSignal?: AbortSignal): Promise<JobRunReport> {
      const started = performance.now();
      const elapsed = () => Math.round(performance.now() - started);
      let job = claimed;
      const listingRow = await db('portal_listings').where({ id: job.portal_listing_id }).first();
      const portal = listingRow?.portal ?? 'unknown';
      const log = logger.child({
        jobId: job.id,
        action: job.action,
        portal,
        listingId: job.portal_listing_id,
        propertyId: listingRow?.property_id,
        attempt: job.attempts,
      });
      log.info('Job started');

      const adapter = registry.get(portal);
      let result: Attempt;
      if (!listingRow) {
        result = failed(permanentFailure('The portal listing no longer exists'));
      } else if (!adapter) {
        result = failed(permanentFailure(`No adapter is registered for portal "${portal}"`));
      } else {
        try {
          job = await settleAction(job, listingRow);
          result = await attempt(
            adapter,
            job,
            listingRow,
            jobTimeoutMs - (performance.now() - started),
            shutdownSignal,
          );
        } catch (error) {
          const failure = describeFailure(error);
          if (failure.errorId !== undefined) {
            // The job log only says that something went wrong; the details stay here.
            log.error(
              { err: error, errorId: failure.errorId },
              'Unexpected error while processing the job',
            );
          }
          result = failed(failure);
        }
      }

      if (!result.ok) {
        const { failure } = result;
        const recorded = await recordFailure(db, job, failure, failureOptions);
        const report: JobRunReport = { ...recorded, jobId: job.id, durationMs: elapsed(), failure };
        const fields = {
          recordedAs: recorded.recordedAs,
          error: failure.message,
          retryable: failure.retryable,
          httpStatus: failure.httpStatus,
          retryInSeconds: recorded.retryInSeconds,
          durationMs: report.durationMs,
        };
        if (recorded.recordedAs === 'failed') log.error(fields, 'Job failed');
        else log.warn(fields, recorded.recordedAs === 'lost' ? 'Job lost' : 'Job will be retried');
        if (recorded.recordedAs === 'failed') {
          // A failed removal holds a bulk delete back (the listing is still on its portal),
          // but a failed publish of a listing that never went out may have been the last wait.
          report.propertyDeleted = await finishDeletion(listingRow, log);
        }
        return report;
      }

      const recorded = await recordSuccess(db, job, result.outcome);
      const report: JobRunReport = { ...recorded, jobId: job.id, durationMs: elapsed() };
      const fields = {
        recordedAs: recorded.recordedAs,
        message: result.outcome.message,
        durationMs: report.durationMs,
      };
      if (recorded.recordedAs === 'lost') {
        // The lock expired and the sweep handed the job on: another attempt records the outcome.
        log.warn(fields, 'Job lost: it was no longer held by this worker');
        return report;
      }
      log.info(fields, 'Job succeeded');
      report.propertyDeleted = await finishDeletion(listingRow, log);
      return report;
    },
  };
}

export type JobRunner = ReturnType<typeof createJobRunner>;
