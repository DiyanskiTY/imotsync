import type { JobStatus, PortalListingRow, PortalListingStatus } from '../db/types.js';

/** Job statuses that still hold a listing: the job has not finished yet. */
export const UNFINISHED_JOB_STATUSES = ['queued', 'running'] as const satisfies JobStatus[];

export const isUnfinished = (status: JobStatus) =>
  (UNFINISHED_JOB_STATUSES as readonly JobStatus[]).includes(status);

type ListingState = Pick<PortalListingRow, 'status' | 'published_at' | 'removed_at'>;

/** What says whether a listing's last successful job left it on its portal. */
type PortalPresence = Pick<PortalListingRow, 'published_at' | 'removed_at'>;

/**
 * The last successful job left the listing on the portal: it was published at some point and
 * not removed since. True for a published listing, and for one in 'error' after a failed update
 * or remove (it is still online with its previous data).
 */
export function isOnPortal(listing: PortalPresence): boolean {
  return listing.published_at !== null && listing.removed_at === null;
}

/**
 * The listing is, or may soon be, visible on the portal: a job is queued or running for it,
 * or its last successful job put it there. Such a listing needs a remove job before its
 * property may be deleted.
 */
export function mayBeLive(listing: ListingState): boolean {
  return listing.status === 'pending' || isOnPortal(listing);
}

/** Listing statuses in which the listing has never been sent anywhere and can simply go. */
export const NEVER_SENT_STATUSES: readonly PortalListingStatus[] = ['draft'];
