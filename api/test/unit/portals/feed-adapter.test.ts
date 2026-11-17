import { describe, expect, it } from 'vitest';
import { createFeedAdapter, type FeedAdapterSpec } from '../../../src/portals/feed-adapter.js';
import { PortalError, type PortalProperty } from '../../../src/portals/types.js';
import { adapterContext, listingInfo, readyProperty } from './bazar/fixtures.js';

/** A spec that records what it was called with. */
function recordingSpec(overrides: Partial<FeedAdapterSpec> = {}) {
  const calls: { previous: unknown; now: Date }[] = [];
  const spec: FeedAdapterSpec = {
    key: 'test',
    displayName: 'Test portal',
    messages: { publish: 'Added', update: 'Updated' },
    validate: (property: PortalProperty) =>
      property.title === null ? [{ field: 'title', message: 'Test portal needs a title.' }] : [],
    buildPayload(property, previous, now) {
      calls.push({ previous, now });
      return { payload: { id: property.refCode } };
    },
    buildRemoval: () => ({ payload: null, message: 'Removed' }),
    ...overrides,
  };
  return { spec, calls };
}

describe('createFeedAdapter', () => {
  it('builds a feed adapter that stores the spec payload with the action message', async () => {
    const { spec, calls } = recordingSpec();
    const adapter = createFeedAdapter(spec);
    const ctx = adapterContext();
    const previous = { id: 'old' };

    expect(adapter).toMatchObject({ key: 'test', displayName: 'Test portal', mode: 'feed' });
    expect(adapter.validate(readyProperty({ title: null }))).toHaveLength(1);
    expect(await adapter.publish(readyProperty(), listingInfo(), ctx)).toEqual({
      payload: { id: 'IS-00012' },
      message: 'Added',
    });
    expect(await adapter.update(readyProperty(), listingInfo({ payload: previous }), ctx)).toEqual({
      payload: { id: 'IS-00012' },
      message: 'Updated',
    });
    expect(calls).toEqual([
      { previous: null, now: ctx.now },
      { previous, now: ctx.now },
    ]);
    expect(await adapter.remove(listingInfo(), null, ctx)).toEqual({
      payload: null,
      message: 'Removed',
    });
  });

  it('validates again before building, failing like the job runner (never retried)', async () => {
    const { spec, calls } = recordingSpec();
    const result = createFeedAdapter(spec).publish(
      readyProperty({ title: null }),
      listingInfo(),
      adapterContext(),
    );

    await expect(result).rejects.toBeInstanceOf(PortalError);
    await expect(result).rejects.toMatchObject({
      retryable: false,
      message: 'Validation failed: title: Test portal needs a title.',
      options: { code: 'VALIDATION' },
    });
    expect(calls).toEqual([]);
  });

  it('turns a throw of the spec into a rejection', async () => {
    const { spec } = recordingSpec({
      buildRemoval: () => {
        throw new TypeError('broken payload');
      },
    });
    await expect(
      createFeedAdapter(spec).remove(listingInfo(), null, adapterContext()),
    ).rejects.toThrow('broken payload');
  });

  it('does nothing once the job was cancelled', async () => {
    const { spec, calls } = recordingSpec();
    const adapter = createFeedAdapter(spec);
    const controller = new AbortController();
    controller.abort(new Error('shutting down'));
    const ctx = adapterContext({ signal: controller.signal });

    await expect(adapter.publish(readyProperty(), listingInfo(), ctx)).rejects.toThrow(
      'shutting down',
    );
    await expect(adapter.update(readyProperty(), listingInfo(), ctx)).rejects.toThrow(
      'shutting down',
    );
    await expect(adapter.remove(listingInfo(), null, ctx)).rejects.toThrow('shutting down');
    expect(calls).toEqual([]);
  });
});
