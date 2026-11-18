import { describe, expect, it } from 'vitest';
import type { PortalListingRow } from '../../../src/db/types.js';
import { describeScheduledDeletion } from '../../../src/jobs/property-deletion.js';

const now = new Date('2026-11-18T12:00:00.000Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
const rules = { removedRetentionDays: new Map([['bazar', 30]]), now };

function listing(overrides: Partial<PortalListingRow>): PortalListingRow {
  return {
    id: 1,
    property_id: 7,
    portal: 'bazar',
    external_id: null,
    status: 'removed',
    last_error: null,
    published_at: daysAgo(20),
    removed_at: daysAgo(2),
    payload: { ref: 'x', removed: true },
    payload_updated_at: daysAgo(2),
    created_at: daysAgo(20),
    updated_at: daysAgo(2),
    ...overrides,
  };
}

describe('describeScheduledDeletion', () => {
  it('waits for the removal while a listing is pending or still online', () => {
    expect(describeScheduledDeletion([listing({ status: 'pending' })], rules)).toEqual({
      state: 'removing',
      portals: ['bazar'],
      deletesAfter: null,
    });
    // A failed removal leaves the listing online: it blocks until the removal goes through.
    expect(
      describeScheduledDeletion(
        [listing({ portal: 'demo', status: 'error', removed_at: null, payload: null })],
        rules,
      ),
    ).toEqual({ state: 'removing', portals: ['demo'], deletesAfter: null });
  });

  it('waits until the last feed stops serving the removal', () => {
    const first = listing({ id: 1, payload_updated_at: daysAgo(10) });
    const latest = listing({ id: 2, payload_updated_at: daysAgo(2) });
    expect(describeScheduledDeletion([first, latest], rules)).toEqual({
      state: 'feed_retention',
      portals: ['bazar'],
      deletesAfter: new Date(daysAgo(2).getTime() + 30 * 86_400_000),
    });
  });

  it('is due when nothing holds it back any more', () => {
    expect(
      describeScheduledDeletion([listing({ payload_updated_at: daysAgo(31) })], rules),
    ).toEqual({ state: 'due', portals: [], deletesAfter: null });
    expect(describeScheduledDeletion([], rules)).toEqual({
      state: 'due',
      portals: [],
      deletesAfter: null,
    });
  });
});
