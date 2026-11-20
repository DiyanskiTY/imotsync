import { randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import type { NewProperty, PropertyRow } from '../../db/types.js';
import { enqueueUpdatesForProperty } from '../../jobs/enqueue.js';
import {
  deletePropertyRow,
  deletionBlocker,
  describeScheduledDeletion,
  requestPropertyDeletion,
} from '../../jobs/property-deletion.js';
import { createQueueRepository } from '../../jobs/queue.repository.js';
import { queueTransaction } from '../../jobs/transaction.js';
import { isDuplicateKeyError } from '../../lib/db-errors.js';
import { conflict, notFound, validationError } from '../../lib/http-error.js';
import { createImageRepository } from '../images/images.repository.js';
import { createJobRepository } from '../jobs/jobs.repository.js';
import { DEFAULT_PAGE_SIZE, DEFAULT_SORT, parseSort, type PropertySort } from './list-query.js';
import {
  toPropertyColumns,
  toPropertyDetail,
  toPropertySummary,
  type PaginationMeta,
  type PropertyDetailDto,
  type PropertyInput,
  type PropertySummaryDto,
} from './properties.mappers.js';
import { createPropertyRepository } from './properties.repository.js';
import { generatedRefCode, type ListPropertiesQuery } from './properties.validators.js';

const FALLBACK_SORT: PropertySort = { field: 'updatedAt', direction: 'desc' };

/** Columns portals show. A change to any of them queues update jobs; status alone does not. */
const PORTAL_CONTENT_COLUMNS = [
  'title',
  'type',
  'deal_type',
  'city',
  'district',
  'price',
  'currency',
  'area_m2',
  'rooms',
  'floor',
  'total_floors',
  'description',
] as const satisfies (keyof NewProperty & keyof PropertyRow)[];

/** Whether applying `changes` to `current` changes anything portals show. */
export function changesPortalContent(current: PropertyRow, changes: Partial<NewProperty>): boolean {
  return PORTAL_CONTENT_COLUMNS.some(
    (column) => changes[column] !== undefined && changes[column] !== current[column],
  );
}

export type CreatePropertyInput = PropertyInput &
  Required<Pick<PropertyInput, 'type' | 'dealType' | 'city'>>;

export interface PropertyList {
  data: PropertySummaryDto[];
  meta: PaginationMeta;
}

/**
 * Placeholder for the moment between the INSERT and the UPDATE that sets the generated
 * "IS-00042" code. "~" is not allowed in chosen codes, so it can never collide with one.
 */
const temporaryRefCode = () => `~${randomBytes(12).toString('hex')}`;

/** floor <= totalFloors when both are known. */
function checkFloors(floor: number | null | undefined, totalFloors: number | null | undefined) {
  if (typeof floor === 'number' && typeof totalFloors === 'number' && floor > totalFloors) {
    throw validationError([
      { field: 'floor', message: `must not be greater than totalFloors (${totalFloors})` },
    ]);
  }
}

/** What DELETE did: deleted now, or archived for the worker to delete later. */
export type PropertyRemoval = 'deleted' | 'deletion_scheduled';

export interface PropertiesServiceDeps {
  db: Knex;
  /**
   * Days each feed portal keeps serving a removed listing (PortalRegistry.removedRetentionDays):
   * a property whose removal a feed still serves is not deleted before that. Default: none.
   */
  removedRetentionDays?: ReadonlyMap<string, number>;
  /**
   * The most properties (not waiting to be deleted) the database may hold before create
   * answers 409; the public demo sets one, so the shared database cannot be filled. Default
   * (null or left out): no limit.
   */
  maxProperties?: number | null;
}

export function createPropertiesService(deps: PropertiesServiceDeps) {
  const { db } = deps;
  const removedRetentionDays = deps.removedRetentionDays ?? new Map<string, number>();
  const properties = createPropertyRepository(db);

  async function getDetail(id: number): Promise<PropertyDetailDto> {
    const row = await properties.findById(id);
    if (!row) throw notFound(`Property ${id} does not exist`);
    const [images, listings] = await Promise.all([
      createImageRepository(db).listForProperty(id),
      properties.listingsFor([id]),
    ]);
    const lastSent = await createJobRepository(db).lastSentFor(listings.map((l) => l.id));
    const deletion = row.delete_requested_at
      ? describeScheduledDeletion(listings, { removedRetentionDays })
      : null;
    return toPropertyDetail({ row, images, listings, lastSent, deletion });
  }

  return {
    getDetail,

    async list(query: ListPropertiesQuery): Promise<PropertyList> {
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
      const sort = parseSort(query.sort ?? DEFAULT_SORT) ?? FALLBACK_SORT;
      const { rows, total } = await properties.list({
        page,
        pageSize,
        sort,
        filters: {
          q: query.q,
          status: query.status,
          type: query.type,
          dealType: query.dealType,
          city: query.city,
          priceMin: query.priceMin,
          priceMax: query.priceMax,
          portal: query.portal,
          portalStatus: query.portalStatus,
        },
      });

      // Two batched queries for the whole page, not two per property.
      const ids = rows.map((row) => row.id);
      const [covers, listings] = await Promise.all([
        properties.coverImages(ids),
        properties.listingsFor(ids),
      ]);
      const listingsByProperty = Map.groupBy(listings, (listing) => listing.property_id);

      return {
        data: rows.map((row) =>
          toPropertySummary(row, covers.get(row.id), listingsByProperty.get(row.id) ?? []),
        ),
        meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
      };
    },

    async create(input: CreatePropertyInput, createdBy: number): Promise<PropertyDetailDto> {
      checkFloors(input.floor, input.totalFloors);
      const maxProperties = deps.maxProperties ?? null;
      // A soft cap: two creates at the same moment may both pass, which is harmless here.
      if (maxProperties !== null && (await properties.countLive()) >= maxProperties) {
        throw conflict(
          `This demo holds at most ${maxProperties} properties. Delete one first; the demo data is reset every night.`,
        );
      }
      const chosenRefCode = input.refCode ?? null;

      let id: number;
      try {
        id = await db.transaction(async (trx) => {
          const repo = createPropertyRepository(trx);
          const row: NewProperty = {
            ...toPropertyColumns(input),
            type: input.type,
            deal_type: input.dealType,
            city: input.city,
            ref_code: chosenRefCode ?? temporaryRefCode(),
            created_by: createdBy,
          };
          const newId = await repo.insert(row);
          if (chosenRefCode === null) {
            // Same transaction: nobody ever sees the placeholder, and the code depends
            // only on the id, so concurrent creates cannot race for the same code.
            await repo.update(newId, { ref_code: generatedRefCode(newId) });
          }
          return newId;
        });
      } catch (error) {
        if (chosenRefCode !== null && isDuplicateKeyError(error)) {
          throw conflict(`Reference code ${chosenRefCode} is already in use`);
        }
        throw error;
      }
      return getDetail(id);
    },

    /**
     * Applies a partial update. When something portals show really changes, the same
     * transaction queues an update job for every listing that is on its portal (published,
     * or in error while still online; pending ones follow the merge rules), so the portals
     * get the new data. A property that leaves 'archived' is no longer waiting to be deleted:
     * delete_requested_at is cleared, which cancels a requested deletion.
     */
    async update(id: number, input: PropertyInput): Promise<PropertyDetailDto> {
      await queueTransaction(db, async (trx) => {
        const repo = createPropertyRepository(trx);
        // Locked, so the floor check below sees the values the update is applied to.
        const current = await repo.findForUpdate(id);
        if (!current) throw notFound(`Property ${id} does not exist`);
        checkFloors(
          input.floor === undefined ? current.floor : input.floor,
          input.totalFloors === undefined ? current.total_floors : input.totalFloors,
        );
        const columns = toPropertyColumns(input);
        const leavesArchived =
          current.status === 'archived' &&
          columns.status !== undefined &&
          columns.status !== 'archived';
        await repo.update(id, leavesArchived ? { ...columns, delete_requested_at: null } : columns);
        if (changesPortalContent(current, columns)) await enqueueUpdatesForProperty(trx, id);
      });
      return getDetail(id);
    },

    /**
     * Deletes the property; its photos, portal listings and jobs go with it (ON DELETE
     * CASCADE). The photo files are deleted later by the worker's photo sweep, once no stored
     * feed payload links to them.
     * - Refused (409) while a portal shows it or is about to (a listing that is pending,
     *   published, or in error but still online): deleting the row would also delete the
     *   record of where it is online.
     * - When nothing is online but a feed still serves the removal of one of its listings (a
     *   Bazar.bg item kept as out of stock for BAZAR_REMOVED_RETENTION_DAYS), the property is
     *   archived and marked for deletion instead ('deletion_scheduled'): the worker deletes
     *   it once that period has passed, so the portal sees the removal first.
     */
    async remove(id: number): Promise<PropertyRemoval> {
      // Like the queue's writers: locks the property, then its listings.
      return queueTransaction(db, async (trx) => {
        const repo = createPropertyRepository(trx);
        const current = await repo.findForUpdate(id);
        if (!current) throw notFound(`Property ${id} does not exist`);

        const listings = await createQueueRepository(trx).lockListingsOfProperty(id);
        const blocker = deletionBlocker(listings, { removedRetentionDays });
        if (blocker?.kind === 'live') {
          const where = blocker.listings
            .map((listing) => `${listing.portal} (${listing.status})`)
            .join(', ');
          throw conflict(
            `Property ${current.ref_code} is online or about to be on ${where}. ` +
              `Unpublish it first (POST /api/properties/${id}/unpublish), or use bulk delete ` +
              '(POST /api/properties/bulk/delete), which removes it from the portals and then deletes it.',
          );
        }
        if (blocker?.kind === 'tombstone') {
          await requestPropertyDeletion(trx, current);
          return 'deletion_scheduled';
        }
        await deletePropertyRow(trx, id);
        return 'deleted';
      });
    },
  };
}

export type PropertiesService = ReturnType<typeof createPropertiesService>;
