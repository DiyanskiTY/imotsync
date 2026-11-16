import type { Knex } from 'knex';
import { isOnPortal } from '../../jobs/listing-state.js';
import { loadPortalProperties, toPortalListingInfo } from '../../portals/property-loader.js';
import type { PortalRegistry } from '../../portals/registry.js';
import type { AdapterContext, FeedPayload } from '../../portals/types.js';
import type { PortalListingRow } from '../types.js';

/*
 * SEED HOOK FOR FEED PORTALS.
 *
 * Feed portals (Realistimo, Bazar) serve what portal_listings.payload holds, and only a
 * successful job writes it. So that both feeds have content right after `npm run db:reset`,
 * the seed asks each registered feed adapter for the payloads of the seeded listings, the
 * same way a job would: publish() for a listing that is online, then remove() for one that
 * was removed (Bazar keeps it as out of stock; Realistimo drops it, payload null, and the
 * recorded payload_updated_at still dates the feed's <updated>), like a job would. Each
 * payload is built with ctx.now set to the time of the seeded job that built it (the listing's
 * updated_at, or removed_at for the removal), so dates inside the payload, such as Realistimo's
 * <last_update>, match payload_updated_at and never lie after the feed's <updated>.
 *
 * Nothing portal-specific lives here: registering an adapter in src/portals/registry.ts is
 * enough for its listings to get payloads. Listings of portals that are not registered keep
 * no payload.
 *
 * The seed also refuses demo data that a portal's own rules would reject: every seeded
 * listing that is published or pending must pass that portal's validate(), so the demo shows
 * consistent states and the seeded queued jobs can actually be processed by the worker.
 */

export interface SeedPayloadOptions {
  registry: PortalRegistry;
  /** PUBLIC_BASE_URL, for the absolute photo URLs adapters receive. */
  publicBaseUrl: string;
}

export interface SeedPayloadSummary {
  /** Listings that got a payload, per portal. */
  payloads: Record<string, number>;
}

/** Runs inside the seed's transaction, after every row is inserted. */
export async function buildSeedFeedPayloads(
  trx: Knex.Transaction,
  options: SeedPayloadOptions,
): Promise<SeedPayloadSummary> {
  const { registry, publicBaseUrl } = options;
  const listings: PortalListingRow[] = await trx('portal_listings').orderBy('id');
  const properties = await loadPortalProperties(
    trx,
    listings.map((listing) => listing.property_id),
    { publicBaseUrl },
  );
  const refCodes = new Map([...properties.values()].map((p) => [p.id, p.refCode]));
  const signal = new AbortController().signal;
  /** A job's context at the simulated time of that job. */
  const contextAt = (now: Date): AdapterContext => ({ now, signal, attempt: 1 });
  const summary: SeedPayloadSummary = { payloads: {} };

  for (const listing of listings) {
    const adapter = registry.get(listing.portal);
    const property = properties.get(listing.property_id);
    if (!adapter || !property) continue;

    if (listing.status === 'published' || listing.status === 'pending') {
      const issues = adapter.validate(property);
      if (issues.length > 0) {
        const list = issues.map((issue) => `${issue.field}: ${issue.message}`).join('; ');
        throw new Error(
          `Demo data: ${refCodes.get(listing.property_id) ?? listing.property_id} is ${listing.status} on ` +
            `${listing.portal}, but ${adapter.displayName} would reject it (${list}). Fix src/db/seeds/demo-data.ts.`,
        );
      }
    }

    const wasOnline = listing.published_at !== null;
    if (adapter.mode !== 'feed' || !wasOnline) continue;

    const info = toPortalListingInfo(listing);
    const removedAt = isOnPortal(listing) ? null : (listing.removed_at ?? listing.updated_at);
    let payload: FeedPayload | null | undefined = (
      await adapter.publish(property, info, contextAt(listing.updated_at))
    ).payload;
    if (removedAt !== null) {
      // Removed since: what the feed serves for a removed listing (if anything).
      payload = (
        await adapter.remove(
          { ...info, payload: payload ?? null, payloadUpdatedAt: listing.updated_at },
          property,
          contextAt(removedAt),
        )
      ).payload;
    }
    if (payload === undefined) continue;

    // Like a successful job: the change is dated even when the payload is null (removed).
    await trx('portal_listings')
      .where({ id: listing.id })
      .update({
        payload: payload === null ? null : JSON.stringify(payload),
        payload_updated_at: removedAt ?? listing.updated_at,
        // Keep the seeded history: ON UPDATE CURRENT_TIMESTAMP would otherwise move it to now.
        updated_at: listing.updated_at,
      });
    if (payload !== null) {
      summary.payloads[listing.portal] = (summary.payloads[listing.portal] ?? 0) + 1;
    }
  }
  return summary;
}
