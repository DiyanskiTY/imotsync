/** A unique index rejected the insert or update (MariaDB ER_DUP_ENTRY, 1062). */
export function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ER_DUP_ENTRY'
  );
}
