/*
 * The contract between the publishing core (queue, worker, API) and the portal adapters.
 *
 * Adapters only ever see these portal-independent types. Everything portal-specific
 * (field names, enumerations, location ids, XML layout) stays inside the adapter's own
 * folder under src/portals/<key>/.
 */

import type { DealType, PortalListingStatus, PropertyStatus, PropertyType } from '../db/types.js';

/** Adapter key stored in portal_listings.portal, e.g. 'realistimo', 'bazar', 'demo'. */
export type PortalKey = string;

/**
 * How a portal receives listings.
 * - 'feed': the portal downloads an XML/JSON feed from us on its own schedule (pull).
 *   publish/update store a portal-specific payload on the listing; the feed endpoint
 *   renders the stored payloads.
 * - 'push': the adapter calls the portal during the job and gets a result back.
 */
export type PortalMode = 'feed' | 'push';

export interface PortalImage {
  /** Absolute URL (PUBLIC_BASE_URL + /uploads/...), ready to hand to a portal. */
  url: string;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  /** 0-based position; the first photo is the main photo. */
  sortOrder: number;
}

export interface PortalBroker {
  /** ImotSync user id. */
  id: number;
  fullName: string;
  email: string;
}

/** A property as every adapter sees it: current data plus its photos in display order. */
export interface PortalProperty {
  id: number;
  /** Stable agency reference (IS-00001 or the agency's own code). Never changes. */
  refCode: string;
  title: string | null;
  type: PropertyType;
  dealType: DealType;
  city: string;
  district: string | null;
  price: number | null;
  /** ISO 4217, upper case, e.g. 'EUR'. */
  currency: string;
  areaM2: number | null;
  rooms: number | null;
  floor: number | null;
  totalFloors: number | null;
  description: string | null;
  status: PropertyStatus;
  /** The broker responsible for the listing (the property's creator), if known. */
  broker: PortalBroker | null;
  updatedAt: Date;
  images: PortalImage[];
}

/** The portal_listings row an operation is about. */
export interface PortalListingInfo {
  id: number;
  portal: PortalKey;
  status: PortalListingStatus;
  externalId: string | null;
  publishedAt: Date | null;
  /** What the feed currently serves for this listing (feed portals), or null. */
  payload: FeedPayload | null;
  payloadUpdatedAt: Date | null;
}

/** One problem that blocks publishing to a portal. Shown in the pre-publish check. */
export interface ValidationIssue {
  /** Property field the issue is about: 'title', 'price', 'images', 'city', ... */
  field: string;
  /** Human-readable English message, e.g. 'Realistimo needs the floor area (m²).' */
  message: string;
}

/**
 * Portal-specific, JSON-serialisable representation of one listing, stored in
 * portal_listings.payload. Feed renderers turn a list of these into the feed document.
 */
export type FeedPayload = Record<string, unknown>;

export interface AdapterContext {
  now: Date;
  /** Aborted when the worker shuts down or the job's time budget runs out. */
  signal: AbortSignal;
  /** 1 on the first try. */
  attempt: number;
}

export interface AdapterOutcome {
  /** Identifier assigned by the portal, when there is one (push portals). */
  externalId?: string | null;
  /**
   * Feed portals: the payload the feed should serve from now on. For remove, a payload
   * that marks the listing as gone (e.g. out of stock) or null to drop it from the feed.
   */
  payload?: FeedPayload | null;
  /** Short English summary for the job log, e.g. 'Added to the Realistimo feed'. */
  message: string;
  /** Anything else worth keeping in jobs.result (portal response summary, ...). */
  details?: Record<string, unknown>;
}

export interface PortalAdapter {
  readonly key: PortalKey;
  readonly displayName: string;
  readonly mode: PortalMode;

  /** Pure check against the portal's rules; no I/O. An empty array means ready. */
  validate(property: PortalProperty): ValidationIssue[];

  publish(
    property: PortalProperty,
    listing: PortalListingInfo,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome>;

  update(
    property: PortalProperty,
    listing: PortalListingInfo,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome>;

  /** The property may already be gone (null) when the listing is removed after a delete. */
  remove(
    listing: PortalListingInfo,
    property: PortalProperty | null,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome>;
}

/** A listing as the feed endpoint hands it to a renderer. */
export interface FeedItem {
  refCode: string;
  /** 'published': serve as live. 'removed': serve as gone (if the format can say so). */
  status: Extract<PortalListingStatus, 'published' | 'removed'>;
  payload: FeedPayload;
  payloadUpdatedAt: Date;
}

export interface FeedRenderContext {
  now: Date;
  publicBaseUrl: string;
  /**
   * The newest change of the portal's feed as the database records it: the latest
   * payload_updated_at of every listing of the portal, published and removed, including
   * changes the items cannot show (a removal whose payload became null, which is how a
   * Realistimo offer leaves the feed, or a listing deleted together with its property). A
   * feed-level date such as Realistimo's <updated> must not fall behind it, so a removal
   * still moves it. Null for a portal whose feed never changed.
   */
  lastChangedAt?: Date | null;
}

/** Feed portals also provide a renderer for GET /feeds/<key>/<token>.xml. */
export interface FeedRenderer {
  readonly contentType: string;
  render(items: FeedItem[], ctx: FeedRenderContext): string;
  /**
   * When the document render() returns last changed, for the feed endpoint's Last-Modified.
   * Only needed when the output also depends on ctx.now (a removed item dropping out after a
   * retention period, a date that rolls over); the default is the newest of
   * ctx.lastChangedAt and the items' payloadUpdatedAt. Must not be later than ctx.now.
   */
  lastModified?(items: FeedItem[], ctx: FeedRenderContext): Date | null;
}

/**
 * Thrown by adapters. The worker retries when `retryable` is true and attempts remain,
 * waiting at least `retryAfterMs` when given (e.g. from a Retry-After header); otherwise
 * the job fails and the listing moves to 'error' with `message`.
 */
export class PortalError extends Error {
  override readonly name = 'PortalError';

  constructor(
    message: string,
    readonly retryable: boolean,
    readonly options: { code?: string; retryAfterMs?: number; httpStatus?: number } = {},
  ) {
    super(message);
  }
}
