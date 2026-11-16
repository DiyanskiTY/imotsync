import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createRealistimoClient,
  interpretLatestLog,
  interpretStartResponse,
  type RealistimoClient,
} from '../../../../src/portals/realistimo/api-client.js';
import { PortalError } from '../../../../src/portals/types.js';
import { sendJson, startFakeServer, type FakeServer } from './fixtures.js';

/** A latest-log answer shaped like the example in Realistimo's REST documentation. */
const COMPLETED_LOG = {
  message: 'completed',
  logDate: '2026-01-15T12:40:00+02:00',
  logResult: {
    0: 'success_with_warnings',
    found_offers: 3,
    published_found_offers_in_agency: 2,
    imported_offers: 3,
    published_offers: 2,
    not_published: 1,
    removed_offers: 0,
    deleted_offers: 0,
    updated_offers: 1,
    errors: [{ type: 'broker_not_found', count: 1 }],
  },
  logOffers: [
    {
      uuid: 'a1',
      createdAt: '2026-01-15T12:39:00+02:00',
      errors: [],
      offerSourceData: { offer_uid: 'IS-00001' },
    },
    {
      uuid: 'a2',
      createdAt: '2026-01-15T12:39:01+02:00',
      errors: ['Broker not found', { type: 'location', message: 'Unknown internal_id' }],
      offerSourceData: { offer_uid: 'IS-00002' },
    },
  ],
};

let server: FakeServer;
let client: RealistimoClient;

beforeEach(async () => {
  server = await startFakeServer((_request, response) => sendJson(response, 200, {}));
  client = createRealistimoClient({
    apiKey: 'test-api-key',
    baseUrl: `${server.baseUrl}/`,
    timeoutMs: 1000,
  });
});

afterEach(async () => {
  await server.close();
});

async function portalError(promise: Promise<unknown>): Promise<PortalError> {
  const error: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(PortalError);
  return error as PortalError;
}

describe('Realistimo client requests', () => {
  it('POSTs to the import endpoints with the API-KEY and Accept headers', async () => {
    server.handle((_request, response) => sendJson(response, 200, { message: 'import-in-queue' }));

    await client.start();
    server.handle((_request, response) => sendJson(response, 200, { message: null }));
    await client.latestLog();

    expect(server.requests.map((request) => [request.method, request.url])).toEqual([
      ['POST', '/rest-api/import/start'],
      ['POST', '/rest-api/import/latest-log'],
    ]);
    for (const request of server.requests) {
      expect(request.headers['api-key']).toBe('test-api-key');
      expect(request.headers.accept).toBe('application/json');
      // The key never goes into the URL (the deprecated apikey parameter).
      expect(request.url).not.toContain('apikey');
      expect(request.body).toBe('');
    }
  });

  it('refuses to start without a key', () => {
    expect(() => createRealistimoClient({ apiKey: ' ', baseUrl: server.baseUrl })).toThrow(
      /API key is required/,
    );
  });
});

describe('Realistimo start()', () => {
  it.each([
    ['import-in-queue', 'queued'],
    ['import-is-allowed-between-the-time', 'outside-window'],
    ['import-in-progress', 'in-progress'],
    ['import-request-cooldown-is-time-given', 'cooldown'],
    ['error-while-importing', 'no-feed'],
    // The test key answers with text instead of the slug.
    ['Import in queue', 'queued'],
    ['something-new', 'unknown'],
  ])('maps the HTTP 200 message %s to %s', async (message, outcome) => {
    server.handle((_request, response) => sendJson(response, 200, { message }));

    await expect(client.start()).resolves.toEqual({ outcome, message });
  });

  it('reads "Agency not found" from the error key of an HTTP 200 answer', async () => {
    server.handle((_request, response) => sendJson(response, 200, { error: 'Agency not found' }));

    await expect(client.start()).resolves.toEqual({
      outcome: 'agency-not-found',
      message: 'Agency not found',
    });
  });

  it.each([
    'API key is missing in request',
    'API key could not be found',
    'API key is inactive',
    'API key is expired',
    'User is inactive',
    'User account is expired',
  ])('turns HTTP 401 "%s" into a permanent error', async (message) => {
    server.handle((_request, response) => sendJson(response, 401, { status: 'error', message }));

    const error = await portalError(client.start());

    expect(error.retryable).toBe(false);
    expect(error.message).toBe(`Realistimo rejected the API key: ${message}`);
    expect(error.options).toMatchObject({ code: 'unauthorized', httpStatus: 401 });
  });

  it('retries on HTTP 5xx', async () => {
    server.handle((_request, response) => {
      response.writeHead(503);
      response.end('maintenance');
    });

    const error = await portalError(client.start());

    expect(error.retryable).toBe(true);
    expect(error.options.httpStatus).toBe(503);
  });

  it('retries on HTTP 429 after the Retry-After delay', async () => {
    server.handle((_request, response) => {
      response.writeHead(429, { 'Retry-After': '120' });
      response.end();
    });

    const error = await portalError(client.start());

    expect(error.retryable).toBe(true);
    expect(error.options).toMatchObject({ httpStatus: 429, retryAfterMs: 120_000 });
  });

  it('does not retry other 4xx answers', async () => {
    server.handle((_request, response) => sendJson(response, 404, { message: 'Not found' }));

    const error = await portalError(client.start());

    expect(error.retryable).toBe(false);
    expect(error.options.httpStatus).toBe(404);
  });

  it.each([301, 302, 307, 308])(
    'never follows an HTTP %i redirect, so the API key stays with the configured host',
    async (status) => {
      const elsewhere = await startFakeServer((_request, response) =>
        sendJson(response, 200, { message: 'import-in-queue' }),
      );
      try {
        server.handle((_request, response) => {
          response.writeHead(status, { Location: `${elsewhere.baseUrl}/rest-api/import/start` });
          response.end();
        });

        const error = await portalError(client.start());

        expect(error.retryable).toBe(false);
        expect(error.options).toMatchObject({ code: 'redirect', httpStatus: status });
        expect(error.message).toContain(`HTTP ${status} to ${elsewhere.baseUrl}`);
        expect(elsewhere.requests).toEqual([]);
        expect(server.requests).toHaveLength(1);
      } finally {
        await elsewhere.close();
      }
    },
  );

  it('retries an answer that is not JSON', async () => {
    server.handle((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<html>challenge</html>');
    });

    const error = await portalError(client.start());

    expect(error.retryable).toBe(true);
    expect(error.options.code).toBe('bad-response');
  });

  it('retries when the server cannot be reached', async () => {
    const closed = createRealistimoClient({ apiKey: 'k', baseUrl: server.baseUrl });
    await server.close();

    const error = await portalError(closed.start());

    expect(error.retryable).toBe(true);
    expect(error.options.code).toBe('network');
    expect(error.message).toMatch(/could not be reached/);

    // afterEach closes again; give it a fresh server.
    server = await startFakeServer((_request, response) => sendJson(response, 200, {}));
  });

  it('retries when the connection drops mid-request', async () => {
    server.handle((_request, response) => {
      response.socket?.destroy();
    });

    const error = await portalError(client.start());

    expect(error.retryable).toBe(true);
    expect(error.options.code).toBe('network');
  });

  it('gives up after the timeout and retries later', async () => {
    server.handle(() => {
      // Never answers.
    });
    const slow = createRealistimoClient({ apiKey: 'k', baseUrl: server.baseUrl, timeoutMs: 100 });

    const error = await portalError(slow.start());

    expect(error.retryable).toBe(true);
    expect(error.options.code).toBe('timeout');
    expect(error.message).toBe('Realistimo /rest-api/import/start did not answer within 100 ms');
  });

  it('stops when the caller cancels', async () => {
    server.handle(() => {
      // Never answers.
    });
    const controller = new AbortController();
    const pending = client.start(controller.signal);
    controller.abort();

    const error = await portalError(pending);

    expect(error.options.code).toBe('aborted');
  });
});

describe('Realistimo latestLog()', () => {
  it('interprets a completed import', async () => {
    server.handle((_request, response) => sendJson(response, 200, COMPLETED_LOG));

    const log = await client.latestLog();

    expect(log).toEqual({
      state: 'completed',
      logDate: new Date('2026-01-15T10:40:00Z'),
      result: 'success_with_warnings',
      counts: {
        foundOffers: 3,
        publishedFoundOffersInAgency: 2,
        importedOffers: 3,
        publishedOffers: 2,
        notPublished: 1,
        removedOffers: 0,
        deletedOffers: 0,
        updatedOffers: 1,
      },
      errorTypes: [{ type: 'broker_not_found', count: 1 }],
      offers: [
        { offerUid: 'IS-00001', uuid: 'a1', createdAt: '2026-01-15T12:39:00+02:00', errors: [] },
        {
          offerUid: 'IS-00002',
          uuid: 'a2',
          createdAt: '2026-01-15T12:39:01+02:00',
          errors: ['Broker not found', 'location: Unknown internal_id'],
        },
      ],
      earlyStop: null,
    });
  });

  it('accepts the test-key variant with logResult and logOffers as JSON strings', async () => {
    server.handle((_request, response) =>
      sendJson(response, 200, {
        ...COMPLETED_LOG,
        logResult: JSON.stringify(COMPLETED_LOG.logResult),
        logOffers: JSON.stringify(COMPLETED_LOG.logOffers),
      }),
    );

    const log = await client.latestLog();

    expect(log.result).toBe('success_with_warnings');
    expect(log.counts.foundOffers).toBe(3);
    expect(log.offers.map((offer) => offer.offerUid)).toEqual(['IS-00001', 'IS-00002']);
  });

  it('reports an import that stopped before the offers', async () => {
    server.handle((_request, response) =>
      sendJson(response, 200, {
        message: 'completed',
        logDate: '2026-01-15T12:40:00+02:00',
        logResult: ['Feed is not changed since last import'],
        logOffers: [],
      }),
    );

    const log = await client.latestLog();

    expect(log).toMatchObject({
      state: 'completed',
      result: null,
      earlyStop: 'Feed is not changed since last import',
      offers: [],
    });
  });

  it.each([
    ['pending', 'pending'],
    ['in_progress', 'in_progress'],
    [null, 'none'],
  ])('maps message %s to state %s', async (message, state) => {
    server.handle((_request, response) => sendJson(response, 200, { message }));

    const log = await client.latestLog();

    expect(log.state).toBe(state);
    expect(log.logDate).toBeNull();
    expect(log.offers).toEqual([]);
  });

  it('uses the same error handling as start()', async () => {
    server.handle((_request, response) =>
      sendJson(response, 401, { status: 'error', message: 'API key is inactive' }),
    );

    const error = await portalError(client.latestLog());

    expect(error.retryable).toBe(false);
    expect(error.message).toBe('Realistimo rejected the API key: API key is inactive');
  });
});

describe('response interpretation edge cases', () => {
  it('start: a body without message or error is unknown', () => {
    expect(interpretStartResponse({})).toEqual({ outcome: 'unknown', message: '' });
    expect(interpretStartResponse({ error: 'Something else' })).toEqual({
      outcome: 'unknown',
      message: 'Something else',
    });
  });

  it('latest-log: tolerates numeric strings, odd error items and missing offer ids', () => {
    const log = interpretLatestLog({
      message: 'completed',
      logDate: 'not a date',
      logResult: { 0: 'success', found_offers: '7', errors: [{ count: 2 }, { type: 'x' }] },
      logOffers: [
        { errors: ['no id'], offerSourceData: {} },
        { errors: [42, null, { code: 'E1' }, { foo: 'bar' }], offerSourceData: { offer_uid: 9 } },
      ],
    });

    expect(log.logDate).toBeNull();
    expect(log.result).toBe('success');
    expect(log.counts.foundOffers).toBe(7);
    expect(log.counts.updatedOffers).toBeNull();
    expect(log.errorTypes).toEqual([{ type: 'x', count: 0 }]);
    expect(log.offers).toEqual([
      { offerUid: '9', uuid: null, createdAt: null, errors: ['42', 'E1', '{"foo":"bar"}'] },
    ]);
  });

  it('latest-log: a non-JSON string result is kept as the stop reason', () => {
    expect(interpretLatestLog({ message: 'completed', logResult: 'Feed too old' }).earlyStop).toBe(
      'Feed too old',
    );
  });
});
