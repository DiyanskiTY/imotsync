import type { Knex } from 'knex';
import type { NewPropertyImage, PropertyImageRow } from '../../db/types.js';

/** Photos are always listed in display order; id breaks ties. */
const DISPLAY_ORDER = [
  { column: 'sort_order', order: 'asc' },
  { column: 'id', order: 'asc' },
] as const;

/** SQL for property_images. Pass a transaction to run inside it. */
export function createImageRepository(db: Knex) {
  return {
    listForProperty(propertyId: number): Promise<PropertyImageRow[]> {
      return db('property_images')
        .where({ property_id: propertyId })
        .orderBy([...DISPLAY_ORDER]);
    },

    /** The property's photo rows, locked until the transaction ends. */
    lockForProperty(propertyId: number): Promise<PropertyImageRow[]> {
      return db('property_images')
        .where({ property_id: propertyId })
        .orderBy([...DISPLAY_ORDER])
        .forUpdate();
    },

    async countForProperty(propertyId: number): Promise<number> {
      const row = await db('property_images')
        .where({ property_id: propertyId })
        .count<{ total: number | string }>({ total: '*' })
        .first();
      return Number(row?.total ?? 0);
    },

    async maxSortOrder(propertyId: number): Promise<number | null> {
      const row = await db('property_images')
        .where({ property_id: propertyId })
        .max<{ max: number | null }>({ max: 'sort_order' })
        .first();
      return row?.max ?? null;
    },

    async insert(image: NewPropertyImage): Promise<number> {
      const [id] = await db('property_images').insert(image);
      if (id === undefined) throw new Error('INSERT into property_images returned no id');
      return id;
    },

    findByIds(ids: readonly number[]): Promise<PropertyImageRow[]> {
      return db('property_images')
        .whereIn('id', [...ids])
        .orderBy([...DISPLAY_ORDER]);
    },

    findInProperty(propertyId: number, imageId: number): Promise<PropertyImageRow | undefined> {
      return db('property_images').where({ id: imageId, property_id: propertyId }).first();
    },

    async setSortOrder(imageId: number, sortOrder: number): Promise<void> {
      await db('property_images').where({ id: imageId }).update({ sort_order: sortOrder });
    },

    async delete(imageId: number): Promise<void> {
      await db('property_images').where({ id: imageId }).delete();
    },
  };
}

export type ImageRepository = ReturnType<typeof createImageRepository>;
