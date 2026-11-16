const errorCode = (error: unknown): unknown =>
  typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;

/** A unique index rejected the insert or update (MariaDB ER_DUP_ENTRY, 1062). */
export function isDuplicateKeyError(error: unknown): boolean {
  return errorCode(error) === 'ER_DUP_ENTRY';
}

/**
 * InnoDB gave up on the transaction because of a lock conflict: a deadlock (1213, the
 * transaction was rolled back) or a lock wait timeout (1205). Running the whole transaction
 * again is the documented remedy.
 */
export function isLockConflictError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT';
}
