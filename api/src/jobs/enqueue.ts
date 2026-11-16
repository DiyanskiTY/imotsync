import type { Knex } from 'knex';
import type { JobAction, JobRow, PortalListingRow } from '../db/types.js';
import { isOnPortal, mayBeLive } from './listing-state.js';
import { createQueueRepository, type QueueRepository } from './queue.repository.js';

/*
 * Queueing a job for a portal listing, following the per-listing rules in
 * docs/architecture.md ("Request flow: publishing a property"):
 *
 * - One job at a time per listing, in order (the claim query enforces it).
 * - Merge instead of piling up: adapters always send the property's current data, so a request
 *   that arrives while the listing's newest unfinished job is still queued is merged into it.
 *   A request that arrives while that job is running queues one job behind it. A listing never
 *   has more than two unfinished jobs.
 * - Serialised per listing: the listing row is locked first, then its unfinished jobs.
 */

/**
 * What the caller wants for the listing:
 * - 'publish': be online with the current data (Publish button). Becomes an update job when
 *   the listing is already on the portal.
 * - 'update': the property changed; refresh a listing that is online (published, or in error
 *   while still on the portal). Ignored for a listing that is not on the portal or is about to
 *   be removed.
 * - 'remove': take the listing off the portal (Unpublish, bulk delete). Ignored for a listing
 *   that is not on the portal and has nothing queued or running (draft, removed, or in error
 *   after a first publish that never went through).
 */
export type EnqueueIntent = JobAction;

export type EnqueuePlan =
  /** Insert a new job with this action (behind the running or retrying one, if any). */
  | { kind: 'insert'; action: JobAction }
  /** The newest unfinished job already does what is asked; nothing to write. */
  | { kind: 'merge'; job: JobRow }
  /** Turn the newest job, which is queued and has never run, into this action. */
  | { kind: 'replace'; job: JobRow; action: JobAction }
  /** Nothing to do for this listing. */
  | { kind: 'skip'; reason: string };

type ListingState = Pick<PortalListingRow, 'status' | 'published_at' | 'removed_at'>;

/**
 * The decision, without any I/O. `unfinished` is the listing's queued and running jobs,
 * oldest first (ordered by id).
 */
export function planEnqueue(
  listing: ListingState,
  unfinished: readonly JobRow[],
  intent: EnqueueIntent,
): EnqueuePlan {
  const newest = unfinished.at(-1);

  if (!newest) {
    switch (intent) {
      case 'publish':
        return { kind: 'insert', action: isOnPortal(listing) ? 'update' : 'publish' };
      case 'update':
        // A listing in 'error' that is still on the portal (a failed update, or an import
        // error the portal reported) is online with older data: the edit must reach it.
        return isOnPortal(listing)
          ? { kind: 'insert', action: 'update' }
          : { kind: 'skip', reason: `the listing is ${listing.status} and not on the portal` };
      case 'remove':
        // Only a listing that is, or may be, on the portal needs a removal.
        return mayBeLive(listing)
          ? { kind: 'insert', action: 'remove' }
          : {
              kind: 'skip',
              reason: `the listing is ${listing.status} and not on the portal; there is nothing to remove`,
            };
    }
  }

  const removing = newest.action === 'remove';
  const neverRan = newest.status === 'queued' && newest.attempts === 0;

  if (newest.status === 'queued') {
    switch (intent) {
      case 'publish':
        // Publish and update merge into a publish: the worker then decides from the listing
        // whether the portal call creates the listing or updates it (effectiveAction).
        if (newest.action === 'update') return { kind: 'replace', job: newest, action: 'publish' };
        if (!removing) return { kind: 'merge', job: newest };
        // The removal has not started: the listing is still where it was, so bring it up to date.
        return neverRan
          ? { kind: 'replace', job: newest, action: isOnPortal(listing) ? 'update' : 'publish' }
          : { kind: 'insert', action: 'publish' };
      case 'update':
        return removing
          ? { kind: 'skip', reason: 'the listing is about to be removed' }
          : { kind: 'merge', job: newest };
      case 'remove':
        if (removing) return { kind: 'merge', job: newest };
        // A publish or update that already ran (and waits for a retry) may have reached the
        // portal, so the removal must come after it.
        return neverRan
          ? { kind: 'replace', job: newest, action: 'remove' }
          : { kind: 'insert', action: 'remove' };
    }
  }

  // The newest job is running: it loaded the property's data when it started.
  switch (intent) {
    case 'publish':
      // A running publish or update already sends the current data (an edit made after it
      // started queued an update of its own).
      return removing ? { kind: 'insert', action: 'publish' } : { kind: 'merge', job: newest };
    case 'update':
      return removing
        ? { kind: 'skip', reason: 'the listing is being removed' }
        : { kind: 'insert', action: 'update' };
    case 'remove':
      return removing ? { kind: 'merge', job: newest } : { kind: 'insert', action: 'remove' };
  }
}

export type EnqueueEffect = 'created' | 'merged' | 'replaced' | 'skipped';

export interface EnqueueResult {
  effect: EnqueueEffect;
  /** The job that will carry out the request (null when skipped). */
  job: JobRow | null;
  /** The listing after the change. */
  listing: PortalListingRow;
  /** Why nothing was queued (skipped only). */
  reason?: string;
}

/**
 * Applies the rules above to one listing, inside the caller's transaction (use
 * queueTransaction). Locks the listing row, then its unfinished jobs; a listing that gets a
 * job (new, merged or replaced) moves to 'pending'.
 */
export async function enqueueListingJob(
  trx: Knex.Transaction,
  listingId: number,
  intent: EnqueueIntent,
): Promise<EnqueueResult> {
  const queue = createQueueRepository(trx);
  const listing = await queue.lockListing(listingId);
  if (!listing) throw new Error(`Portal listing ${listingId} does not exist`);
  const unfinished = await queue.lockUnfinishedJobs(listingId);

  const plan = planEnqueue(listing, unfinished, intent);
  let effect: EnqueueEffect;
  let job: JobRow | null;
  switch (plan.kind) {
    case 'skip':
      return { effect: 'skipped', job: null, listing, reason: plan.reason };
    case 'merge':
      effect = 'merged';
      job = plan.job;
      break;
    case 'replace':
      await queue.setJobAction(plan.job.id, plan.action);
      effect = 'replaced';
      job = { ...plan.job, action: plan.action };
      break;
    case 'insert':
      if (unfinished.length >= 2) {
        // planEnqueue never inserts in this state; a third unfinished job would be a bug.
        throw new Error(`Portal listing ${listingId} already has two unfinished jobs`);
      }
      effect = 'created';
      job = await queue.insertJob(listingId, plan.action);
      break;
  }

  if (listing.status !== 'pending') {
    await queue.updateListing(listingId, { status: 'pending' });
  }
  return { effect, job, listing: await queue.findListing(listingId) };
}

/**
 * Whether an edit should reach the listing: it is pending (the merge rules decide), or it is
 * on the portal, i.e. published, or in 'error' with an older version still online (a failed
 * update, or an import error the portal reported). A listing in 'error' because its removal
 * failed is left alone: it was meant to go, and an update would put it back to 'published'
 * and hide that failure.
 */
async function takesEdits(queue: QueueRepository, listing: PortalListingRow): Promise<boolean> {
  if (listing.status === 'pending') return true;
  if (!isOnPortal(listing)) return false;
  if (listing.status !== 'error') return true;
  return (await queue.newestJob(listing.id))?.action !== 'remove';
}

/**
 * After a change to a property that portals show (fields or photos): queues an update for
 * every listing that is on its portal (see takesEdits), and merges into or queues behind the
 * jobs of pending ones. Call inside the transaction that makes the change, after locking the
 * property row.
 */
export async function enqueueUpdatesForProperty(
  trx: Knex.Transaction,
  propertyId: number,
): Promise<EnqueueResult[]> {
  const queue = createQueueRepository(trx);
  const listings = await queue.lockListingsOfProperty(propertyId);
  const results: EnqueueResult[] = [];
  for (const listing of listings) {
    if (!(await takesEdits(queue, listing))) continue;
    results.push(await enqueueListingJob(trx, listing.id, 'update'));
  }
  return results;
}
