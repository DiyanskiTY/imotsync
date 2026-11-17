import {
  PortalError,
  type AdapterContext,
  type AdapterOutcome,
  type FeedPayload,
  type PortalAdapter,
  type PortalKey,
  type PortalListingInfo,
  type PortalProperty,
  type ValidationIssue,
} from './types.js';

/** What a feed portal serves for a property, plus what the job log keeps about it. */
export interface FeedEntry {
  payload: FeedPayload;
  details?: Record<string, unknown>;
}

/**
 * The outcome of a removal: the payload the feed serves from now on (one that marks the
 * listing as gone, e.g. out of stock, or null to leave it out), the job log message and details.
 */
export interface FeedRemoval {
  payload: FeedPayload | null;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * A feed portal as plain synchronous functions without I/O. createFeedAdapter turns it into a
 * PortalAdapter (mode 'feed'); the feed endpoint serves the stored payloads with the portal's
 * FeedRenderer.
 */
export interface FeedAdapterSpec {
  key: PortalKey;
  displayName: string;
  /** The portal's rules for a property; an empty list means it can go into the feed. */
  validate(property: PortalProperty): ValidationIssue[];
  /**
   * The payload the feed serves for a valid property. `previousPayload` is what the feed
   * served so far (null before the first publish); `now` is the job's time.
   */
  buildPayload(property: PortalProperty, previousPayload: FeedPayload | null, now: Date): FeedEntry;
  /**
   * What the feed serves once the listing is removed. `previousPayload` is what it served so
   * far (null: the listing never reached the feed); the property may already be gone (null).
   */
  buildRemoval(
    previousPayload: FeedPayload | null,
    property: PortalProperty | null,
    now: Date,
  ): FeedRemoval;
  /** Job log messages of a successful publish and update. */
  messages: { publish: string; update: string };
}

/** Runs synchronous work as a promise, so a throw becomes a rejection like any I/O error. */
function settle<T>(work: () => T): Promise<T> {
  return new Promise((resolve) => {
    resolve(work());
  });
}

/**
 * Builds the PortalAdapter of a feed portal from its spec. The adapter owns what every feed
 * portal shares: the promise wrapping, the abort check before any work, and a defensive
 * validation. The job runner validates before it calls publish or update, so that check only
 * stops a direct caller; it fails the same way as the runner's (code 'VALIDATION', message
 * 'Validation failed: field: message; ...', never retried).
 */
export function createFeedAdapter(spec: FeedAdapterSpec): PortalAdapter {
  /** publish and update: store the payload the feed serves from now on. */
  const store =
    (message: string) =>
    (
      property: PortalProperty,
      listing: PortalListingInfo,
      ctx: AdapterContext,
    ): Promise<AdapterOutcome> =>
      settle(() => {
        ctx.signal.throwIfAborted();
        const issues = spec.validate(property);
        if (issues.length > 0) {
          const summary = issues.map((issue) => `${issue.field}: ${issue.message}`).join('; ');
          throw new PortalError(`Validation failed: ${summary}`, false, { code: 'VALIDATION' });
        }
        const { payload, details } = spec.buildPayload(property, listing.payload, ctx.now);
        return { payload, message, ...(details !== undefined ? { details } : {}) };
      });

  return {
    key: spec.key,
    displayName: spec.displayName,
    mode: 'feed',

    validate: (property) => spec.validate(property),
    publish: store(spec.messages.publish),
    update: store(spec.messages.update),

    remove(listing, property, ctx) {
      return settle((): AdapterOutcome => {
        ctx.signal.throwIfAborted();
        const { payload, message, details } = spec.buildRemoval(listing.payload, property, ctx.now);
        return { payload, message, ...(details !== undefined ? { details } : {}) };
      });
    },
  };
}
