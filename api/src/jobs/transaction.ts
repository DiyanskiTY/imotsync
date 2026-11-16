import type { Knex } from 'knex';
import { isLockConflictError } from '../lib/db-errors.js';

/** How often a transaction that InnoDB rolled back for a lock conflict is run again. */
export const LOCK_CONFLICT_RETRIES = 3;

/**
 * Runs `work` in a READ COMMITTED transaction and runs it again (up to 3 more times) when
 * InnoDB gives up on it with a deadlock or a lock wait timeout.
 *
 * Every transaction that queues jobs, claims them or records their outcome uses this:
 * - READ COMMITTED takes no gap locks. Under REPEATABLE READ two transactions that look
 *   for the (missing) jobs of two new listings with FOR UPDATE can lock the same gap of the
 *   portal_listing_id index and then block each other's INSERT, a deadlock.
 * - Correctness does not depend on the isolation level: the rows that matter are always read
 *   with FOR UPDATE (which reads the latest committed version), after locking the listing.
 * - `work` must be safe to run again: it re-reads everything it decides on.
 */
export async function queueTransaction<T>(
  db: Knex,
  work: (trx: Knex.Transaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(work, { isolationLevel: 'read committed' });
    } catch (error) {
      if (attempt >= LOCK_CONFLICT_RETRIES || !isLockConflictError(error)) throw error;
    }
  }
}

/** SQL for "now" on the database clock, in UTC like every DATETIME column. */
export const utcNow = (db: Knex): Knex.Raw => db.raw('UTC_TIMESTAMP()');

/** SQL for "now + seconds" on the database clock. */
export const utcIn = (db: Knex, seconds: number): Knex.Raw =>
  db.raw('DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND)', [Math.max(0, Math.ceil(seconds))]);
