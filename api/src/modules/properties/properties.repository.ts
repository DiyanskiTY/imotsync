import type { Knex } from 'knex';
import type { NewProperty, PortalListingRow, PropertyRow } from '../../db/types.js';
import {
  applyPropertyFilters,
  sortOrder,
  type PropertyFilters,
  type PropertySort,
} from './list-query.js';

/** A property row with the creator's name (LEFT JOIN users). */
export type PropertyWithCreatorRow = PropertyRow & { creator_name: string | null };

/** What the list needs: everything except the (possibly long) description. */
export type PropertyListRow = Omit<PropertyWithCreatorRow, 'description'>;

export interface CoverImage {
  url: string;
  imageCount: number;
}

export interface ListPage {
  page: number;
  pageSize: number;
  filters: PropertyFilters;
  sort: PropertySort;
}

const LIST_COLUMNS = [
  'properties.id',
  'properties.ref_code',
  'properties.title',
  'properties.type',
  'properties.deal_type',
  'properties.city',
  'properties.district',
  'properties.price',
  'properties.currency',
  'properties.area_m2',
  'properties.rooms',
  'properties.floor',
  'properties.total_floors',
  'properties.status',
  'properties.created_by',
  'properties.created_at',
  'properties.updated_at',
  'users.full_name as creator_name',
];

/** SQL for properties and the per-property data shown with them. Pass a transaction to run inside it. */
export function createPropertyRepository(db: Knex) {
  const withCreator = () => db('properties').leftJoin('users', 'users.id', 'properties.created_by');

  return {
    /**
     * Properties that are not waiting to be deleted. A deleted property can stay archived for
     * weeks while a feed still serves its removal; it no longer counts against a limit.
     */
    async countLive(): Promise<number> {
      const row = await db('properties')
        .whereNull('delete_requested_at')
        .count<{ total: number | string }[]>({ total: '*' })
        .first();
      return Number(row?.total ?? 0);
    },

    async list({ page, pageSize, filters, sort }: ListPage): Promise<{
      rows: PropertyListRow[];
      total: number;
    }> {
      const counted = await applyPropertyFilters(db, db('properties'), filters)
        .count<{ total: number | string }[]>({ total: '*' })
        .first();
      const total = Number(counted?.total ?? 0);
      if (total === 0) return { rows: [], total };

      const rows = await applyPropertyFilters(db, withCreator(), filters)
        .select<PropertyListRow[]>(LIST_COLUMNS)
        .orderBy(sortOrder(sort))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      return { rows, total };
    },

    findById(id: number): Promise<PropertyWithCreatorRow | undefined> {
      return withCreator()
        .where('properties.id', id)
        .first<PropertyWithCreatorRow | undefined>([
          'properties.*',
          'users.full_name as creator_name',
        ]);
    },

    /** The row, locked until the transaction ends (use inside db.transaction). */
    findForUpdate(id: number): Promise<PropertyRow | undefined> {
      return db('properties').where({ id }).forUpdate().first();
    },

    /**
     * First photo (by sort order) and photo count per property, for a page of properties,
     * in one query. Properties without photos are missing from the map.
     */
    async coverImages(propertyIds: readonly number[]): Promise<Map<number, CoverImage>> {
      if (propertyIds.length === 0) return new Map();
      const ranked = db('property_images')
        .select(
          'property_id',
          'url',
          db.raw('COUNT(*) OVER (PARTITION BY property_id) AS image_count'),
          db.raw(
            'ROW_NUMBER() OVER (PARTITION BY property_id ORDER BY sort_order, id) AS position',
          ),
        )
        .whereIn('property_id', [...propertyIds])
        .as('ranked');
      const rows = await db
        .select<{ property_id: number; url: string; image_count: number | string }[]>(
          'property_id',
          'url',
          'image_count',
        )
        .from(ranked)
        .where('position', 1);
      return new Map(
        rows.map((row) => [row.property_id, { url: row.url, imageCount: Number(row.image_count) }]),
      );
    },

    /** Portal listings of several properties, in one query, ordered by property and portal. */
    listingsFor(propertyIds: readonly number[]): Promise<PortalListingRow[]> {
      if (propertyIds.length === 0) return Promise.resolve([]);
      return db('portal_listings')
        .whereIn('property_id', [...propertyIds])
        .orderBy([
          { column: 'property_id', order: 'asc' },
          { column: 'portal', order: 'asc' },
        ]);
    },

    async insert(row: NewProperty): Promise<number> {
      const [id] = await db('properties').insert(row);
      if (id === undefined) throw new Error('INSERT into properties returned no id');
      return id;
    },

    async update(id: number, changes: Partial<NewProperty>): Promise<void> {
      await db('properties')
        .where({ id })
        .update({ ...changes, updated_at: db.fn.now() });
    },

    /** Marks the property as changed (photos added, removed or reordered). */
    async touch(id: number): Promise<void> {
      await db('properties').where({ id }).update({ updated_at: db.fn.now() });
    },

    async delete(id: number): Promise<void> {
      await db('properties').where({ id }).delete();
    },
  };
}

export type PropertyRepository = ReturnType<typeof createPropertyRepository>;
