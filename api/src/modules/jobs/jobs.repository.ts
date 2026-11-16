import type { Knex } from 'knex';
import type { JobAction, JobRow, JobStatus, PortalListingStatus } from '../../db/types.js';

/** A job with its listing and property, as the job log shows it. */
export type JobWithContextRow = JobRow & {
  listing_portal: string;
  listing_status: PortalListingStatus;
  property_id: number | null;
  property_ref_code: string | null;
  property_title: string | null;
};

/** Sort keys of GET /jobs and their columns. */
export const JOB_SORT_COLUMNS = {
  createdAt: 'jobs.created_at',
  updatedAt: 'jobs.updated_at',
  runAfter: 'jobs.run_after',
  finishedAt: 'jobs.finished_at',
  id: 'jobs.id',
} as const;

export type JobSortField = keyof typeof JOB_SORT_COLUMNS;

export interface JobSort {
  field: JobSortField;
  direction: 'asc' | 'desc';
}

export interface JobFilters {
  status?: JobStatus[];
  action?: JobAction[];
  portal?: string[];
  propertyId?: number;
}

const CONTEXT_COLUMNS = [
  'jobs.*',
  'portal_listings.portal as listing_portal',
  'portal_listings.status as listing_status',
  'properties.id as property_id',
  'properties.ref_code as property_ref_code',
  'properties.title as property_title',
];

function applyFilters(query: Knex.QueryBuilder, filters: JobFilters): Knex.QueryBuilder {
  let builder = query;
  if (filters.status?.length) builder = builder.whereIn('jobs.status', filters.status);
  if (filters.action?.length) builder = builder.whereIn('jobs.action', filters.action);
  if (filters.portal?.length) builder = builder.whereIn('portal_listings.portal', filters.portal);
  if (filters.propertyId !== undefined) {
    builder = builder.where('portal_listings.property_id', filters.propertyId);
  }
  return builder;
}

/** SQL for the job log. Pass a transaction to run inside it. */
export function createJobRepository(db: Knex) {
  // Untyped builder: Knex's table typings cannot express this three-table join.
  const withContext = (): Knex.QueryBuilder =>
    db
      .queryBuilder()
      .from('jobs')
      .join('portal_listings', 'portal_listings.id', 'jobs.portal_listing_id')
      .leftJoin('properties', 'properties.id', 'portal_listings.property_id');

  return {
    async list(options: {
      page: number;
      pageSize: number;
      filters: JobFilters;
      sort: JobSort;
    }): Promise<{ rows: JobWithContextRow[]; total: number }> {
      const { page, pageSize, filters, sort } = options;
      const counted = await applyFilters(withContext(), filters)
        .count<{ total: number | string }[]>({ total: '*' })
        .first();
      const total = Number(counted?.total ?? 0);
      if (total === 0) return { rows: [], total };

      const rows = await applyFilters(withContext(), filters)
        .select<JobWithContextRow[]>(CONTEXT_COLUMNS)
        .orderBy([
          { column: JOB_SORT_COLUMNS[sort.field], order: sort.direction },
          { column: 'jobs.id', order: sort.direction },
        ])
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      return { rows, total };
    },

    findById(id: number): Promise<JobWithContextRow | undefined> {
      return withContext()
        .where('jobs.id', id)
        .first<JobWithContextRow | undefined>(CONTEXT_COLUMNS);
    },

    /** The jobs with these ids, oldest first. */
    async findByIds(ids: readonly number[]): Promise<JobWithContextRow[]> {
      if (ids.length === 0) return [];
      return withContext()
        .whereIn('jobs.id', [...ids])
        .orderBy('jobs.id', 'asc')
        .select<JobWithContextRow[]>(CONTEXT_COLUMNS);
    },

    /** The id of the listing's newest job, or null. */
    async newestJobId(listingId: number): Promise<number | null> {
      const row = await db('jobs')
        .where({ portal_listing_id: listingId })
        .max<{ id: number | null }>({ id: 'id' })
        .first();
      return row?.id ?? null;
    },
  };
}

export type JobRepository = ReturnType<typeof createJobRepository>;
