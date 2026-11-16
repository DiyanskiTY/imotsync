import type { Knex } from 'knex';
import type { JobRow } from '../db/types.js';
import { queueTransaction, utcNow } from './transaction.js';

/** jobs.locked_by is VARCHAR(64). */
export const MAX_WORKER_ID_LENGTH = 64;

export interface ClaimOptions {
  /** Recorded in jobs.locked_by, e.g. "host:1234:ab12cd". */
  workerId: string;
  /**
   * Portals this worker has adapters for. Jobs of other portals stay queued (and visible in
   * the job log) instead of failing, e.g. while a deployment runs without one of the adapters.
   * Omitted: any portal.
   */
  portals?: readonly string[];
}

/**
 * The oldest due job whose listing has no older unfinished job (docs/architecture.md,
 * "Claiming jobs safely"):
 *
 * - FOR UPDATE SKIP LOCKED: concurrent workers skip a row another transaction has locked
 *   instead of waiting for it or claiming it twice.
 * - The NOT EXISTS subquery is a plain, non-locking read (checked on MariaDB 11.8). It asks
 *   whether an OLDER job of the listing is unfinished, which a concurrent, uncommitted claim
 *   (queued -> running) cannot change, so two jobs of one listing never run at the same time.
 * - The portal filter is a scalar subquery on purpose: an IN/EXISTS subquery could be turned
 *   into a semi-join, whose portal_listings rows FOR UPDATE would then lock too.
 */
export function claimQuery(db: Knex, portals?: readonly string[]): Knex.Raw {
  const portalFilter =
    portals === undefined
      ? ''
      : `AND (SELECT l.portal FROM portal_listings l WHERE l.id = j.portal_listing_id) IN (${portals
          .map(() => '?')
          .join(', ')})`;
  return db.raw(
    `SELECT j.id
       FROM jobs j
      WHERE j.status = 'queued'
        AND j.run_after <= UTC_TIMESTAMP()
        AND NOT EXISTS (SELECT 1
                          FROM jobs o
                         WHERE o.portal_listing_id = j.portal_listing_id
                           AND o.id < j.id
                           AND o.status IN ('queued', 'running'))
        ${portalFilter}
      ORDER BY j.run_after, j.id
      LIMIT 1
        FOR UPDATE SKIP LOCKED`,
    [...(portals ?? [])],
  );
}

/** mysql2 answers a raw SELECT with [rows, fields]. */
type RawResult<Row> = [Row[], unknown];

/**
 * Claims the next due job: marks it running, locked by this worker, with attempts + 1, in a
 * short transaction of its own. The adapter call happens after this commits, so no lock is
 * held during network I/O. Returns null when no job is due.
 */
export async function claimNextJob(db: Knex, options: ClaimOptions): Promise<JobRow | null> {
  const { workerId, portals } = options;
  if (portals?.length === 0) return null;

  return queueTransaction(db, async (trx) => {
    const [rows] = (await claimQuery(trx, portals)) as RawResult<{ id: number }>;
    const id = rows[0]?.id;
    if (id === undefined) return null;

    await trx('jobs')
      .where({ id })
      .update({
        status: 'running',
        locked_at: utcNow(trx),
        locked_by: workerId.slice(0, MAX_WORKER_ID_LENGTH),
        attempts: trx.raw('attempts + 1'),
      });
    const job = await trx('jobs').where({ id }).first();
    return job ?? null;
  });
}
