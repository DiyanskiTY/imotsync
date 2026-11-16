import type { Knex } from 'knex';
import { isUnfinished } from '../../jobs/listing-state.js';
import { createQueueRepository } from '../../jobs/queue.repository.js';
import { queueTransaction } from '../../jobs/transaction.js';
import { conflict, notFound } from '../../lib/http-error.js';
import type { PortalRegistry } from '../../portals/registry.js';
import type { PaginationMeta } from '../properties/properties.mappers.js';
import { toJobDto, type JobDto } from './jobs.mappers.js';
import { createJobRepository } from './jobs.repository.js';
import {
  DEFAULT_JOB_PAGE_SIZE,
  DEFAULT_JOB_SORT,
  parseJobSort,
  type ListJobsQuery,
} from './jobs.validators.js';

export interface JobList {
  data: JobDto[];
  meta: PaginationMeta;
}

/** The job log and the Retry button. */
export function createJobsService(deps: { db: Knex; registry: PortalRegistry }) {
  const { db, registry } = deps;
  const jobs = createJobRepository(db);

  async function get(id: number): Promise<JobDto> {
    const row = await jobs.findById(id);
    if (!row) throw notFound(`Job ${id} does not exist`);
    return toJobDto(row);
  }

  return {
    get,

    async list(query: ListJobsQuery): Promise<JobList> {
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? DEFAULT_JOB_PAGE_SIZE;
      const sort = parseJobSort(query.sort ?? DEFAULT_JOB_SORT) ?? {
        field: 'createdAt',
        direction: 'desc',
      };
      const { rows, total } = await jobs.list({
        page,
        pageSize,
        sort,
        filters: {
          status: query.status,
          action: query.action,
          portal: query.portal,
          propertyId: query.propertyId,
        },
      });
      return {
        data: rows.map(toJobDto),
        meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
      };
    },

    /**
     * Retry does not reopen a failed job: it queues a new job for the same listing and action,
     * so the failed one stays in the log. Only for the listing's newest job, when it failed and
     * nothing else is queued or running for the listing.
     */
    async retry(id: number): Promise<JobDto> {
      const newId = await queueTransaction(db, async (trx) => {
        const queue = createQueueRepository(trx);
        const found = await queue.findJob(id);
        if (!found) throw notFound(`Job ${id} does not exist`);
        // The lock order of every writer: the property, then the listing, then its jobs. A
        // listing never moves to another property, so its property_id is safe to read first.
        const owner = await trx('portal_listings')
          .where({ id: found.portal_listing_id })
          .first('property_id');
        if (!owner) throw notFound(`Job ${id} does not exist`);
        const property = await queue.lockProperty(owner.property_id);
        const listing = await queue.lockListing(found.portal_listing_id);
        if (!property || !listing) throw notFound(`Job ${id} does not exist`);
        const unfinished = await queue.lockUnfinishedJobs(listing.id);
        // Read again under the listing lock: the job may have changed since.
        const job = (await queue.findJob(id)) ?? found;

        if (job.status !== 'failed') {
          throw conflict(`Job ${id} is ${job.status}; only a failed job can be retried`);
        }
        const blocking = unfinished.find((other) => isUnfinished(other.status));
        if (blocking) {
          throw conflict(
            `Job ${blocking.id} for the same listing is ${blocking.status}; wait until it has finished`,
          );
        }
        const newest = await createJobRepository(trx).newestJobId(listing.id);
        if (newest !== null && newest !== job.id) {
          throw conflict(
            `Job ${newest} is newer than job ${id} for the same listing; publish or unpublish the property instead`,
          );
        }
        if (!registry.has(listing.portal)) {
          throw conflict(`Portal "${listing.portal}" is not available in this deployment`);
        }
        if (job.action !== 'remove' && property.status === 'archived') {
          throw conflict(
            property.delete_requested_at
              ? `Property ${property.ref_code} is archived and waiting to be deleted; to keep it, set its status to active (this cancels the deletion), then publish it`
              : `Property ${property.ref_code} is archived; set it to active before publishing it again`,
          );
        }

        const created = await queue.insertJob(listing.id, job.action);
        await queue.updateListing(listing.id, { status: 'pending' });
        return created.id;
      });
      return get(newId);
    },
  };
}

export type JobsService = ReturnType<typeof createJobsService>;
