import type { Knex } from 'knex';
import type { RetryConfig } from '../config.js';
import type { JobRow } from '../db/types.js';
import type { Logger } from '../logger.js';
import { permanentFailure, type JobFailure } from './failure.js';
import { applyFailure, lockRunningJob, type RecordedAs } from './outcome.js';
import { queueTransaction } from './transaction.js';

export interface SweepOptions {
  /** A running job locked longer than this is considered abandoned. */
  lockTimeoutSeconds: number;
  retry: RetryConfig;
  random?: () => number;
  logger?: Logger;
}

export interface SweepResult {
  /** Jobs put back into the queue (attempts left). */
  requeued: number;
  /** Jobs failed for good (no attempts left). */
  failed: number;
}

const staleCondition = (db: Knex, lockTimeoutSeconds: number) =>
  db.raw('locked_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? SECOND)', [lockTimeoutSeconds]);

/**
 * Returns abandoned jobs to the queue: a job still 'running' long after `locked_at` belongs
 * to a worker that crashed or was killed. With attempts left it is queued again (after the
 * usual back-off); without, it fails and its listing moves to 'error'.
 */
export async function sweepStaleJobs(db: Knex, options: SweepOptions): Promise<SweepResult> {
  const { lockTimeoutSeconds } = options;
  const stale = await db('jobs')
    .where({ status: 'running' })
    .whereRaw(staleCondition(db, lockTimeoutSeconds))
    .orderBy('id')
    .select<Pick<JobRow, 'id' | 'portal_listing_id'>[]>('id', 'portal_listing_id');

  const result: SweepResult = { requeued: 0, failed: 0 };
  for (const { id, portal_listing_id: listingId } of stale) {
    const recordedAs = await queueTransaction(db, async (trx): Promise<RecordedAs> => {
      const locked = await lockRunningJob(trx, id, listingId);
      if (!locked) return 'lost';
      // Checked again under the lock: the worker may have finished it in the meantime.
      const stillStale = await trx('jobs')
        .where({ id, status: 'running' })
        .whereRaw(staleCondition(trx, lockTimeoutSeconds))
        .first<Pick<JobRow, 'id'> | undefined>('id');
      if (!stillStale) return 'lost';

      const holder = locked.job.locked_by ?? 'unknown worker';
      const failure: JobFailure = {
        message: `The worker running this job (${holder}) stopped responding: its lock is older than ${lockTimeoutSeconds} s`,
        retryable: true,
        code: 'LOCK_EXPIRED',
      };
      const applied =
        locked.job.attempts < locked.job.max_attempts
          ? failure
          : permanentFailure(`${failure.message}, and no attempts are left`, 'LOCK_EXPIRED');
      return (await applyFailure(trx, locked, applied, options)).recordedAs;
    });

    if (recordedAs === 'retrying') result.requeued++;
    if (recordedAs === 'failed') result.failed++;
    if (recordedAs !== 'lost') {
      options.logger?.warn(
        { jobId: id, listingId, recordedAs },
        'Swept a job with an expired lock',
      );
    }
  }
  return result;
}
