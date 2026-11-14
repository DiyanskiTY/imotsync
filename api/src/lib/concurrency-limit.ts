/**
 * A fixed number of slots for work that must not run too many times at once, such as
 * photo uploads, which hold their files in memory. The count is per API process.
 */
export interface ConcurrencyLimit {
  /** Takes a slot and returns the function that frees it, or undefined when all are taken. */
  tryAcquire(): (() => void) | undefined;
  /** Slots in use right now. */
  readonly active: number;
}

export function createConcurrencyLimit(max: number): ConcurrencyLimit {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(`A concurrency limit must be a positive integer, not ${max}`);
  }
  let active = 0;
  return {
    tryAcquire() {
      if (active >= max) return undefined;
      active++;
      let released = false;
      return () => {
        // Freeing a slot twice must not free someone else's.
        if (released) return;
        released = true;
        active--;
      };
    },
    get active() {
      return active;
    },
  };
}
