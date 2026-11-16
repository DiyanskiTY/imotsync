import type { Knex } from 'knex';
import type { PortalListingRow, PropertyRow } from '../../db/types.js';

/** SQL for publishing. Pass the transaction the work runs in. */
export function createPublishingRepository(db: Knex) {
  return {
    /** The property row, locked until the transaction ends. */
    lockProperty(id: number): Promise<PropertyRow | undefined> {
      return db('properties').where({ id }).forUpdate().first();
    },

    async updateProperty(
      id: number,
      changes: Partial<Pick<PropertyRow, 'status' | 'delete_requested_at'>>,
    ): Promise<void> {
      await db('properties')
        .where({ id })
        .update({ ...changes, updated_at: db.fn.now() });
    },

    /** The property's listing on one portal, locked; undefined if there is none yet. */
    lockListing(propertyId: number, portal: string): Promise<PortalListingRow | undefined> {
      return db('portal_listings').where({ property_id: propertyId, portal }).forUpdate().first();
    },

    /** A new listing in 'draft' (queueing a job moves it on); returns its id. */
    async insertListing(propertyId: number, portal: string): Promise<number> {
      const [id] = await db('portal_listings').insert({
        property_id: propertyId,
        portal,
        status: 'draft',
      });
      if (id === undefined) throw new Error('INSERT into portal_listings returned no id');
      return id;
    },

    async deleteListing(id: number): Promise<void> {
      await db('portal_listings').where({ id }).delete();
    },

    /** Listings by id, ordered by portal. */
    async listingsByIds(ids: readonly number[]): Promise<PortalListingRow[]> {
      if (ids.length === 0) return [];
      return db('portal_listings')
        .whereIn('id', [...ids])
        .orderBy([
          { column: 'portal', order: 'asc' },
          { column: 'id', order: 'asc' },
        ]);
    },
  };
}

export type PublishingRepository = ReturnType<typeof createPublishingRepository>;
