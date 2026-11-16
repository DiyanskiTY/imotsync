import { describe, expect, it } from 'vitest';
import {
  createRealistimoClient,
  type LatestLogResult,
  type RealistimoClient,
  type StartImportResult,
} from '../../../../src/portals/realistimo/api-client.js';
import {
  AWAIT_RESULT_MAX_MS,
  decideImportTrigger,
  EMPTY_SYNC_STATE,
  offerErrorsFromLog,
  offersOkFromLog,
  parseSyncSummary,
  runRealistimoSyncCycle,
  type RealistimoSyncState,
} from '../../../../src/portals/realistimo/sync.js';
import { PortalError } from '../../../../src/portals/types.js';
import { sendJson, startFakeServer } from './fixtures.js';

// 10:00 UTC on a winter day is 12:00 in Sofia, inside the 08:00-20:59 import window.
const NOON = new Date('2026-01-15T10:00:00Z');
const minutes = (count: number, from = NOON) => new Date(from.getTime() + count * 60_000);

function log(overrides: Partial<LatestLogResult> = {}): LatestLogResult {
  return {
    state: 'none',
    logDate: null,
    result: null,
    counts: {
      foundOffers: null,
      publishedFoundOffersInAgency: null,
      importedOffers: null,
      publishedOffers: null,
      notPublished: null,
      removedOffers: null,
      deletedOffers: null,
      updatedOffers: null,
    },
    errorTypes: [],
    offers: [],
    earlyStop: null,
    ...overrides,
  };
}

interface FakeClient extends RealistimoClient {
  calls: string[];
}

function fakeClient(options: {
  log?: LatestLogResult | Error;
  start?: StartImportResult | Error;
}): FakeClient {
  const calls: string[] = [];
  return {
    calls,
    latestLog() {
      calls.push('latestLog');
      const answer = options.log ?? log();
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    start() {
      calls.push('start');
      const answer = options.start ?? { outcome: 'queued', message: 'import-in-queue' };
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
}

describe('decideImportTrigger', () => {
  const base = {
    now: NOON,
    feedChangedAt: minutes(-5),
    lastTriggeredAt: minutes(-60),
    lastImportAt: minutes(-60),
    importRunning: false,
  };

  it('triggers when the feed changed and Realistimo would accept an import', () => {
    expect(decideImportTrigger(base)).toEqual({ trigger: true });
    expect(decideImportTrigger({ ...base, lastTriggeredAt: null, lastImportAt: null })).toEqual({
      trigger: true,
    });
  });

  it('waits for a change of the feed', () => {
    expect(decideImportTrigger({ ...base, feedChangedAt: null })).toEqual({
      trigger: false,
      reason: 'unchanged',
    });
    expect(decideImportTrigger({ ...base, feedChangedAt: minutes(-60) })).toEqual({
      trigger: false,
      reason: 'unchanged',
    });
  });

  it('does not ask while an import is queued or running', () => {
    expect(decideImportTrigger({ ...base, importRunning: true })).toEqual({
      trigger: false,
      reason: 'running',
    });
  });

  it('asks only between 08:00 and 20:59 Bulgarian time', () => {
    // 19:00 UTC is 21:00 in Sofia in winter.
    expect(decideImportTrigger({ ...base, now: new Date('2026-01-15T19:00:00Z') })).toEqual({
      trigger: false,
      reason: 'outside-window',
    });
  });

  it('respects the 30-minute cooldown after the last import', () => {
    expect(decideImportTrigger({ ...base, lastImportAt: minutes(-29) })).toEqual({
      trigger: false,
      reason: 'cooldown',
    });
    expect(decideImportTrigger({ ...base, lastImportAt: minutes(-30) })).toEqual({
      trigger: true,
    });
  });
});

describe('per-offer results of an import', () => {
  const completed = log({
    state: 'completed',
    logDate: NOON,
    offers: [
      { offerUid: 'IS-00001', uuid: 'a', createdAt: null, errors: [] },
      { offerUid: 'IS-00002', uuid: 'b', createdAt: null, errors: ['Broker not found'] },
      {
        offerUid: 'IS-00002',
        uuid: 'c',
        createdAt: null,
        errors: ['Broker not found', 'Unknown subcategory'],
      },
    ],
  });

  it('gives one error per offer, prefixed for last_error', () => {
    expect(offerErrorsFromLog(completed)).toEqual([
      {
        offerUid: 'IS-00002',
        lastError: 'Realistimo import: Broker not found; Unknown subcategory',
      },
    ]);
  });

  it('lists the offers without errors', () => {
    expect(offersOkFromLog(completed)).toEqual(['IS-00001']);
  });

  it('keeps last_error to a reasonable length', () => {
    const long = log({
      offers: [{ offerUid: 'IS-1', uuid: null, createdAt: null, errors: ['x'.repeat(5000)] }],
    });

    expect(offerErrorsFromLog(long)[0]?.lastError).toHaveLength(2000);
  });
});

describe('parseSyncSummary', () => {
  it('reads the JSON column as an object or as text', () => {
    const summary = { lastAttempt: null, log: null };

    expect(parseSyncSummary(summary)).toEqual(summary);
    expect(parseSyncSummary(JSON.stringify(summary))).toEqual(summary);
    expect(parseSyncSummary(null)).toBeNull();
    expect(parseSyncSummary('not json')).toBeNull();
    expect(parseSyncSummary([1, 2])).toBeNull();
  });
});

describe('runRealistimoSyncCycle', () => {
  it('asks for an import when the feed changed, and remembers it', async () => {
    const client = fakeClient({});

    const result = await runRealistimoSyncCycle({
      client,
      now: NOON,
      state: EMPTY_SYNC_STATE,
      feedChangedAt: minutes(-2),
    });

    expect(client.calls).toEqual(['latestLog', 'start']);
    expect(result.decision).toEqual({ trigger: true });
    expect(result.started).toBe('queued');
    expect(result.awaitingResult).toBe(true);
    expect(result.error).toBeNull();
    expect(result.state).toEqual({
      lastTriggeredAt: NOON,
      lastTriggerMessage: 'queued',
      lastLogDate: null,
      lastResult: {
        lastAttempt: { at: NOON.toISOString(), outcome: 'queued', message: 'import-in-queue' },
        log: null,
      },
    });
  });

  it('then waits for the import and applies its per-offer errors once', async () => {
    const triggered: RealistimoSyncState = {
      ...EMPTY_SYNC_STATE,
      lastTriggeredAt: NOON,
      lastTriggerMessage: 'queued',
    };

    // The import runs: nothing to do but wait.
    const running = await runRealistimoSyncCycle({
      client: fakeClient({ log: log({ state: 'in_progress', logDate: minutes(1) }) }),
      now: minutes(5),
      state: triggered,
      feedChangedAt: minutes(-2),
    });
    expect(running.decision).toEqual({ trigger: false, reason: 'unchanged' });
    expect(running.awaitingResult).toBe(true);
    expect(running.newLog).toBe(false);

    // The import completed with an error for one offer.
    const completed = log({
      state: 'completed',
      logDate: minutes(3),
      result: 'success_with_warnings',
      offers: [
        { offerUid: 'IS-00001', uuid: 'a', createdAt: null, errors: [] },
        { offerUid: 'IS-00002', uuid: 'b', createdAt: null, errors: ['Broker not found'] },
      ],
    });
    const done = await runRealistimoSyncCycle({
      client: fakeClient({ log: completed }),
      now: minutes(10),
      state: running.state,
      feedChangedAt: minutes(-2),
    });
    expect(done.newLog).toBe(true);
    expect(done.offerErrors).toEqual([
      { offerUid: 'IS-00002', lastError: 'Realistimo import: Broker not found' },
    ]);
    expect(done.offersOk).toEqual(['IS-00001']);
    expect(done.awaitingResult).toBe(false);
    expect(done.state.lastLogDate).toEqual(minutes(3));
    expect(done.state.lastResult?.log).toMatchObject({
      logDate: minutes(3).toISOString(),
      result: 'success_with_warnings',
      offersWithErrors: 1,
    });

    // The same log is not applied twice (the state went through JSON in the database).
    const again = await runRealistimoSyncCycle({
      client: fakeClient({ log: completed }),
      now: minutes(20),
      state: { ...done.state, lastResult: JSON.parse(JSON.stringify(done.state.lastResult)) },
      feedChangedAt: minutes(-2),
    });
    expect(again.newLog).toBe(false);
    expect(again.offerErrors).toEqual([]);
    expect(again.state.lastResult?.log?.offersWithErrors).toBe(1);
  });

  it('processes the result of a scheduled import it did not ask for', async () => {
    const result = await runRealistimoSyncCycle({
      client: fakeClient({
        log: log({
          state: 'completed',
          logDate: minutes(-10),
          offers: [{ offerUid: 'IS-00005', uuid: 'x', createdAt: null, errors: ['Bad image'] }],
        }),
      }),
      now: NOON,
      state: EMPTY_SYNC_STATE,
      feedChangedAt: null,
    });

    expect(result.offerErrors).toEqual([
      { offerUid: 'IS-00005', lastError: 'Realistimo import: Bad image' },
    ]);
    expect(result.decision).toEqual({ trigger: false, reason: 'unchanged' });
  });

  it('records an import that stopped early', async () => {
    const result = await runRealistimoSyncCycle({
      client: fakeClient({
        log: log({ state: 'completed', logDate: minutes(-40), earlyStop: 'Feed not changed' }),
      }),
      now: NOON,
      state: EMPTY_SYNC_STATE,
      feedChangedAt: null,
    });

    expect(result.state.lastResult?.log).toMatchObject({ earlyStop: 'Feed not changed' });
    expect(result.offerErrors).toEqual([]);
  });

  it('keeps the change pending when Realistimo answers with the cooldown', async () => {
    const client = fakeClient({
      start: { outcome: 'cooldown', message: 'import-request-cooldown-is-time-given' },
    });

    const result = await runRealistimoSyncCycle({
      client,
      now: NOON,
      state: { ...EMPTY_SYNC_STATE, lastTriggeredAt: minutes(-120) },
      feedChangedAt: minutes(-1),
    });

    expect(result.started).toBe('cooldown');
    expect(result.state.lastTriggeredAt).toEqual(minutes(-120));
    expect(result.state.lastTriggerMessage).toBe('cooldown');

    // The next cycle asks again.
    const next = await runRealistimoSyncCycle({
      client: fakeClient({}),
      now: minutes(40),
      state: result.state,
      feedChangedAt: minutes(-1),
    });
    expect(next.started).toBe('queued');
    expect(next.state.lastTriggeredAt).toEqual(minutes(40));
  });

  it.each(['agency-not-found', 'no-feed', 'unknown'] as const)(
    'backs off after a configuration answer (%s) until the feed changes or an hour passes',
    async (outcome) => {
      const broken = fakeClient({ start: { outcome, message: 'Agency not found' } });
      const first = await runRealistimoSyncCycle({
        client: broken,
        now: NOON,
        state: EMPTY_SYNC_STATE,
        feedChangedAt: minutes(-5),
      });
      expect(first.started).toBe(outcome);
      expect(first.state.lastTriggeredAt).toBeNull();
      expect(first.state.lastResult?.lastAttempt).toMatchObject({
        at: NOON.toISOString(),
        outcome,
      });

      // The same feed, 59 minutes later: start() is not called again.
      const quiet = fakeClient({ start: { outcome, message: 'Agency not found' } });
      const later = await runRealistimoSyncCycle({
        client: quiet,
        now: minutes(59),
        state: first.state,
        feedChangedAt: minutes(-5),
      });
      expect(later.decision).toEqual({ trigger: false, reason: 'configuration-error' });
      expect(quiet.calls).toEqual(['latestLog']);

      // After an hour, or as soon as the feed changes, it asks again.
      for (const [now, feedChangedAt] of [
        [minutes(60), minutes(-5)],
        [minutes(10), minutes(5)],
      ] as const) {
        const retry = fakeClient({});
        const again = await runRealistimoSyncCycle({
          client: retry,
          now,
          state: first.state,
          feedChangedAt,
        });
        expect(again.decision).toEqual({ trigger: true });
        expect(retry.calls).toEqual(['latestLog', 'start']);
      }
    },
  );

  it('does not back off after answers that only mean "later"', async () => {
    const cooling = await runRealistimoSyncCycle({
      client: fakeClient({ start: { outcome: 'cooldown', message: 'cooldown' } }),
      now: NOON,
      state: EMPTY_SYNC_STATE,
      feedChangedAt: minutes(-5),
    });
    const next = fakeClient({});
    const again = await runRealistimoSyncCycle({
      client: next,
      now: minutes(31),
      state: cooling.state,
      feedChangedAt: minutes(-5),
    });
    expect(again.decision).toEqual({ trigger: true });
  });

  it('does not call start() outside the window or during the cooldown', async () => {
    const evening = fakeClient({});
    const outside = await runRealistimoSyncCycle({
      client: evening,
      now: new Date('2026-01-15T20:00:00Z'),
      state: EMPTY_SYNC_STATE,
      feedChangedAt: NOON,
    });
    expect(outside.decision).toEqual({ trigger: false, reason: 'outside-window' });
    expect(evening.calls).toEqual(['latestLog']);

    const recent = fakeClient({ log: log({ state: 'completed', logDate: minutes(-10) }) });
    const cooling = await runRealistimoSyncCycle({
      client: recent,
      now: NOON,
      state: EMPTY_SYNC_STATE,
      feedChangedAt: minutes(-1),
    });
    expect(cooling.decision).toEqual({ trigger: false, reason: 'cooldown' });
    expect(recent.calls).toEqual(['latestLog']);
  });

  it('returns API errors instead of throwing', async () => {
    const unreachable = fakeClient({ log: new PortalError('network down', true) });
    const failedLog = await runRealistimoSyncCycle({
      client: unreachable,
      now: NOON,
      state: EMPTY_SYNC_STATE,
      feedChangedAt: minutes(-1),
    });
    expect(failedLog.error).toEqual({ message: 'network down', retryable: true });
    expect(unreachable.calls).toEqual(['latestLog']);

    const rejected = await runRealistimoSyncCycle({
      client: fakeClient({
        start: new PortalError('Realistimo rejected the API key: API key is expired', false),
      }),
      now: NOON,
      state: EMPTY_SYNC_STATE,
      feedChangedAt: minutes(-1),
    });
    expect(rejected.error).toEqual({
      message: 'Realistimo rejected the API key: API key is expired',
      retryable: false,
    });
    expect(rejected.state.lastTriggerMessage).toBe(
      'error: Realistimo rejected the API key: API key is expired',
    );
    expect(rejected.state.lastTriggeredAt).toBeNull();
    expect(rejected.state.lastResult?.lastAttempt?.outcome).toBe('error');
  });

  it('fits last_trigger_message into VARCHAR(100)', async () => {
    const result = await runRealistimoSyncCycle({
      client: fakeClient({ start: new Error('x'.repeat(300)) }),
      now: NOON,
      state: EMPTY_SYNC_STATE,
      feedChangedAt: minutes(-1),
    });

    expect(result.state.lastTriggerMessage).toHaveLength(100);
    expect(result.error?.retryable).toBe(true);
  });

  it('stops waiting for a queued import that never reports back', async () => {
    const result = await runRealistimoSyncCycle({
      client: fakeClient({}),
      now: new Date(NOON.getTime() + AWAIT_RESULT_MAX_MS),
      state: { ...EMPTY_SYNC_STATE, lastTriggeredAt: NOON, lastTriggerMessage: 'queued' },
      feedChangedAt: minutes(-1),
    });

    expect(result.awaitingResult).toBe(false);
  });

  it('works end to end with the HTTP client and a fake Realistimo', async () => {
    const server = await startFakeServer((request, response) => {
      if (request.url === '/rest-api/import/latest-log') {
        sendJson(response, 200, {
          message: 'completed',
          logDate: '2026-01-15T11:20:00+02:00',
          logResult: JSON.stringify({ 0: 'success', found_offers: 1 }),
          logOffers: JSON.stringify([
            {
              uuid: 'u',
              createdAt: null,
              errors: ['Bad location'],
              offerSourceData: { offer_uid: 'IS-00004' },
            },
          ]),
        });
      } else {
        sendJson(response, 200, { message: 'Import in queue' });
      }
    });
    try {
      const client = createRealistimoClient({ apiKey: 'test-key', baseUrl: server.baseUrl });

      const result = await runRealistimoSyncCycle({
        client,
        now: NOON,
        state: EMPTY_SYNC_STATE,
        feedChangedAt: minutes(-1),
      });

      expect(server.requests.map((request) => request.url)).toEqual([
        '/rest-api/import/latest-log',
        '/rest-api/import/start',
      ]);
      expect(result.offerErrors).toEqual([
        { offerUid: 'IS-00004', lastError: 'Realistimo import: Bad location' },
      ]);
      expect(result.started).toBe('queued');
      expect(result.state.lastLogDate).toEqual(new Date('2026-01-15T09:20:00Z'));
    } finally {
      await server.close();
    }
  });
});
