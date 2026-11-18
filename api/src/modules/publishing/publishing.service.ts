import type { Knex } from 'knex';
import { enqueueListingJob } from '../../jobs/enqueue.js';
import {
  deletePropertyRow,
  deletionBlocker,
  requestPropertyDeletion,
} from '../../jobs/property-deletion.js';
import { createQueueRepository } from '../../jobs/queue.repository.js';
import { queueTransaction, utcNow } from '../../jobs/transaction.js';
import { conflict, HttpError, notFound, type FieldIssue } from '../../lib/http-error.js';
import type { Logger } from '../../logger.js';
import { loadPortalProperty } from '../../portals/property-loader.js';
import type { PortalRegistry } from '../../portals/registry.js';
import type { PortalAdapter, PortalProperty } from '../../portals/types.js';
import { toJobDto } from '../jobs/jobs.mappers.js';
import { createJobRepository } from '../jobs/jobs.repository.js';
import { toPortalListing } from '../properties/properties.mappers.js';
import {
  toPortalCheck,
  toPortalDto,
  type BulkDeleteItemDto,
  type BulkDeleteResult,
  type BulkPublishItemDto,
  type PortalCheckDto,
  type PortalDto,
  type PublishResultDto,
} from './publishing.mappers.js';
import { createPublishingRepository } from './publishing.repository.js';

export interface PublishingServiceDeps {
  db: Knex;
  registry: PortalRegistry;
  logger: Logger;
  config: { publicBaseUrl: string; feeds: { token: string } };
}

/** What one publish or unpublish touched, by id (read back after the commit). */
interface Touched {
  listingIds: number[];
  jobIds: number[];
}

/** 422 NOT_READY with one detail per problem and portal. */
export function notReady(refCode: string, issues: FieldIssue[], displayNames: string[]) {
  return new HttpError(
    422,
    'NOT_READY',
    `Property ${refCode} is not ready for ${displayNames.join(', ')}: ${issues.length} ${
      issues.length === 1 ? 'problem' : 'problems'
    } to fix first (see details)`,
    { details: issues },
  );
}

/**
 * Pre-publish checks, publishing, unpublishing and the bulk operations. Every change is one
 * transaction per property that locks the property row first, then its listings, then their
 * jobs (the same order as every other writer), and queues jobs by the per-listing rules
 * (src/jobs/enqueue.ts). Nothing here talks to a portal: the worker does.
 */
/** What a bulk item reports for an error that is not one of the API's own (logged instead). */
const INTERNAL_ERROR = { code: 'INTERNAL_ERROR', message: 'Internal server error' } as const;

export function createPublishingService(deps: PublishingServiceDeps) {
  const { db, registry, logger, config } = deps;
  const loadOptions = { publicBaseUrl: config.publicBaseUrl };

  const adapterFor = (key: string): PortalAdapter => {
    const adapter = registry.get(key);
    // The validators only let registered keys through.
    if (!adapter) throw new Error(`Portal "${key}" is not registered`);
    return adapter;
  };

  function issuesFor(property: PortalProperty, portals: readonly string[]): FieldIssue[] {
    return portals.flatMap((portal) =>
      adapterFor(portal)
        .validate(property)
        .map(({ field, message }) => ({ portal, field, message })),
    );
  }

  /** Publishes one property inside `trx`. Throws 404, 409 (archived) or 422 NOT_READY. */
  async function publishInTransaction(
    trx: Knex.Transaction,
    propertyId: number,
    portals: readonly string[],
  ): Promise<Touched> {
    const repo = createPublishingRepository(trx);
    const property = await repo.lockProperty(propertyId);
    if (!property) throw notFound(`Property ${propertyId} does not exist`);
    if (property.status === 'archived') {
      throw conflict(
        property.delete_requested_at
          ? `Property ${property.ref_code} is archived and waiting to be deleted; to keep it, set its status to active (this cancels the deletion), then publish it`
          : `Property ${property.ref_code} is archived; set its status to active before publishing it`,
      );
    }

    const portalProperty = await loadPortalProperty(trx, propertyId, loadOptions);
    if (!portalProperty) throw notFound(`Property ${propertyId} does not exist`);
    const issues = issuesFor(portalProperty, portals);
    if (issues.length > 0) {
      const failing = [...new Set(issues.map((issue) => issue.portal ?? ''))];
      throw notReady(
        property.ref_code,
        issues,
        failing.map((key) => adapterFor(key).displayName),
      );
    }

    if (property.status === 'draft') await repo.updateProperty(propertyId, { status: 'active' });

    const touched: Touched = { listingIds: [], jobIds: [] };
    for (const portal of portals) {
      const listingId =
        (await repo.lockListing(propertyId, portal))?.id ??
        (await repo.insertListing(propertyId, portal));
      const result = await enqueueListingJob(trx, listingId, 'publish');
      touched.listingIds.push(listingId);
      if (result.job) touched.jobIds.push(result.job.id);
    }
    return touched;
  }

  async function toResult(touched: Touched): Promise<PublishResultDto> {
    const jobRepo = createJobRepository(db);
    const [listings, jobs, lastSent] = await Promise.all([
      createPublishingRepository(db).listingsByIds(touched.listingIds),
      jobRepo.findByIds(touched.jobIds),
      jobRepo.lastSentFor(touched.listingIds),
    ]);
    return {
      listings: listings.map((listing) => toPortalListing(listing, lastSent)),
      jobs: jobs.map(toJobDto),
    };
  }

  return {
    listPortals(): PortalDto[] {
      const feeds = { publicBaseUrl: config.publicBaseUrl, token: config.feeds.token };
      return [...registry.adapters.values()].map((adapter) => toPortalDto(adapter, feeds));
    },

    /** The pre-publish check: runs each adapter's validate(); changes nothing. */
    async checks(propertyId: number, portals?: readonly string[]): Promise<PortalCheckDto[]> {
      const property = await loadPortalProperty(db, propertyId, loadOptions);
      if (!property) throw notFound(`Property ${propertyId} does not exist`);
      return (portals ?? registry.keys()).map((key) => {
        const adapter = adapterFor(key);
        return toPortalCheck(adapter, adapter.validate(property));
      });
    },

    /**
     * Validates the property for every selected portal (any problem: 422 NOT_READY and
     * nothing is queued), makes a draft property active, and queues a publish job per portal
     * (an update job where the listing is already online; merged into a queued job).
     */
    async publish(propertyId: number, portals: readonly string[]): Promise<PublishResultDto> {
      const touched = await queueTransaction(db, (trx) =>
        publishInTransaction(trx, propertyId, portals),
      );
      return toResult(touched);
    },

    /**
     * Queues remove jobs for the property's listings on the given portals (default: all of
     * them) that are, or may be, online. A listing that never went out gets no job: a draft
     * listing is deleted, and one in error after a first publish that never went through
     * (never published, no payload) becomes 'removed' at once, keeping its job history.
     * Removed listings are left as they are.
     */
    async unpublish(propertyId: number, portals?: readonly string[]): Promise<PublishResultDto> {
      const touched = await queueTransaction(db, async (trx) => {
        const repo = createPublishingRepository(trx);
        if (!(await repo.lockProperty(propertyId))) {
          throw notFound(`Property ${propertyId} does not exist`);
        }
        const listings = (
          await createQueueRepository(trx).lockListingsOfProperty(propertyId)
        ).filter((listing) => !portals || portals.includes(listing.portal));

        const result: Touched = { listingIds: [], jobIds: [] };
        for (const listing of listings) {
          if (listing.status === 'draft') {
            await repo.deleteListing(listing.id);
            continue;
          }
          const queued = await enqueueListingJob(trx, listing.id, 'remove');
          result.listingIds.push(listing.id);
          if (queued.job) {
            result.jobIds.push(queued.job.id);
          } else if (
            queued.listing.status === 'error' &&
            queued.listing.published_at === null &&
            queued.listing.payload === null
          ) {
            await createQueueRepository(trx).updateListing(listing.id, {
              status: 'removed',
              removed_at: utcNow(trx),
              last_error: null,
            });
          }
        }
        return result;
      });
      return toResult(touched);
    },

    /**
     * Publishes several properties to the same portals, one transaction each. A property
     * that is not ready, archived or missing is reported and skipped; the others go ahead.
     * Any other error is logged and reported for its property as INTERNAL_ERROR, so the
     * response always tells which properties went through.
     */
    async bulkPublish(
      propertyIds: readonly number[],
      portals: readonly string[],
    ): Promise<BulkPublishItemDto[]> {
      const items: BulkPublishItemDto[] = [];
      for (const propertyId of propertyIds) {
        try {
          const touched = await queueTransaction(db, (trx) =>
            publishInTransaction(trx, propertyId, portals),
          );
          const { jobs } = await toResult(touched);
          items.push({ propertyId, ok: true, jobs });
        } catch (error) {
          if (!(error instanceof HttpError)) {
            logger.error({ err: error, propertyId }, 'Bulk publish failed for a property');
            items.push({ propertyId, ok: false, error: { ...INTERNAL_ERROR } });
            continue;
          }
          items.push({
            propertyId,
            ok: false,
            ...(error.code === 'NOT_READY' && error.details ? { issues: error.details } : {}),
            error: { code: error.code, message: error.message },
          });
        }
      }
      return items;
    },

    /**
     * Deletes several properties, one transaction each:
     * - deleted: nothing of it was online, so it is gone now;
     * - removal_queued: it is (or may be) online: archived, marked for deletion, remove jobs
     *   queued; the worker deletes it once nothing blocks it any more;
     * - deletion_scheduled: nothing is online, but a feed still serves its removal (a Bazar
     *   item kept as out of stock within BAZAR_REMOVED_RETENTION_DAYS): archived and marked
     *   for deletion; the worker deletes it once that period has passed;
     * - not_found; error: an unexpected error (logged), the other properties go ahead.
     * Photo files are deleted later by the worker's photo sweep.
     */
    async bulkDelete(propertyIds: readonly number[]): Promise<BulkDeleteItemDto[]> {
      const items: BulkDeleteItemDto[] = [];
      for (const propertyId of propertyIds) {
        try {
          const result = await queueTransaction(db, async (trx): Promise<BulkDeleteResult> => {
            const repo = createPublishingRepository(trx);
            const property = await repo.lockProperty(propertyId);
            if (!property) return 'not_found';

            const listings = await createQueueRepository(trx).lockListingsOfProperty(propertyId);
            const blocker = deletionBlocker(listings, {
              removedRetentionDays: registry.removedRetentionDays,
            });
            if (blocker === null) {
              await deletePropertyRow(trx, propertyId);
              return 'deleted';
            }
            await requestPropertyDeletion(trx, property);
            if (blocker.kind === 'tombstone') return 'deletion_scheduled';
            for (const listing of blocker.listings) {
              await enqueueListingJob(trx, listing.id, 'remove');
            }
            return 'removal_queued';
          });
          items.push({ propertyId, result });
        } catch (error) {
          logger.error({ err: error, propertyId }, 'Bulk delete failed for a property');
          items.push({ propertyId, result: 'error', error: { ...INTERNAL_ERROR } });
        }
      }
      return items;
    },
  };
}

export type PublishingService = ReturnType<typeof createPublishingService>;
