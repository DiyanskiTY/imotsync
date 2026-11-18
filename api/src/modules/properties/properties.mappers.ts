import type {
  DealType,
  NewProperty,
  PortalListingRow,
  PortalListingStatus,
  PropertyImageRow,
  PropertyStatus,
  PropertyType,
} from '../../db/types.js';
import type { ScheduledDeletion } from '../../jobs/property-deletion.js';
import { toImageDto, type PropertyImageDto } from '../images/images.mappers.js';
import type {
  CoverImage,
  PropertyListRow,
  PropertyWithCreatorRow,
} from './properties.repository.js';

/*
 * The one place where property rows (snake_case, Date, DECIMAL as number) become API
 * objects (camelCase, ISO-8601 UTC strings), and API input becomes column values.
 */

/** A listing's state on one portal, as shown in the list. */
export interface PortalStatusDto {
  portal: string;
  status: PortalListingStatus;
  lastError: string | null;
  publishedAt: string | null;
}

/** A listing with everything the detail view shows. */
export interface PortalListingDto extends PortalStatusDto {
  id: number;
  externalId: string | null;
  /** When it was last sent to the portal (its newest successful publish or update), or null. */
  lastSentAt: string | null;
  updatedAt: string;
}

export interface CreatedByDto {
  id: number;
  fullName: string;
}

export interface PropertySummaryDto {
  id: number;
  refCode: string;
  title: string | null;
  type: PropertyType;
  dealType: DealType;
  city: string;
  district: string | null;
  price: number | null;
  currency: string;
  areaM2: number | null;
  rooms: number | null;
  floor: number | null;
  totalFloors: number | null;
  status: PropertyStatus;
  coverImageUrl: string | null;
  imageCount: number;
  portals: PortalStatusDto[];
  createdBy: CreatedByDto | null;
  createdAt: string;
  updatedAt: string;
}

/** A requested deletion that has not happened yet (see describeScheduledDeletion). */
export interface DeletionDto {
  requestedAt: string;
  state: ScheduledDeletion['state'];
  portals: string[];
  deletesAfter: string | null;
}

export interface PropertyDetailDto extends Omit<PropertySummaryDto, 'portals'> {
  description: string | null;
  images: PropertyImageDto[];
  portals: PortalListingDto[];
  deletion: DeletionDto | null;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Validated create/update input; null clears a nullable field. */
export interface PropertyInput {
  refCode?: string | null;
  title?: string | null;
  type?: PropertyType;
  dealType?: DealType;
  city?: string;
  district?: string | null;
  price?: number | null;
  currency?: string;
  areaM2?: number | null;
  rooms?: number | null;
  floor?: number | null;
  totalFloors?: number | null;
  description?: string | null;
  status?: PropertyStatus;
}

const iso = (date: Date) => date.toISOString();
const isoOrNull = (date: Date | null) => (date ? date.toISOString() : null);

function toPortalStatus(row: PortalListingRow): PortalStatusDto {
  return {
    portal: row.portal,
    status: row.status,
    lastError: row.last_error,
    publishedAt: isoOrNull(row.published_at),
  };
}

/** `lastSent`: listing id → when it was last sent (jobs repository's lastSentFor). */
export function toPortalListing(
  row: PortalListingRow,
  lastSent: ReadonlyMap<number, Date>,
): PortalListingDto {
  return {
    id: row.id,
    portal: row.portal,
    status: row.status,
    externalId: row.external_id,
    lastError: row.last_error,
    publishedAt: isoOrNull(row.published_at),
    lastSentAt: isoOrNull(lastSent.get(row.id) ?? null),
    updatedAt: iso(row.updated_at),
  };
}

function baseFields(row: PropertyListRow) {
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
    status: row.status,
  };
}

function createdBy(row: PropertyListRow): CreatedByDto | null {
  return row.created_by !== null && row.creator_name !== null
    ? { id: row.created_by, fullName: row.creator_name }
    : null;
}

export function toPropertySummary(
  row: PropertyListRow,
  cover: CoverImage | undefined,
  listings: readonly PortalListingRow[],
): PropertySummaryDto {
  return {
    ...baseFields(row),
    coverImageUrl: cover?.url ?? null,
    imageCount: cover?.imageCount ?? 0,
    portals: listings.map(toPortalStatus),
    createdBy: createdBy(row),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export interface PropertyDetailSource {
  row: PropertyWithCreatorRow;
  /** In display order (sort_order, id). */
  images: readonly PropertyImageRow[];
  listings: readonly PortalListingRow[];
  /** Listing id → when it was last sent (jobs repository's lastSentFor). */
  lastSent: ReadonlyMap<number, Date>;
  /** What a requested deletion waits for; shown only while one is requested. */
  deletion: ScheduledDeletion | null;
}

export function toPropertyDetail({
  row,
  images,
  listings,
  lastSent,
  deletion: scheduled,
}: PropertyDetailSource): PropertyDetailDto {
  return {
    ...baseFields(row),
    coverImageUrl: images[0]?.url ?? null,
    imageCount: images.length,
    portals: listings.map((listing) => toPortalListing(listing, lastSent)),
    createdBy: createdBy(row),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    description: row.description,
    images: images.map(toImageDto),
    deletion:
      row.delete_requested_at && scheduled
        ? {
            requestedAt: iso(row.delete_requested_at),
            state: scheduled.state,
            portals: scheduled.portals,
            deletesAfter: isoOrNull(scheduled.deletesAfter),
          }
        : null,
  };
}

/**
 * Column values for the fields present in the input. Absent (undefined) fields are left
 * out, so a partial update does not touch them; null clears a column. refCode is handled
 * by the service, because it is never updated.
 */
export function toPropertyColumns(input: PropertyInput): Partial<NewProperty> {
  const columns: Partial<NewProperty> = {
    title: input.title,
    type: input.type,
    deal_type: input.dealType,
    city: input.city,
    district: input.district,
    price: input.price,
    currency: input.currency,
    area_m2: input.areaM2,
    rooms: input.rooms,
    floor: input.floor,
    total_floors: input.totalFloors,
    description: input.description,
    status: input.status,
  };
  for (const key of Object.keys(columns) as (keyof NewProperty)[]) {
    if (columns[key] === undefined) Reflect.deleteProperty(columns, key);
  }
  return columns;
}
