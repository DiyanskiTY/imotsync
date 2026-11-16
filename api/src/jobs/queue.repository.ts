import type { Knex } from 'knex';
import type {
  JobAction,
  JobRow,
  NewPortalListing,
  PortalListingRow,
  PropertyRow,
  UpdateWithRaw,
} from '../db/types.js';
import { UNFINISHED_JOB_STATUSES } from './listing-state.js';

/** Default number of attempts of a new job (the column default, made explicit). */
export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * SQL of the publishing queue. Pass the transaction the work runs in. The lock order is
 * always property -> listing -> jobs, so two transactions never wait for each other in a cycle.
 */
export function createQueueRepository(db: Knex) {
  return {
    /** The listing row, locked until the transaction ends. */
    lockListing(listingId: number): Promise<PortalListingRow | undefined> {
      return db('portal_listings').where({ id: listingId }).forUpdate().first();
    },

    /** All listings of a property, locked, in a fixed order. */
    lockListingsOfProperty(propertyId: number): Promise<PortalListingRow[]> {
      return db('portal_listings')
        .where({ property_id: propertyId })
        .orderBy([
          { column: 'portal', order: 'asc' },
          { column: 'id', order: 'asc' },
        ])
        .forUpdate();
    },

    /** The listing's queued and running jobs, oldest first, locked. Lock the listing first. */
    lockUnfinishedJobs(listingId: number): Promise<JobRow[]> {
      return db('jobs')
        .where({ portal_listing_id: listingId })
        .whereIn('status', UNFINISHED_JOB_STATUSES)
        .orderBy('id', 'asc')
        .forUpdate();
    },

    findJob(jobId: number): Promise<JobRow | undefined> {
      return db('jobs').where({ id: jobId }).first();
    },

    /** The listing's most recently queued job, whatever its status. */
    newestJob(listingId: number): Promise<JobRow | undefined> {
      return db('jobs').where({ portal_listing_id: listingId }).orderBy('id', 'desc').first();
    },

    /** The property row, locked until the transaction ends (lock it before its listings). */
    lockProperty(propertyId: number): Promise<PropertyRow | undefined> {
      return db('properties').where({ id: propertyId }).forUpdate().first();
    },

    /** Inserts a queued job that may run at once and returns it. */
    async insertJob(listingId: number, action: JobAction): Promise<JobRow> {
      const [id] = await db('jobs').insert({
        portal_listing_id: listingId,
        action,
        max_attempts: DEFAULT_MAX_ATTEMPTS,
      });
      if (id === undefined) throw new Error('INSERT into jobs returned no id');
      const job = await db('jobs').where({ id }).first();
      if (!job) throw new Error(`Job ${id} vanished right after the INSERT`);
      return job;
    },

    async setJobAction(jobId: number, action: JobAction): Promise<void> {
      await db('jobs').where({ id: jobId }).update({ action });
    },

    async updateListing(
      listingId: number,
      changes: UpdateWithRaw<NewPortalListing>,
    ): Promise<void> {
      await db('portal_listings').where({ id: listingId }).update(changes);
    },

    async findListing(listingId: number): Promise<PortalListingRow> {
      const listing = await db('portal_listings').where({ id: listingId }).first();
      if (!listing) throw new Error(`Portal listing ${listingId} does not exist`);
      return listing;
    },
  };
}

export type QueueRepository = ReturnType<typeof createQueueRepository>;
