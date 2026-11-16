import { describe, expect, it } from 'vitest';
import { computeRetryDelayMs } from '../../../src/jobs/backoff.js';

const policy = { baseSeconds: 30, capSeconds: 3600 };
const lowest = () => 0;
/** Just below 1, like the largest value Math.random can return. */
const highest = () => 1 - Number.EPSILON;

describe('computeRetryDelayMs', () => {
  it('doubles from the base: random(0.5, 1) * base * 2^(attempts - 1)', () => {
    // [attempts that failed, lowest delay, highest delay] in seconds, with the defaults.
    const expected: [number, number, number][] = [
      [1, 15, 30],
      [2, 30, 60],
      [3, 60, 120],
      [4, 120, 240],
      [5, 240, 480],
    ];
    for (const [attempts, low, high] of expected) {
      expect(computeRetryDelayMs(attempts, policy, lowest), `attempt ${attempts}`).toBe(low * 1000);
      expect(computeRetryDelayMs(attempts, policy, highest), `attempt ${attempts}`).toBe(
        high * 1000,
      );
    }
  });

  it('jitters linearly between half and the whole delay', () => {
    expect(computeRetryDelayMs(1, policy, () => 0.5)).toBe(22_500);
    expect(computeRetryDelayMs(3, policy, () => 0.25)).toBe(75_000);
  });

  it('never exceeds the cap, however many attempts failed', () => {
    for (const attempts of [8, 9, 20, 100, 10_000]) {
      expect(computeRetryDelayMs(attempts, policy, highest)).toBe(3_600_000);
      expect(computeRetryDelayMs(attempts, policy, lowest)).toBe(1_800_000);
    }
  });

  it('waits at least as long as the portal asked (Retry-After)', () => {
    expect(computeRetryDelayMs(1, policy, lowest, 120_000)).toBe(120_000);
    expect(computeRetryDelayMs(1, policy, highest, 5_000)).toBe(30_000);
    expect(computeRetryDelayMs(1, policy, lowest, 0)).toBe(15_000);
    expect(computeRetryDelayMs(1, policy, lowest, -10)).toBe(15_000);
  });

  it('treats attempts below 1 like the first failure', () => {
    expect(computeRetryDelayMs(0, policy, lowest)).toBe(15_000);
  });

  it('keeps out-of-range random values within the jitter range', () => {
    expect(computeRetryDelayMs(1, policy, () => -3)).toBe(15_000);
    expect(computeRetryDelayMs(1, policy, () => 7)).toBe(30_000);
  });

  it('uses the configured base and cap', () => {
    const fast = { baseSeconds: 1, capSeconds: 5 };

    expect(computeRetryDelayMs(1, fast, highest)).toBe(1_000);
    expect(computeRetryDelayMs(3, fast, highest)).toBe(4_000);
    expect(computeRetryDelayMs(4, fast, highest)).toBe(5_000);
  });

  it('uses Math.random by default, within the documented range', () => {
    for (let run = 0; run < 50; run++) {
      const delay = computeRetryDelayMs(2, policy);
      expect(delay).toBeGreaterThanOrEqual(30_000);
      expect(delay).toBeLessThanOrEqual(60_000);
    }
  });
});
