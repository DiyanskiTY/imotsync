import type { Knex } from 'knex';
import type { FeedItem } from './types.js';

/** A listing row with what the feed needs. */
interface FeedRow {
  ref_code: string;
  payload: Record<string, unknown> | null;
  payload_updated_at: Date | null;
  removed_at: Date | null;
}

/**
 * Everything a portal's feed should contain right now: every listing of the portal with a
 * stored payload, oldest property first.
 *
 * The status of an item comes from the last SUCCESSFUL job, not from the listing's current
 * status: a listing that is 'pending' (an update is queued) or in 'error' (an update failed)
 * is still online with its stored payload, and must stay in the feed until a job changes the
 * payload. Dropping it would make the portal delete the offer at its next import.
 * - removed_at null: 'published' (the last successful job published or updated it);
 * - removed_at set: 'removed' (a remove succeeded and the adapter kept a payload that marks
 *   the listing as gone, e.g. out of stock; the renderer decides how long to keep it).
 */
export async function loadFeedItems(db: Knex, portal: string): Promise<FeedItem[]> {
  const rows = await db('portal_listings')
    .join('properties', 'properties.id', 'portal_listings.property_id')
    .where('portal_listings.portal', portal)
    .whereNotNull('portal_listings.payload')
    .whereNotNull('portal_listings.payload_updated_at')
    .orderBy([
      { column: 'properties.id', order: 'asc' },
      { column: 'portal_listings.id', order: 'asc' },
    ])
    .select<FeedRow[]>(
      'properties.ref_code',
      'portal_listings.payload',
      'portal_listings.payload_updated_at',
      'portal_listings.removed_at',
    );

  return rows.flatMap((row) =>
    row.payload !== null && row.payload_updated_at !== null
      ? [
          {
            refCode: row.ref_code,
            status: row.removed_at === null ? 'published' : 'removed',
            payload: row.payload,
            payloadUpdatedAt: row.payload_updated_at,
          } satisfies FeedItem,
        ]
      : [],
  );
}

/** What identifies one state of a portal's feed (the key of the rendered-feed cache). */
export interface FeedVersion {
  /** feedLastChanged: the newest change of the feed, or null for a feed that never changed. */
  lastChangedAt: Date | null;
  /** How many listings of the portal have a stored payload (the items loadFeedItems returns). */
  itemCount: number;
  /**
   * The sum of every listing's payload_updated_at (in seconds): changes with any of them, also
   * one that does not move lastChangedAt (e.g. a date changed by the demo seed).
   */
  checksum: number;
}

/**
 * The feed's version, without loading the payloads: the newest change (feedLastChanged), the
 * number of items and a checksum of the change dates. Every successful job of a feed portal sets payload_updated_at (also
 * when the payload becomes null), and deleting a property with a feed listing records the
 * change in portal_sync_state.feed_changed_at, so a change of the feed changes this value.
 */
export async function feedVersion(db: Knex, portal: string): Promise<FeedVersion> {
  const [listings, state] = await Promise.all([
    db('portal_listings')
      .where({ portal })
      .first<
        | { latest: Date | null; items: number | string | null; checksum: number | string | null }
        | undefined
      >(
        db.raw('MAX(payload_updated_at) AS latest'),
        db.raw('SUM(payload IS NOT NULL AND payload_updated_at IS NOT NULL) AS items'),
        db.raw('SUM(UNIX_TIMESTAMP(payload_updated_at)) AS checksum'),
      ),
    db('portal_sync_state').where({ portal }).first('feed_changed_at'),
  ]);
  const dates = [listings?.latest ?? null, state?.feed_changed_at ?? null].filter(
    (date): date is Date => date !== null,
  );
  return {
    lastChangedAt:
      dates.length === 0 ? null : new Date(Math.max(...dates.map((date) => date.getTime()))),
    itemCount: Number(listings?.items ?? 0),
    checksum: Number(listings?.checksum ?? 0),
  };
}

/**
 * The newest change of a portal's feed, or null for a feed that never changed: the newest
 * payload_updated_at of every listing of the portal, published and removed (rows whose
 * payload became null included), or of listings deleted together with their property
 * (portal_sync_state.feed_changed_at), whichever is later. The feed endpoint passes it to the
 * renderer as FeedRenderContext.lastChangedAt, and the Realistimo import sync uses it.
 */
export async function feedLastChanged(db: Knex, portal: string): Promise<Date | null> {
  return (await feedVersion(db, portal)).lastChangedAt;
}

interface DeletedListingRow {
  portal: string;
  payload_updated_at: Date | null;
  removed_at: Date | null;
}

/**
 * Call inside the transaction that deletes a property, BEFORE the delete. Its listing rows go
 * with it (ON DELETE CASCADE), and with them the payload_updated_at that feedLastChanged
 * reads, so a feed date such as Realistimo's <updated> could fall back. The newest
 * payload_updated_at of the deleted listings is kept in portal_sync_state.feed_changed_at
 * instead. A listing that still had a live payload (the callers never delete one, but should
 * it happen) leaves its feed now, so the change is dated now.
 *
 * Returns the portals whose feed records changed.
 */
export async function recordFeedChangeForDeletedProperty(
  trx: Knex.Transaction,
  propertyId: number,
): Promise<string[]> {
  const rows = await trx('portal_listings')
    .where({ property_id: propertyId })
    .where((query) => {
      void query.whereNotNull('payload').orWhereNotNull('payload_updated_at');
    })
    .orderBy('portal', 'asc')
    .select<DeletedListingRow[]>('portal', 'payload_updated_at', 'removed_at');

  const portals = new Set<string>();
  for (const row of rows) {
    portals.add(row.portal);
    // Null: the feed changes now (a live payload leaves it, or no date was recorded).
    const changedAt = row.removed_at === null ? null : row.payload_updated_at;
    if (changedAt === null) {
      await trx.raw(
        'INSERT INTO portal_sync_state (portal, feed_changed_at) VALUES (?, UTC_TIMESTAMP()) ' +
          'ON DUPLICATE KEY UPDATE feed_changed_at = UTC_TIMESTAMP()',
        [row.portal],
      );
    } else {
      await trx.raw(
        'INSERT INTO portal_sync_state (portal, feed_changed_at) VALUES (?, ?) ' +
          'ON DUPLICATE KEY UPDATE feed_changed_at = ' +
          'GREATEST(COALESCE(feed_changed_at, VALUES(feed_changed_at)), VALUES(feed_changed_at))',
        [row.portal, changedAt],
      );
    }
  }
  return [...portals];
}
