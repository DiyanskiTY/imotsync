export class TimeoutError extends Error {
  override readonly name = 'TimeoutError';
}

/**
 * Resolves with the promise's value, or rejects with TimeoutError after `ms`.
 * The original promise keeps running; a late rejection from it is swallowed so it
 * can never surface as an unhandled rejection.
 */
export async function withTimeout<T>(
  promise: PromiseLike<T>,
  ms: number,
  what: string,
): Promise<T> {
  const work = Promise.resolve(promise);
  work.catch(() => undefined);

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(`${what} timed out after ${ms} ms`));
    }, ms);
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
