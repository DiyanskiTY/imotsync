import { describe, expect, it, vi } from 'vitest';
import {
  createDemoAdapter,
  DEMO_PORTAL_KEY,
  DEMO_RETRY_AFTER_MS,
  demoExternalId,
  type DemoAdapterOptions,
} from '../../../../src/portals/demo/demo-adapter.js';
import {
  PortalError,
  type AdapterContext,
  type PortalListingInfo,
  type PortalProperty,
} from '../../../../src/portals/types.js';

const property = (overrides: Partial<PortalProperty> = {}): PortalProperty => ({
  id: 42,
  refCode: 'IS-00042',
  title: 'Двустаен апартамент в Лазур',
  type: 'apartment',
  dealType: 'sale',
  city: 'Burgas',
  district: 'Lazur',
  price: 132_000,
  currency: 'EUR',
  areaM2: 67,
  rooms: 2,
  floor: 6,
  totalFloors: 9,
  description: null,
  status: 'active',
  broker: null,
  updatedAt: new Date('2026-11-10T10:00:00Z'),
  images: [
    {
      url: 'https://imotsync.example/uploads/demo/is-00042-1.jpg',
      width: 1600,
      height: 1067,
      sizeBytes: 200_000,
      sortOrder: 0,
    },
  ],
  ...overrides,
});

const listing = (overrides: Partial<PortalListingInfo> = {}): PortalListingInfo => ({
  id: 7,
  portal: 'demo',
  status: 'pending',
  externalId: null,
  publishedAt: null,
  payload: null,
  payloadUpdatedAt: null,
  ...overrides,
});

const ctx = (overrides: Partial<AdapterContext> = {}): AdapterContext => ({
  now: new Date('2026-11-16T08:00:00Z'),
  signal: new AbortController().signal,
  attempt: 1,
  ...overrides,
});

/** A random() that returns the given values in order (then repeats the last one). */
function sequence(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

/** No latency, so the tests never wait. */
const adapter = (options: Partial<DemoAdapterOptions> = {}) =>
  createDemoAdapter({ failureRate: 0, latencyMs: 0, ...options });

async function failureOf(promise: Promise<unknown>): Promise<PortalError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(PortalError);
  return error as PortalError;
}

describe('demo adapter: identity', () => {
  it('is the push portal "demo"', () => {
    const demo = adapter();

    expect([demo.key, demo.displayName, demo.mode]).toEqual([
      DEMO_PORTAL_KEY,
      'Demo portal',
      'push',
    ]);
    expect(DEMO_PORTAL_KEY).toBe('demo');
  });

  it('builds external ids from the property id, six digits', () => {
    expect(demoExternalId(42)).toBe('demo-000042');
    expect(demoExternalId(1_234_567)).toBe('demo-1234567');
  });
});

describe('demo adapter: validate', () => {
  it('accepts a property with a title, a price and a photo', () => {
    expect(adapter().validate(property())).toEqual([]);
  });

  it('needs a title, a price above 0 and at least one photo', () => {
    const issues = adapter().validate(property({ title: '  ', price: 0, images: [] }));

    expect(issues).toEqual([
      { field: 'title', message: 'The demo portal needs a title.' },
      { field: 'price', message: 'The demo portal needs a price above 0.' },
      { field: 'images', message: 'The demo portal needs at least one photo.' },
    ]);
    expect(
      adapter()
        .validate(property({ title: null, price: null }))
        .map((i) => i.field),
    ).toEqual(['title', 'price']);
  });

  it('is pure: the same property gives the same answer, and nothing is called', () => {
    const random = vi.fn(() => 0);
    const demo = adapter({ failureRate: 1, random });
    const input = property({ images: [] });

    expect(demo.validate(input)).toEqual(demo.validate(input));
    expect(random).not.toHaveBeenCalled();
  });
});

describe('demo adapter: success', () => {
  it('publishes and updates with the demo id and a message for the job log', async () => {
    const demo = adapter({ random: () => 0.99, failureRate: 0.5 });

    await expect(demo.publish(property(), listing(), ctx({ attempt: 2 }))).resolves.toEqual({
      externalId: 'demo-000042',
      message: 'Published on the demo portal as demo-000042 (simulated)',
      details: { simulated: true, attempt: 2, latencyMs: 0 },
    });
    await expect(demo.update(property(), listing(), ctx())).resolves.toMatchObject({
      externalId: 'demo-000042',
      message: 'Updated demo-000042 on the demo portal (simulated)',
    });
  });

  it('removes by the stored external id, even when the property is gone', async () => {
    const demo = adapter();

    await expect(
      demo.remove(listing({ externalId: 'demo-000042' }), null, ctx()),
    ).resolves.toMatchObject({ message: 'Removed demo-000042 from the demo portal (simulated)' });
    await expect(demo.remove(listing(), property(), ctx())).resolves.toMatchObject({
      message: 'Removed demo-000042 from the demo portal (simulated)',
    });
    const removed = await demo.remove(listing(), null, ctx());
    expect(removed.message).toBe('Removed the listing from the demo portal (simulated)');
    expect(removed).not.toHaveProperty('externalId');
  });

  it('never fails with DEMO_PORTAL_FAILURE_RATE=0, and always with 1', async () => {
    const reliable = adapter({ failureRate: 0, random: () => 0 });
    const broken = adapter({ failureRate: 1, random: () => 0.999 });

    await expect(reliable.publish(property(), listing(), ctx())).resolves.toBeDefined();
    await expect(broken.publish(property(), listing(), ctx())).rejects.toBeInstanceOf(PortalError);
  });
});

describe('demo adapter: simulated failures', () => {
  // random() is called twice per failure: once to decide whether to fail (< failureRate),
  // once to pick one of six kinds of failure (503, 503, 503, 429, 429, 422).
  it.each([
    [0, 503],
    [1, 503],
    [2, 503],
    [3, 429],
    [4, 429],
  ])('kind %i of six is a temporary HTTP %i (retryable)', async (kind, httpStatus) => {
    const demo = adapter({ failureRate: 0.3, random: sequence(0.1, (kind + 0.5) / 6) });

    const error = await failureOf(demo.publish(property(), listing(), ctx()));

    expect(error.retryable).toBe(true);
    expect(error.options.httpStatus).toBe(httpStatus);
    expect(error.message).toContain(`HTTP ${httpStatus}`);
  });

  it('asks to wait after a 429 (Retry-After)', async () => {
    const demo = adapter({ failureRate: 1, random: sequence(0, 3.5 / 6) });

    const error = await failureOf(demo.update(property(), listing(), ctx()));

    expect(error.options).toEqual({
      httpStatus: 429,
      code: 'DEMO_RATE_LIMITED',
      retryAfterMs: DEMO_RETRY_AFTER_MS,
    });
  });

  it('rejects the listing for good one time in six (HTTP 422)', async () => {
    const demo = adapter({ failureRate: 1, random: sequence(0, 5.5 / 6, 0) });

    const error = await failureOf(demo.remove(listing(), property(), ctx()));

    expect(error.retryable).toBe(false);
    expect(error.options).toEqual({ httpStatus: 422, code: 'DEMO_REJECTED' });
    expect(error.message).toMatch(
      /^The demo portal rejected the listing: .+ \(HTTP 422, simulated\)$/,
    );
  });

  it('fails about as often as configured, five in six failures retryable', async () => {
    // A deterministic, evenly spread "random" sequence.
    let seed = 0;
    const random = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    const demo = adapter({ failureRate: 0.3, random });
    let failures = 0;
    let retryable = 0;
    const runs = 3000;
    for (let run = 0; run < runs; run++) {
      try {
        await demo.publish(property(), listing(), ctx());
      } catch (error) {
        failures++;
        if ((error as PortalError).retryable) retryable++;
      }
    }

    expect(failures / runs).toBeGreaterThan(0.25);
    expect(failures / runs).toBeLessThan(0.35);
    expect(retryable / failures).toBeGreaterThan(0.75);
    expect(retryable / failures).toBeLessThan(0.9);
  });
});

describe('demo adapter: latency and abort', () => {
  it('waits DEMO_PORTAL_LATENCY_MS with the job signal before answering', async () => {
    const wait = vi.fn(() => Promise.resolve());
    const signal = new AbortController().signal;
    const demo = adapter({ latencyMs: 400, wait });

    await demo.publish(property(), listing(), ctx({ signal }));

    expect(wait).toHaveBeenCalledWith(400, signal);
  });

  it('skips the wait when the latency is 0', async () => {
    const wait = vi.fn(() => Promise.resolve());

    await adapter({ latencyMs: 0, wait }).publish(property(), listing(), ctx());

    expect(wait).not.toHaveBeenCalled();
  });

  it('stops waiting as soon as the signal aborts (real timer)', async () => {
    const controller = new AbortController();
    const demo = createDemoAdapter({ failureRate: 0, latencyMs: 60_000 });
    const started = Date.now();

    const call = demo.publish(property(), listing(), ctx({ signal: controller.signal }));
    setTimeout(() => {
      controller.abort(new Error('time budget used up'));
    }, 20);

    await expect(call).rejects.toThrow('time budget used up');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('does not answer when the signal aborted during the wait', async () => {
    const controller = new AbortController();
    const wait = () => {
      controller.abort(new Error('shutting down'));
      return Promise.resolve();
    };
    const demo = adapter({ latencyMs: 10, wait });

    await expect(
      demo.update(property(), listing(), ctx({ signal: controller.signal })),
    ).rejects.toThrow('shutting down');
  });
});
