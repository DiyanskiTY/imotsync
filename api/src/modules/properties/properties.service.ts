import { randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import type { NewProperty } from '../../db/types.js';
import { isDuplicateKeyError } from '../../lib/db-errors.js';
import { conflict, notFound, validationError } from '../../lib/http-error.js';
import type { FileStorage } from '../../lib/storage.js';
import type { Logger } from '../../logger.js';
import { createImageRepository } from '../images/images.repository.js';
import { deleteStoredPhotos, propertyPhotoFolder } from '../images/stored-files.js';
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

/** Listing statuses that mean the property is (or is about to be) online on that portal. */
const LIVE_LISTING_STATUSES = new Set(['pending', 'published']);

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

export function createPropertiesService(deps: { db: Knex; storage: FileStorage; logger: Logger }) {
  const { db, storage, logger } = deps;
  const properties = createPropertyRepository(db);

  async function getDetail(id: number): Promise<PropertyDetailDto> {
    const row = await properties.findById(id);
    if (!row) throw notFound(`Property ${id} does not exist`);
    const [images, listings] = await Promise.all([
      createImageRepository(db).listForProperty(id),
      properties.listingsFor([id]),
    ]);
    return toPropertyDetail(row, images, listings);
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

    async update(id: number, input: PropertyInput): Promise<PropertyDetailDto> {
      await db.transaction(async (trx) => {
        const repo = createPropertyRepository(trx);
        // Locked, so the floor check below sees the values the update is applied to.
        const current = await repo.findForUpdate(id);
        if (!current) throw notFound(`Property ${id} does not exist`);
        checkFloors(
          input.floor === undefined ? current.floor : input.floor,
          input.totalFloors === undefined ? current.total_floors : input.totalFloors,
        );
        await repo.update(id, toPropertyColumns(input));
      });
      return getDetail(id);
    },

    /**
     * Deletes the property; its photos, portal listings and jobs go with it (ON DELETE
     * CASCADE). Refused while a portal still shows it or is about to, because deleting the
     * row would also delete the record of where it is online.
     */
    async remove(id: number): Promise<void> {
      const photoUrls = await db.transaction(async (trx) => {
        const repo = createPropertyRepository(trx);
        const current = await repo.findForUpdate(id);
        if (!current) throw notFound(`Property ${id} does not exist`);

        const live = (await repo.listingsFor([id])).filter((listing) =>
          LIVE_LISTING_STATUSES.has(listing.status),
        );
        if (live.length > 0) {
          const where = live.map((listing) => `${listing.portal} (${listing.status})`).join(', ');
          throw conflict(
            `Property ${current.ref_code} is published or pending on ${where}. ` +
              'Remove it from the portals first, then delete it.',
          );
        }

        const images = await createImageRepository(trx).listForProperty(id);
        await repo.delete(id);
        return images.map((image) => image.url);
      });

      await deleteStoredPhotos(storage, logger, photoUrls, propertyPhotoFolder(id));
    },
  };
}

export type PropertiesService = ReturnType<typeof createPropertiesService>;
