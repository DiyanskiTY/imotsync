import type { Config } from '../config.js';
import {
  createBazarAdapter,
  createBazarFeedRenderer,
  type BazarPlaceNames,
} from './bazar/index.js';
import { createDemoAdapter } from './demo/demo-adapter.js';
import {
  createGeoResolver,
  createRealistimoAdapter,
  createRealistimoFeedRenderer,
  type GeoResolver,
} from './realistimo/index.js';
import type { FeedRenderer, PortalAdapter, PortalKey } from './types.js';

/** One portal: its adapter, and for feed portals the renderer of GET /feeds/<key>/<token>.xml. */
export interface PortalRegistration {
  adapter: PortalAdapter;
  /** Required when adapter.mode is 'feed'. */
  feedRenderer?: FeedRenderer;
  /**
   * Feed portals: how long, in days, the feed still serves a removed listing (0 or left out:
   * not at all). A property is not deleted while one of its removed listings is still served
   * (the listing row holds what the feed serves); see src/jobs/property-deletion.ts. The feed
   * renderer must serve removals by the same period, with isRemovalStillServed
   * (removal-retention.ts).
   */
  removedRetentionDays?: number;
}

/** Builds a portal's registration from the configuration. */
export type PortalFactory = (config: Config) => PortalRegistration;

export interface PortalRegistry {
  /** Adapters by key, in registration order (the order GET /api/portals lists them in). */
  readonly adapters: ReadonlyMap<PortalKey, PortalAdapter>;
  /** Feed renderers by key, for the feed portals only. */
  readonly feedRenderers: ReadonlyMap<PortalKey, FeedRenderer>;
  /** removedRetentionDays by key, for the feed portals that declare one. */
  readonly removedRetentionDays: ReadonlyMap<PortalKey, number>;
  get(key: string): PortalAdapter | undefined;
  has(key: string): boolean;
  /** Registered keys, in registration order. */
  keys(): PortalKey[];
}

/**
 * Realistimo's geo list, read once (the full CSV when present) and shared: Realistimo needs
 * its location ids, and Bazar.bg's feed uses the Bulgarian place names it knows.
 */
let sharedGeo: GeoResolver | undefined;
function geoResolver(): GeoResolver {
  sharedGeo ??= createGeoResolver();
  return sharedGeo;
}

/** Bulgarian names of a city and district from the geo list, when it knows them. */
export function placeNamesFrom(geo: GeoResolver): BazarPlaceNames {
  return (city, district) => {
    const resolution = geo.resolve(city, district);
    return resolution.ok
      ? { city: resolution.placeName, district: resolution.districtName }
      : { city: null, district: null };
  };
}

/**
 * The portals this deployment publishes to, in display order. Adding a portal is one entry
 * here (its adapter needs no migration: portal_listings.portal is a VARCHAR).
 */
export const PORTAL_FACTORIES: readonly PortalFactory[] = [
  (config) => {
    const { agencyUid } = config.portals.realistimo;
    return {
      // The geo resolver reads its data (the full CSV when present) once, synchronously.
      adapter: createRealistimoAdapter({ agencyUid, geo: geoResolver() }),
      feedRenderer: createRealistimoFeedRenderer({ agencyUid }),
      // A removed offer is simply left out of the feed.
      removedRetentionDays: 0,
    };
  },
  (config) => {
    // Declared once: the feed renderer serves a removed item for this long, and the deletion
    // rules (registry.removedRetentionDays) wait for the same period.
    const removedRetentionDays = config.portals.bazar.removedRetentionDays;
    return {
      adapter: createBazarAdapter({
        listingUrlTemplate: config.portals.publicListingUrlTemplate,
        placeNames: placeNamesFrom(geoResolver()),
      }),
      feedRenderer: createBazarFeedRenderer({
        publicBaseUrl: config.publicBaseUrl,
        removedRetentionDays,
      }),
      removedRetentionDays,
    };
  },
  (config) => ({
    adapter: createDemoAdapter({
      failureRate: config.portals.demo.failureRate,
      latencyMs: config.portals.demo.latencyMs,
    }),
  }),
];

/** A registry from ready-made registrations (also used by tests with fake adapters). */
export function registryFrom(registrations: readonly PortalRegistration[]): PortalRegistry {
  const adapters = new Map<PortalKey, PortalAdapter>();
  const feedRenderers = new Map<PortalKey, FeedRenderer>();
  const removedRetentionDays = new Map<PortalKey, number>();
  for (const { adapter, feedRenderer, removedRetentionDays: retention } of registrations) {
    if (adapters.has(adapter.key)) {
      throw new Error(`Portal "${adapter.key}" is registered twice`);
    }
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(adapter.key)) {
      // portal_listings.portal is VARCHAR(32), and the key is a path segment of the feed URL.
      throw new Error(`Portal key "${adapter.key}" must be 1 to 32 lower-case letters or digits`);
    }
    if (adapter.mode === 'feed' && !feedRenderer) {
      throw new Error(`Feed portal "${adapter.key}" needs a feed renderer`);
    }
    if (retention !== undefined && !(Number.isFinite(retention) && retention >= 0)) {
      throw new Error(`Portal "${adapter.key}": removedRetentionDays must be 0 or more`);
    }
    adapters.set(adapter.key, adapter);
    if (adapter.mode === 'feed' && feedRenderer) {
      feedRenderers.set(adapter.key, feedRenderer);
      if (retention !== undefined) removedRetentionDays.set(adapter.key, retention);
    }
  }
  return {
    adapters,
    feedRenderers,
    removedRetentionDays,
    get: (key) => adapters.get(key),
    has: (key) => adapters.has(key),
    keys: () => [...adapters.keys()],
  };
}

/** createPortalRegistry(config): every portal in PORTAL_FACTORIES, configured. */
export function createPortalRegistry(
  config: Config,
  factories: readonly PortalFactory[] = PORTAL_FACTORIES,
): PortalRegistry {
  return registryFrom(factories.map((factory) => factory(config)));
}
