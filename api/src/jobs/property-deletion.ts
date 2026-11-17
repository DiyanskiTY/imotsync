import type { Knex } from 'knex';
import type { PortalListingRow } from '../db/types.js';
import type { Logger } from '../logger.js';
import { recordFeedChangeForDeletedProperty } from '../portals/feed-items.js';
import { isRemovalStillServed, removalRetentionCutoff } from '../portals/removal-retention.js';
import { mayBeLive, UNFINISHED_JOB_STATUSES } from './listing-state.js';
import { createQueueRepository } from './queue.repository.js';
import { queueTransaction } from './transaction.js';

/*
 * Deleting a property that has been on a portal. The row (with its listings and jobs) may go
 * only once nothing of it is online and no feed still needs its listing rows:
 * - no listing is pending, published, or in error while still online (mayBeLive);
 * - no job of it is queued or running;
 * - no feed still serves a removal from its rows: a Bazar.bg item kept as out of stock after
 *   its removal (a "tombstone") stays in the feed for BAZAR_REMOVED_RETENTION_DAYS so that
 *   Bazar sees it at one of its scheduled downloads and archives the listing, instead of the
 *   item vanishing (and the feed shrinking suddenly, which makes Bazar stop the import).
 *
 * Photo files are never deleted here: a stored feed payload may still link to them. The
 * worker's photo sweep (photo-gc.ts) deletes files nothing refers to any more.
 */

export interface DeletionRules {
  /**
   * Days each feed portal keeps serving a removed listing (PortalRegistry.removedRetentionDays,
   * e.g. bazar: BAZAR_REMOVED_RETENTION_DAYS). Portals that are not in the map keep nothing.
   */
  removedRetentionDays: ReadonlyMap<string, number>;
  /** Clock (tests). Default: now. */
  now?: Date;
}

type TombstoneFields = Pick<
  PortalListingRow,
  'portal' | 'payload' | 'payload_updated_at' | 'removed_at'
>;

/**
 * The listing was removed, and its portal's feed still serves the removal (its payload, e.g.
 * marked out of stock) because the portal's retention period has not passed yet.
 */
export function isFeedTombstone(
  listing: TombstoneFields,
  removedRetentionDays: ReadonlyMap<string, number>,
  now: Date,
): boolean {
  if (listing.removed_at === null || listing.payload === null) return false;
  if (listing.payload_updated_at === null) return false;
  const days = removedRetentionDays.get(listing.portal) ?? 0;
  // The rule the Bazar feed renderer serves removed items by.
  return isRemovalStillServed(listing.payload_updated_at, days, now);
}

/** What keeps a property from being deleted now, or null when it may go. */
export type DeletionBlocker =
  /** A listing is, or may soon be, online: it needs a remove job first. */
  | { kind: 'live'; listings: PortalListingRow[] }
  /** Only removal tombstones within their retention period: delete after it has passed. */
  | { kind: 'tombstone'; listings: PortalListingRow[] };

export function deletionBlocker(
  listings: readonly PortalListingRow[],
  rules: DeletionRules,
): DeletionBlocker | null {
  const live = listings.filter(mayBeLive);
  if (live.length > 0) return { kind: 'live', listings: live };
  const now = rules.now ?? new Date();
  const tombstones = listings.filter((listing) =>
    isFeedTombstone(listing, rules.removedRetentionDays, now),
  );
  return tombstones.length > 0 ? { kind: 'tombstone', listings: tombstones } : null;
}

/**
 * Deletes a property row inside the caller's transaction (its photos, listings and jobs go
 * with it: ON DELETE CASCADE), keeping the feeds' change dates (see
 * recordFeedChangeForDeletedProperty). Lock the property and its listings first.
 */
export async function deletePropertyRow(trx: Knex.Transaction, propertyId: number): Promise<void> {
  await recordFeedChangeForDeletedProperty(trx, propertyId);
  await trx('properties').where({ id: propertyId }).delete();
}

/**
 * Marks a property for deletion (bulk delete, or DELETE of a property whose feed still serves
 * a removal): it is archived and properties.delete_requested_at is set. The worker deletes it
 * once nothing blocks it any more (finishRequestedDeletion). Setting the status back to
 * active or draft clears delete_requested_at, which cancels the deletion.
 */
export async function requestPropertyDeletion(
  trx: Knex.Transaction,
  property: { id: number; delete_requested_at: Date | null },
): Promise<void> {
  await trx('properties')
    .where({ id: property.id })
    .update({
      status: 'archived',
      delete_requested_at: property.delete_requested_at ?? trx.raw('UTC_TIMESTAMP()'),
      updated_at: trx.fn.now(),
    });
}

/**
 * Finishes a requested deletion (properties.delete_requested_at) once nothing blocks it: the
 * property is still archived (setting it back to active or draft cancels the deletion), no
 * listing may be online, no job is queued or running, and no feed still serves a removal
 * within its retention period. Called by the worker after each final job outcome and by its
 * periodic sweep (finishPendingDeletions). Returns true when the property was deleted.
 */
export async function finishRequestedDeletion(
  db: Knex,
  logger: Logger,
  propertyId: number,
  rules: DeletionRules,
): Promise<boolean> {
  // Most jobs belong to properties nobody is deleting: skip the locks for them.
  const requested = await db('properties')
    .where({ id: propertyId })
    .whereNotNull('delete_requested_at')
    .first('id');
  if (!requested) return false;

  const deleted = await queueTransaction(db, async (trx) => {
    const queue = createQueueRepository(trx);
    const property = await queue.lockProperty(propertyId);
    if (!property?.delete_requested_at || property.status !== 'archived') return false;

    const listings = await queue.lockListingsOfProperty(propertyId);
    if (deletionBlocker(listings, rules) !== null) return false;
    if (listings.length > 0) {
      const unfinished = await trx('jobs')
        .whereIn(
          'portal_listing_id',
          listings.map((listing) => listing.id),
        )
        .whereIn('status', UNFINISHED_JOB_STATUSES)
        .first('id');
      if (unfinished) return false;
    }
    await deletePropertyRow(trx, propertyId);
    return true;
  });
  if (deleted) logger.info({ propertyId }, 'Deleted a property whose deletion was requested');
  return deleted;
}

/** At most this many waiting deletions are looked at per call. */
const PENDING_DELETIONS_BATCH = 50;

/**
 * Ids of the properties finishPendingDeletions tries to delete (at most one batch): archived,
 * with delete_requested_at, and none of their listings pending, online or a tombstone the feed
 * still serves.
 *
 * This is a pre-filter only, so that the sweep does not lock properties that cannot go yet:
 * finishRequestedDeletion decides under locks with deletionBlocker. Its tombstone condition
 * repeats isRemovalStillServed in SQL (retention > 0, payload_updated_at at or after
 * removalRetentionCutoff) and must keep the same boundary; a test checks that they agree.
 */
export async function pendingDeletionCandidates(
  db: Knex,
  rules: DeletionRules & { now: Date },
): Promise<number[]> {
  const { now } = rules;
  const retained = [...rules.removedRetentionDays].filter(([, days]) => days > 0);
  return db('properties')
    .whereNotNull('delete_requested_at')
    .where('status', 'archived')
    .whereNotExists((query) => {
      void query
        .select(db.raw('1'))
        .from('portal_listings')
        .whereRaw('portal_listings.property_id = properties.id')
        .where((blocking) => {
          void blocking.where('portal_listings.status', 'pending').orWhere((online) => {
            void online
              .whereNotNull('portal_listings.published_at')
              .whereNull('portal_listings.removed_at');
          });
          for (const [portal, days] of retained) {
            void blocking.orWhere((tombstone) => {
              void tombstone
                .where('portal_listings.portal', portal)
                .whereNotNull('portal_listings.removed_at')
                .whereNotNull('portal_listings.payload')
                .where(
                  'portal_listings.payload_updated_at',
                  '>=',
                  removalRetentionCutoff(days, now),
                );
            });
          }
        });
    })
    .orderBy('id', 'asc')
    .limit(PENDING_DELETIONS_BATCH)
    .pluck('id');
}

/**
 * The worker's periodic check: finishes the requested deletions that are ready but were not
 * completed right after a job, e.g. because the job that ended last failed, finishing threw
 * (database trouble), or a removal tombstone was still within its retention period.
 * Candidates come from pendingDeletionCandidates; finishRequestedDeletion checks each again
 * under locks. Returns the ids deleted.
 */
export async function finishPendingDeletions(
  db: Knex,
  logger: Logger,
  rules: DeletionRules,
): Promise<number[]> {
  const now = rules.now ?? new Date();
  const candidates = await pendingDeletionCandidates(db, { ...rules, now });

  const deleted: number[] = [];
  for (const propertyId of candidates) {
    try {
      if (await finishRequestedDeletion(db, logger, propertyId, { ...rules, now })) {
        deleted.push(propertyId);
      }
    } catch (error) {
      logger.error(
        { err: error, propertyId },
        'Could not finish the requested deletion of a property',
      );
    }
  }
  return deleted;
}
