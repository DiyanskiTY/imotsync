import type { RetryConfig } from '../config.js';

/**
 * Delay before the next attempt after `attempts` failed ones (1 after the first failure):
 *
 *   delay = random(0.5, 1) * min(cap, base * 2^(attempts - 1))
 *
 * and never less than `retryAfterMs` (a portal's Retry-After). With base 30 s and cap 1 h the
 * delays before attempts 2 to 5 are 15-30 s, 30-60 s, 1-2 min and 2-4 min. The jitter spreads
 * out jobs that failed together, e.g. during a portal outage.
 *
 * `random` returns a number in [0, 1), like Math.random (injected so tests are deterministic).
 */
export function computeRetryDelayMs(
  attempts: number,
  policy: RetryConfig,
  random: () => number = Math.random,
  retryAfterMs?: number,
): number {
  const exponent = Math.max(0, Math.floor(attempts) - 1);
  // 2^exponent overflows to Infinity for huge attempt counts, which min() caps.
  const ceilingMs = Math.min(policy.capSeconds, policy.baseSeconds * 2 ** exponent) * 1000;
  const jitter = 0.5 + 0.5 * Math.min(Math.max(random(), 0), 1);
  const delayMs = Math.round(jitter * ceilingMs);
  return Math.max(delayMs, retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : 0);
}
