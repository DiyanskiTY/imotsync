import type { Knex } from 'knex';
import type { PortalListingRow, PropertyImageRow, PropertyRow } from '../db/types.js';
import type { PortalListingInfo, PortalProperty } from './types.js';

/*
 * Builds the portal-independent views adapters receive (src/portals/types.ts) from database
 * rows. Photo URLs become absolute (PUBLIC_BASE_URL + /uploads/...), because portals
 * download the photos themselves.
 */

/** A property row with its creator, the broker portals show. */
export type PropertyWithBrokerRow = PropertyRow & {
  broker_name: string | null;
  broker_email: string | null;
};

/** "/uploads/a.jpg" -> "https://imotsync.example/uploads/a.jpg"; absolute URLs stay as they are. */
export function absoluteUrl(publicBaseUrl: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${publicBaseUrl.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

/** `images` in display order (sort_order, id). */
export function toPortalProperty(
  row: PropertyWithBrokerRow,
  images: readonly PropertyImageRow[],
  publicBaseUrl: string,
): PortalProperty {
  const broker =
    row.created_by !== null && row.broker_name !== null && row.broker_email !== null
      ? { id: row.created_by, fullName: row.broker_name, email: row.broker_email }
      : null;
  return {
    id: row.id,
    refCode: row.ref_code,
    title: row.title,
    type: row.type,
    dealType: row.deal_type,
    city: row.city,
    district: row.district,
    price: row.price,
    currency: row.currency,
    areaM2: row.area_m2,
    rooms: row.rooms,
    floor: row.floor,
    totalFloors: row.total_floors,
    description: row.description,
    status: row.status,
    broker,
    updatedAt: row.updated_at,
    images: images.map((image, index) => ({
      url: absoluteUrl(publicBaseUrl, image.url),
      width: image.width,
      height: image.height,
      sizeBytes: image.size_bytes,
      sortOrder: index,
    })),
  };
}

export function toPortalListingInfo(row: PortalListingRow): PortalListingInfo {
  return {
    id: row.id,
    portal: row.portal,
    status: row.status,
    externalId: row.external_id,
    publishedAt: row.published_at,
    payload: row.payload,
    payloadUpdatedAt: row.payload_updated_at,
  };
}

const IMAGE_ORDER = [
  { column: 'property_id', order: 'asc' },
  { column: 'sort_order', order: 'asc' },
  { column: 'id', order: 'asc' },
] as const;

/**
 * Several properties as adapters see them, in two queries. Missing ids are left out of the
 * map. Pass a transaction to read inside it.
 */
export async function loadPortalProperties(
  db: Knex,
  propertyIds: readonly number[],
  options: { publicBaseUrl: string },
): Promise<Map<number, PortalProperty>> {
  if (propertyIds.length === 0) return new Map();
  const ids = [...new Set(propertyIds)];
  const [rows, images] = await Promise.all([
    db('properties')
      .leftJoin('users', 'users.id', 'properties.created_by')
      .whereIn('properties.id', ids)
      .select<PropertyWithBrokerRow[]>(
        'properties.*',
        'users.full_name as broker_name',
        'users.email as broker_email',
      ),
    db('property_images')
      .whereIn('property_id', ids)
      .orderBy([...IMAGE_ORDER]),
  ]);
  const imagesByProperty = Map.groupBy(images, (image) => image.property_id);
  return new Map(
    rows.map((row) => [
      row.id,
      toPortalProperty(row, imagesByProperty.get(row.id) ?? [], options.publicBaseUrl),
    ]),
  );
}

/** One property as adapters see it, or null if it does not exist. */
export async function loadPortalProperty(
  db: Knex,
  propertyId: number,
  options: { publicBaseUrl: string },
): Promise<PortalProperty | null> {
  return (await loadPortalProperties(db, [propertyId], options)).get(propertyId) ?? null;
}
