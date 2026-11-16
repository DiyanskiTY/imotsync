import { setTimeout as sleep } from 'node:timers/promises';
import {
  PortalError,
  type AdapterContext,
  type AdapterOutcome,
  type PortalAdapter,
  type PortalListingInfo,
  type PortalProperty,
  type ValidationIssue,
} from '../types.js';

/*
 * The demo portal: an in-process fake, so the queue, the retries and every listing status
 * can be seen without touching a real portal. Each call takes DEMO_PORTAL_LATENCY_MS and
 * fails with probability DEMO_PORTAL_FAILURE_RATE; five of six failures are temporary (503,
 * or 429 with a Retry-After), one of six is permanent (422).
 */

export const DEMO_PORTAL_KEY = 'demo';

/** How long the demo portal asks to wait after a 429. */
export const DEMO_RETRY_AFTER_MS = 5_000;

/** Reasons the demo portal gives for a permanent rejection (made up). */
const REJECTION_REASONS = [
  'the listing text failed its automatic content check',
  'the photos failed its automatic quality check',
  'the listing looks like a duplicate of another one',
] as const;

export interface DemoAdapterOptions {
  /** Probability (0 to 1) that a publish, update or remove call fails. */
  failureRate: number;
  /** How long each call takes. */
  latencyMs: number;
  /** Returns a number in [0, 1); injected so tests are deterministic (default Math.random). */
  random?: () => number;
  /** Abortable wait (default node:timers/promises setTimeout); injectable for tests. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** "demo-000042" for property 42. */
export const demoExternalId = (propertyId: number) => `demo-${String(propertyId).padStart(6, '0')}`;

const defaultWait = async (ms: number, signal: AbortSignal) => {
  try {
    await sleep(ms, undefined, { signal });
  } catch (error) {
    // Report why the call was cut short (time budget, shutdown), not a bare AbortError.
    signal.throwIfAborted();
    throw error;
  }
};

export function createDemoAdapter(options: DemoAdapterOptions): PortalAdapter {
  const { failureRate, latencyMs, random = Math.random, wait = defaultWait } = options;

  /** Waits for the simulated response, then fails as often as configured. */
  async function respond(ctx: AdapterContext): Promise<void> {
    if (latencyMs > 0) await wait(latencyMs, ctx.signal);
    ctx.signal.throwIfAborted();
    if (random() >= failureRate) return;

    // Six equally likely kinds of failure: 503, 503, 503, 429, 429, 422.
    const kind = Math.min(5, Math.floor(random() * 6));
    if (kind <= 2) {
      throw new PortalError(
        'The demo portal answered HTTP 503 Service Unavailable (simulated outage)',
        true,
        { httpStatus: 503, code: 'DEMO_UNAVAILABLE' },
      );
    }
    if (kind <= 4) {
      throw new PortalError(
        `The demo portal answered HTTP 429 Too Many Requests (simulated); it asks to retry after ${DEMO_RETRY_AFTER_MS / 1000} s`,
        true,
        { httpStatus: 429, code: 'DEMO_RATE_LIMITED', retryAfterMs: DEMO_RETRY_AFTER_MS },
      );
    }
    const reason = REJECTION_REASONS[Math.floor(random() * REJECTION_REASONS.length)];
    throw new PortalError(
      `The demo portal rejected the listing: ${reason ?? REJECTION_REASONS[0]} (HTTP 422, simulated)`,
      false,
      { httpStatus: 422, code: 'DEMO_REJECTED' },
    );
  }

  const details = (ctx: AdapterContext) => ({ simulated: true, attempt: ctx.attempt, latencyMs });

  return {
    key: DEMO_PORTAL_KEY,
    displayName: 'Demo portal',
    mode: 'push',

    validate(property: PortalProperty): ValidationIssue[] {
      const issues: ValidationIssue[] = [];
      if (!property.title?.trim()) {
        issues.push({ field: 'title', message: 'The demo portal needs a title.' });
      }
      if (property.price === null || property.price <= 0) {
        issues.push({ field: 'price', message: 'The demo portal needs a price above 0.' });
      }
      if (property.images.length === 0) {
        issues.push({ field: 'images', message: 'The demo portal needs at least one photo.' });
      }
      return issues;
    },

    async publish(property, _listing, ctx): Promise<AdapterOutcome> {
      await respond(ctx);
      return {
        externalId: demoExternalId(property.id),
        message: `Published on the demo portal as ${demoExternalId(property.id)} (simulated)`,
        details: details(ctx),
      };
    },

    async update(property, _listing, ctx): Promise<AdapterOutcome> {
      await respond(ctx);
      return {
        externalId: demoExternalId(property.id),
        message: `Updated ${demoExternalId(property.id)} on the demo portal (simulated)`,
        details: details(ctx),
      };
    },

    async remove(
      listing: PortalListingInfo,
      property: PortalProperty | null,
      ctx: AdapterContext,
    ): Promise<AdapterOutcome> {
      await respond(ctx);
      const externalId =
        listing.externalId ?? (property ? demoExternalId(property.id) : 'the listing');
      return {
        message: `Removed ${externalId} from the demo portal (simulated)`,
        details: details(ctx),
      };
    },
  };
}
