import knex from 'knex';
import { describe, expect, it, vi } from 'vitest';
import { claimNextJob, claimQuery } from '../../../src/jobs/claim.js';
import {
  describeFailure,
  JobTimeoutError,
  UNEXPECTED_ERROR_MESSAGE,
  permanentFailure,
  validationFailure,
  WorkerShutdownError,
} from '../../../src/jobs/failure.js';
import { withDeadline } from '../../../src/jobs/job-runner.js';
import { failureResult, listingErrorFor, successResult } from '../../../src/jobs/outcome.js';
import { PortalError } from '../../../src/portals/types.js';

describe('describeFailure', () => {
  it('takes retryable, Retry-After, HTTP status and code from a PortalError', () => {
    const error = new PortalError('Portal answered HTTP 429', true, {
      httpStatus: 429,
      retryAfterMs: 5000,
      code: 'RATE_LIMITED',
    });

    expect(describeFailure(error)).toEqual({
      message: 'Portal answered HTTP 429',
      retryable: true,
      retryAfterMs: 5000,
      httpStatus: 429,
      code: 'RATE_LIMITED',
    });
    expect(describeFailure(new PortalError('Invalid API key', false))).toEqual({
      message: 'Invalid API key',
      retryable: false,
    });
  });

  it('retries a call that ran out of time or was cut short by a shutdown', () => {
    expect(describeFailure(new JobTimeoutError('No answer within 60 s'))).toEqual({
      message: 'No answer within 60 s',
      retryable: true,
      code: 'TIMEOUT',
    });
    expect(describeFailure(new WorkerShutdownError('Shutting down'))).toMatchObject({
      retryable: true,
      code: 'SHUTDOWN',
    });
  });

  it('retries anything unexpected, storing only a generic message with an error id', () => {
    const failure = describeFailure(new TypeError('x is undefined'));

    expect(failure).toEqual({
      message: `${UNEXPECTED_ERROR_MESSAGE}. Error id: ${failure.errorId ?? ''}`,
      retryable: true,
      code: 'UNEXPECTED',
      errorId: expect.stringMatching(/^[0-9a-f]{12}$/) as string,
    });
    expect(UNEXPECTED_ERROR_MESSAGE).toBe(
      'Unexpected error while processing the job (see worker logs)',
    );
    expect(describeFailure('a string').code).toBe('UNEXPECTED');
    // A new id for every error, so each can be found in the worker log.
    expect(describeFailure(new Error('a')).errorId).not.toBe(
      describeFailure(new Error('a')).errorId,
    );
  });

  it('never stores the details of an unexpected error (SQL, server messages, paths)', () => {
    const sqlError = Object.assign(
      new Error("insert into `jobs` (`secret`) values ('x') - ER_ACCESS_DENIED_ERROR"),
      { sql: 'insert into jobs ...', code: 'ER_ACCESS_DENIED_ERROR' },
    );
    const pathError = new Error("ENOENT: no such file or directory, open '/srv/uploads/x.jpg'");

    for (const error of [sqlError, pathError, new Error('x'.repeat(10_000))]) {
      const { message } = describeFailure(error);
      expect(message.startsWith(UNEXPECTED_ERROR_MESSAGE)).toBe(true);
      expect(message).not.toMatch(/insert|ER_ACCESS|ENOENT|uploads|xxx/);
    }
  });
});

describe('validation and permanent failures', () => {
  it('lists every issue as "field: message", never retried', () => {
    expect(
      validationFailure([
        { field: 'price', message: 'Realistimo needs a price above 0.' },
        { field: 'images', message: 'Realistimo needs at least one photo.' },
      ]),
    ).toEqual({
      message:
        'Validation failed: price: Realistimo needs a price above 0.; images: Realistimo needs at least one photo.',
      retryable: false,
      code: 'VALIDATION',
    });
  });

  it('builds a permanent failure with an optional code', () => {
    expect(permanentFailure('No adapter')).toEqual({ message: 'No adapter', retryable: false });
    expect(permanentFailure('No adapter', 'NO_ADAPTER').code).toBe('NO_ADAPTER');
  });
});

describe('job results', () => {
  it('records the message, the external id and the details of a success', () => {
    expect(successResult({ message: 'Published', externalId: 'demo-000001' })).toEqual({
      message: 'Published',
      externalId: 'demo-000001',
    });
    expect(
      successResult({ message: 'Added to the feed', payload: { a: 1 }, details: { n: 2 } }),
    ).toEqual({ message: 'Added to the feed', details: { n: 2 } });
    expect(successResult({ message: 'Gone', externalId: null })).toEqual({ message: 'Gone' });
  });

  it('records the error of a failure, with the wait before the next attempt', () => {
    expect(
      failureResult({ message: 'HTTP 503', retryable: true, httpStatus: 503, code: 'X' }, 30),
    ).toEqual({
      error: 'HTTP 503',
      retryable: true,
      httpStatus: 503,
      code: 'X',
      retryInSeconds: 30,
    });
    expect(failureResult({ message: 'Rejected', retryable: false })).toEqual({
      error: 'Rejected',
      retryable: false,
    });
  });

  it('explains on the listing when the worker gave up after retrying', () => {
    expect(listingErrorFor({ attempts: 5 }, { message: 'HTTP 503', retryable: true })).toBe(
      'Gave up after 5 attempts: HTTP 503',
    );
    expect(listingErrorFor({ attempts: 1 }, { message: 'Rejected', retryable: false })).toBe(
      'Rejected',
    );
  });
});

describe('withDeadline', () => {
  it('resolves with the work result and hands the work a live signal', async () => {
    let seen: AbortSignal | undefined;
    const result = await withDeadline(1000, undefined, 'too slow', (signal) => {
      seen = signal;
      return Promise.resolve(42);
    });

    expect(result).toBe(42);
    expect(seen?.aborted).toBe(false);
  });

  it('passes the rejection of the work through', async () => {
    await expect(
      withDeadline(1000, undefined, 'too slow', () => Promise.reject(new PortalError('no', false))),
    ).rejects.toBeInstanceOf(PortalError);
  });

  it('rejects at the deadline even when the work ignores the signal', async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | undefined;
      const call = withDeadline(60_000, undefined, 'Demo did not answer within 60 s', (signal) => {
        seen = signal;
        return new Promise<never>(() => undefined);
      });
      const outcome = call.then(
        () => 'resolved',
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(60_000);

      const error = await outcome;
      expect(error).toBeInstanceOf(JobTimeoutError);
      expect((error as Error).message).toBe('Demo did not answer within 60 s');
      expect(seen?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts with a shutdown error when the outer signal fires', async () => {
    const outer = new AbortController();
    let seen: AbortSignal | undefined;
    const call = withDeadline(60_000, outer.signal, 'too slow', (signal) => {
      seen = signal;
      return new Promise<never>(() => undefined);
    });
    outer.abort();

    await expect(call).rejects.toBeInstanceOf(WorkerShutdownError);
    expect(seen?.aborted).toBe(true);
  });

  it('does not start the work when the outer signal has already fired', async () => {
    const outer = new AbortController();
    outer.abort();
    const work = vi.fn(() => Promise.resolve('done'));

    await expect(withDeadline(1000, outer.signal, 'too slow', work)).rejects.toBeInstanceOf(
      WorkerShutdownError,
    );
    expect(work).not.toHaveBeenCalled();
  });
});

describe('claim query', () => {
  const db = knex({ client: 'mysql2' });

  it('takes the oldest due job whose listing has no older unfinished job, skipping locked rows', () => {
    const { sql, bindings } = claimQuery(db).toSQL();
    const flat = sql.replace(/\s+/g, ' ');

    expect(flat).toContain("WHERE j.status = 'queued' AND j.run_after <= UTC_TIMESTAMP()");
    expect(flat).toContain(
      "AND NOT EXISTS (SELECT 1 FROM jobs o WHERE o.portal_listing_id = j.portal_listing_id AND o.id < j.id AND o.status IN ('queued', 'running'))",
    );
    expect(flat).toContain('ORDER BY j.run_after, j.id LIMIT 1 FOR UPDATE SKIP LOCKED');
    expect(flat).not.toContain('portal_listings');
    expect(bindings).toEqual([]);
  });

  it('can be limited to the portals a worker has adapters for, as bound values', () => {
    const { sql, bindings } = claimQuery(db, ['demo', 'bazar']).toSQL();

    expect(sql.replace(/\s+/g, ' ')).toContain(
      'AND (SELECT l.portal FROM portal_listings l WHERE l.id = j.portal_listing_id) IN (?, ?)',
    );
    expect(bindings).toEqual(['demo', 'bazar']);
  });

  it('claims nothing, without a query, for a worker with no adapters', async () => {
    const unused = vi.fn();
    await expect(
      claimNextJob(unused as unknown as typeof db, { workerId: 'w', portals: [] }),
    ).resolves.toBeNull();
    expect(unused).not.toHaveBeenCalled();
  });
});
