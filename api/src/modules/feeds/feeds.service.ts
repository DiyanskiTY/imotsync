import { createHash, timingSafeEqual } from 'node:crypto';
import type { Knex } from 'knex';
import { feedVersion, loadFeedItems, type FeedVersion } from '../../portals/feed-items.js';
import type { PortalRegistry } from '../../portals/registry.js';
import type { FeedItem, FeedRenderContext, FeedRenderer } from '../../portals/types.js';

/** One rendered feed, with what conditional requests compare against. */
export interface RenderedFeed {
  body: string;
  contentType: string;
  /** Strong validator: a hash of the body, quoted. */
  etag: string;
  /** When the document last changed (whole seconds, never in the future), or null. */
  lastModified: Date | null;
}

export interface FeedsServiceDeps {
  db: Knex;
  registry: PortalRegistry;
  /** PUBLIC_BASE_URL. */
  publicBaseUrl: string;
  /** FEED_TOKEN. */
  feedToken: string;
  /** Clock (tests). */
  now?: () => Date;
}

const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest();

/**
 * A rendered feed is reused for this long at most, so that changes that come from the time
 * alone (a removed Bazar item dropping out after its retention period, Realistimo's
 * <updated> rolling over to a new day) show within a minute.
 */
export const FEED_CACHE_MAX_AGE_MS = 60_000;

/**
 * payload_updated_at has whole seconds: a feed rendered right after a change could have the
 * same version as one rendered after a second change within that second. A rendering is
 * reused only once its last change is this much older than the rendering itself.
 */
export const FEED_CACHE_SETTLE_MS = 5_000;

interface CachedFeed {
  key: string;
  renderedAt: number;
  feed: RenderedFeed;
}

const versionKey = (version: FeedVersion) =>
  `${version.lastChangedAt?.toISOString() ?? 'never'}|${String(version.itemCount)}|${String(version.checksum)}`;

/** The newest of lastChangedAt and the items' payloadUpdatedAt (renderers may report later). */
function defaultLastModified(items: readonly FeedItem[], ctx: FeedRenderContext): Date | null {
  let latest = ctx.lastChangedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  for (const item of items) latest = Math.max(latest, item.payloadUpdatedAt.getTime());
  return Number.isFinite(latest) ? new Date(latest) : null;
}

/** HTTP dates have whole seconds; a date in the future would make caches misbehave. */
function httpDate(date: Date | null, now: Date): Date | null {
  if (date === null) return null;
  const ms = Math.min(date.getTime(), now.getTime());
  return new Date(Math.floor(ms / 1000) * 1000);
}

/**
 * The public feeds of the feed portals (GET /feeds/<portal>/<FEED_TOKEN>.xml), rendered from
 * the payloads the jobs stored, so the feed always shows exactly what the last successful
 * jobs produced. A rendered feed is cached per portal under the feed's version (its last
 * change and its number of items, plus a checksum of the change dates, read with one small
 * query, see feedVersion), so repeated and conditional (304) requests do not load the
 * payloads and build the XML again; see FEED_CACHE_MAX_AGE_MS and FEED_CACHE_SETTLE_MS for
 * when a rendering is not reused.
 */
export function createFeedsService(deps: FeedsServiceDeps) {
  const { db, registry, publicBaseUrl } = deps;
  const now = deps.now ?? (() => new Date());
  const tokenDigest = digest(deps.feedToken);
  const cache = new Map<string, CachedFeed>();

  function reusable(cached: CachedFeed | undefined, key: string, version: FeedVersion, at: Date) {
    if (cached?.key !== key) return false;
    const age = at.getTime() - cached.renderedAt;
    if (age < 0 || age > FEED_CACHE_MAX_AGE_MS) return false;
    const settledSince = cached.renderedAt - (version.lastChangedAt?.getTime() ?? -Infinity);
    return settledSince >= FEED_CACHE_SETTLE_MS;
  }

  return {
    /**
     * The renderer of a feed portal when the token is right; null for an unknown portal, a
     * push portal or a wrong token alike. The token is compared in constant time (digests of
     * equal length), so the answer time does not reveal how much of a guess was right.
     */
    rendererFor(portal: string, token: string): FeedRenderer | null {
      const tokenOk = timingSafeEqual(digest(token), tokenDigest);
      const renderer = registry.feedRenderers.get(portal);
      return tokenOk && renderer !== undefined ? renderer : null;
    },

    async render(portal: string, renderer: FeedRenderer): Promise<RenderedFeed> {
      const version = await feedVersion(db, portal);
      const key = versionKey(version);
      const cached = cache.get(portal);
      if (reusable(cached, key, version, now()) && cached) return cached.feed;

      const items = await loadFeedItems(db, portal);
      const ctx: FeedRenderContext = {
        now: now(),
        publicBaseUrl,
        lastChangedAt: version.lastChangedAt,
      };
      const body = renderer.render(items, ctx);
      const lastModified = renderer.lastModified
        ? renderer.lastModified(items, ctx)
        : defaultLastModified(items, ctx);
      const feed: RenderedFeed = {
        body,
        contentType: renderer.contentType,
        etag: `"${digest(body).toString('base64url')}"`,
        lastModified: httpDate(lastModified, ctx.now),
      };
      cache.set(portal, { key, renderedAt: ctx.now.getTime(), feed });
      return feed;
    },
  };
}

export type FeedsService = ReturnType<typeof createFeedsService>;

/**
 * Whether a GET may be answered 304 (RFC 9110, 13.1.2 and 13.1.3): If-None-Match decides when
 * present (weak comparison, '*' matches any current representation); otherwise
 * If-Modified-Since, when the document has not changed since that date.
 */
export function isNotModified(
  headers: { ifNoneMatch?: string; ifModifiedSince?: string },
  feed: Pick<RenderedFeed, 'etag' | 'lastModified'>,
): boolean {
  if (headers.ifNoneMatch !== undefined) {
    const strip = (tag: string) => tag.trim().replace(/^W\//, '');
    const tags = headers.ifNoneMatch.split(',').map(strip);
    return tags.includes('*') || tags.includes(strip(feed.etag));
  }
  if (headers.ifModifiedSince !== undefined && feed.lastModified !== null) {
    const since = Date.parse(headers.ifModifiedSince);
    return !Number.isNaN(since) && feed.lastModified.getTime() <= since;
  }
  return false;
}
