import { describe, expect, it } from 'vitest';
import {
  isRemovalStillServed,
  removalRetentionCutoff,
  removalServedUntil,
} from '../../../src/portals/removal-retention.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-17T12:00:00Z');
const daysAgo = (days: number, plusMs = 0) => new Date(NOW.getTime() - days * DAY_MS + plusMs);

describe('isRemovalStillServed', () => {
  it('serves a removal for the retention period, the boundary included', () => {
    expect(isRemovalStillServed(daysAgo(30, 1), 30, NOW)).toBe(true);
    expect(isRemovalStillServed(daysAgo(30), 30, NOW)).toBe(true);
    expect(isRemovalStillServed(daysAgo(30, -1), 30, NOW)).toBe(false);
    expect(isRemovalStillServed(NOW, 30, NOW)).toBe(true);
  });

  it('serves no removal with a retention period of 0', () => {
    expect(isRemovalStillServed(NOW, 0, NOW)).toBe(false);
    expect(isRemovalStillServed(new Date(NOW.getTime() + 1000), 0, NOW)).toBe(false);
  });

  it('agrees with the cut-off and the end of service', () => {
    expect(removalRetentionCutoff(30, NOW)).toEqual(daysAgo(30));
    const removedAt = daysAgo(10);
    const until = removalServedUntil(removedAt, 7);
    expect(isRemovalStillServed(removedAt, 7, until)).toBe(true);
    expect(isRemovalStillServed(removedAt, 7, new Date(until.getTime() + 1))).toBe(false);
  });
});
